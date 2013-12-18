/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const InputStreamPump = CC(
        "@mozilla.org/network/input-stream-pump;1", "nsIInputStreamPump", "init"),
      AsyncStreamCopier = CC(
        "@mozilla.org/network/async-stream-copier;1", "nsIAsyncStreamCopier", "init"),
      ScriptableInputStream = CC(
        "@mozilla.org/scriptableinputstream;1", "nsIScriptableInputStream", "init"),
      BinaryInputStream = CC(
        "@mozilla.org/binaryinputstream;1", "nsIBinaryInputStream", "setInputStream"),
      StringInputStream = CC(
        '@mozilla.org/io/string-input-stream;1', 'nsIStringInputStream'),
      ArrayBufferInputStream = CC(
        '@mozilla.org/io/arraybuffer-input-stream;1', 'nsIArrayBufferInputStream'),
      MultiplexInputStream = CC(
        '@mozilla.org/io/multiplex-input-stream;1', 'nsIMultiplexInputStream');
const TCPServerSocket = CC(
        "@mozilla.org/tcp-server-socket;1", "nsITCPServerSocketInternal", "init");

const kCONNECTING = 'connecting';
const kOPEN = 'open';
const kCLOSING = 'closing';
const kCLOSED = 'closed';
const kRESUME_ERROR = 'Calling resume() on a connection that was not suspended.';

const BUFFER_SIZE = 65536;
const NETWORK_STATS_THRESHOLD = 65536;

// XXX we have no TCPError implementation right now because it's really hard to
// do on b2g18.  On mozilla-central we want a proper TCPError that ideally
// sub-classes DOMError.  Bug 867872 has been filed to implement this and
// contains a documented TCPError.webidl that maps all the error codes we use in
// this file to slightly more readable explanations.
function createTCPError(aWindow, aErrorName, aErrorType) {
  return new (aWindow ? aWindow.DOMError : DOMError)(aErrorName);
}


/*
 * Debug logging function
 */

let debug = true;
function LOG(msg) {
  if (debug)
    dump("TCPSocket: " + msg + "\n");
}

/*
 * nsITCPSocketEvent object
 */

function TCPSocketEvent(type, sock, data) {
  this._type = type;
  this._target = sock;
  this._data = data;
}

TCPSocketEvent.prototype = {
  __exposedProps__: {
    type: 'r',
    target: 'r',
    data: 'r'
  },
  get type() {
    return this._type;
  },
  get target() {
    return this._target;
  },
  get data() {
    return this._data;
  }
}

/*
 * nsIDOMTCPSocket object
 */

function TCPSocket() {
  this._readyState = kCLOSED;

  this._onopen = null;
  this._ondrain = null;
  this._ondata = null;
  this._onerror = null;
  this._onclose = null;

  this._binaryType = "string";

  this._host = "";
  this._port = 0;
  this._ssl = false;

  this.useWin = null;
}

TCPSocket.prototype = {
  __exposedProps__: {
    open: 'r',
    host: 'r',
    port: 'r',
    ssl: 'r',
    bufferedAmount: 'r',
    suspend: 'r',
    resume: 'r',
    close: 'r',
    send: 'r',
    readyState: 'r',
    binaryType: 'r',
    listen: 'r',
    onopen: 'rw',
    ondrain: 'rw',
    ondata: 'rw',
    onerror: 'rw',
    onclose: 'rw'
  },
  // The binary type, "string" or "arraybuffer"
  _binaryType: null,

  // Internal
  _hasPrivileges: null,

  // Raw socket streams
  _transport: null,
  _socketInputStream: null,
  _socketOutputStream: null,

  // Input stream machinery
  _inputStreamPump: null,
  _inputStreamScriptable: null,
  _inputStreamBinary: null,

  // Output stream machinery
  _multiplexStream: null,
  _multiplexStreamCopier: null,

  _asyncCopierActive: false,
  _waitingForDrain: false,
  _suspendCount: 0,

  // Reported parent process buffer
  _bufferedAmount: 0,

  // IPC socket actor
  _socketBridge: null,

  // StartTLS
  _waitingForStartTLS: false,
  _pendingDataAfterStartTLS: [],

  // Used to notify when update bufferedAmount is updated.
  _onUpdateBufferedAmount: null,
  _trackingNumber: 0,

#ifdef MOZ_WIDGET_GONK
  // Network statistics (Gonk-specific feature)
  _txBytes: 0,
  _rxBytes: 0,
  _appId: Ci.nsIScriptSecurityManager.NO_APP_ID,
  _activeNetwork: null,
#endif

  // Public accessors.
  get readyState() {
    return this._readyState;
  },
  get binaryType() {
    return this._binaryType;
  },
  get host() {
    return this._host;
  },
  get port() {
    return this._port;
  },
  get ssl() {
    return this._ssl;
  },
  get bufferedAmount() {
    if (this._inChild) {
      return this._bufferedAmount;
    }
    return this._multiplexStream.available();
  },
  get onopen() {
    return this._onopen;
  },
  set onopen(f) {
    this._onopen = f;
  },
  get ondrain() {
    return this._ondrain;
  },
  set ondrain(f) {
    this._ondrain = f;
  },
  get ondata() {
    return this._ondata;
  },
  set ondata(f) {
    this._ondata = f;
  },
  get onerror() {
    return this._onerror;
  },
  set onerror(f) {
    this._onerror = f;
  },
  get onclose() {
    return this._onclose;
  },
  set onclose(f) {
    this._onclose = f;
  },

  _activateTLS: function() {
    let securityInfo = this._transport.securityInfo
          .QueryInterface(Ci.nsISSLSocketControl);
    securityInfo.StartTLS();
  },

  // Helper methods.
  _createTransport: function ts_createTransport(host, port, sslMode) {
    let options;
    if (sslMode === 'ssl') {
      options = ['ssl'];
    } else {
      options = ['starttls'];
    }
    return Cc["@mozilla.org/network/socket-transport-service;1"]
             .getService(Ci.nsISocketTransportService)
             .createTransport(options, 1, host, port, null);
  },

  _sendBufferedAmount: function ts_sendBufferedAmount() {
    if (this._onUpdateBufferedAmount) {
      this._onUpdateBufferedAmount(this.bufferedAmount, this._trackingNumber);
    }
  },

  _ensureCopying: function ts_ensureCopying() {
    let self = this;
    if (this._asyncCopierActive) {
      return;
    }
    this._asyncCopierActive = true;
    this._multiplexStreamCopier.asyncCopy({
      onStartRequest: function ts_output_onStartRequest() {
      },
      onStopRequest: function ts_output_onStopRequest(request, context, status) {
        self._asyncCopierActive = false;
        self._multiplexStream.removeStream(0);
        self._sendBufferedAmount();

        if (!Components.isSuccessCode(status)) {
          // Note that we can/will get an error here as well as in the
          // onStopRequest for inbound data.
          self._maybeReportErrorAndCloseIfOpen(status);
          return;
        }

        if (self._multiplexStream.count) {
          self._ensureCopying();
        } else {
          // If we are waiting for initiating starttls, we can begin to
          // activate tls now.
          if (self._waitingForStartTLS && self._readyState == kOPEN) {
            self._activateTLS();
            self._waitingForStartTLS = false;
            // If we have pending data, we should send them, or fire
            // a drain event if we are waiting for it.
            if (self._pendingDataAfterStartTLS.length > 0) {
              while (self._pendingDataAfterStartTLS.length)
                self._multiplexStream.appendStream(self._pendingDataAfterStartTLS.shift());
              self._ensureCopying();
              return;
            }
          }

          // If we have a callback to update bufferedAmount, we let child to
          // decide whether ondrain should be dispatched.
          if (self._waitingForDrain && !self._onUpdateBufferedAmount) {
            self._waitingForDrain = false;
            self.callListener("drain");
          }
          if (self._readyState === kCLOSING) {
            self._socketOutputStream.close();
            self._readyState = kCLOSED;
            self.callListener("close");
          }
        }
      }
    }, null);
  },
  
  _initStream: function ts_initStream(binaryType) {
    this._binaryType = binaryType;
    this._socketInputStream = this._transport.openInputStream(0, 0, 0);
    this._socketOutputStream = this._transport.openOutputStream(
      Ci.nsITransport.OPEN_UNBUFFERED, 0, 0);

    // If the other side is not listening, we will
    // get an onInputStreamReady callback where available
    // raises to indicate the connection was refused.
    this._socketInputStream.asyncWait(
      this, this._socketInputStream.WAIT_CLOSURE_ONLY, 0, Services.tm.currentThread);

    if (this._binaryType === "arraybuffer") {
      this._inputStreamBinary = new BinaryInputStream(this._socketInputStream);
    } else {
      this._inputStreamScriptable = new ScriptableInputStream(this._socketInputStream);
    }

    this._multiplexStream = new MultiplexInputStream();

    this._multiplexStreamCopier = new AsyncStreamCopier(
      this._multiplexStream,
      this._socketOutputStream,
      // (nsSocketTransport uses gSocketTransportService)
      Cc["@mozilla.org/network/socket-transport-service;1"]
        .getService(Ci.nsIEventTarget),
      /* source buffered */ true, /* sink buffered */ false,
      BUFFER_SIZE, /* close source*/ false, /* close sink */ false);
  },

#ifdef MOZ_WIDGET_GONK
  // Helper method for collecting network statistics.
  // Note this method is Gonk-specific.
  _saveNetworkStats: function ts_saveNetworkStats(enforce) {
    if (this._txBytes <= 0 && this._rxBytes <= 0) {
      // There is no traffic at all. No need to save statistics.
      return;
    }

    // If "enforce" is false, the traffic amount is saved to NetworkStatsServiceProxy
    // only when the total amount exceeds the predefined threshold value.
    // The purpose is to avoid too much overhead for collecting statistics.
    let totalBytes = this._txBytes + this._rxBytes;
    if (!enforce && totalBytes < NETWORK_STATS_THRESHOLD) {
      return;
    }

    let nssProxy = Cc["@mozilla.org/networkstatsServiceProxy;1"]
                     .getService(Ci.nsINetworkStatsServiceProxy);
    if (!nssProxy) {
      LOG("Error: Ci.nsINetworkStatsServiceProxy service is not available.");
      return;
    }
    nssProxy.saveAppStats(this._appId, this._activeNetwork, Date.now(),
                          this._rxBytes, this._txBytes);

    // Reset the counters once the statistics is saved to NetworkStatsServiceProxy.
    this._txBytes = this._rxBytes = 0;
  },
  // End of helper method for network statistics.
#endif

  callListener: function ts_callListener(type, data) {
    LOG("+++DBG++:TCPSocket.js:callListener()-S");
    if (!this["on" + type])
      return;

    this["on" + type].call(null, new TCPSocketEvent(type, this, data || ""));
    LOG("+++DBG++:TCPSocket.js:callListener()-E");
  },

  /* nsITCPSocketInternal methods */
  callListenerError: function ts_callListenerError(type, name) {
    // XXX we're not really using TCPError at this time, so there's only a name
    // attribute to pass.
    LOG("+++DBG++:TCPSocket.js:callListenerError()");
    this.callListener(type, createTCPError(this.useWin, name));
  },

  callListenerData: function ts_callListenerString(type, data) {
    LOG("+++DBG++:TCPSocket.js:callListenerData()-S");
    this.callListener(type, data);
    LOG("+++DBG++:TCPSocket.js:callListenerData()-E");
  },

  callListenerArrayBuffer: function ts_callListenerArrayBuffer(type, data) {
    LOG("+++DBG++:TCPSocket.js:callListenerData()-S");
    this.callListener(type, data);
    LOG("+++DBG++:TCPSocket.js:callListenerData()-E");
  },

  callListenerVoid: function ts_callListenerVoid(type) {
    LOG("+++DBG++:TCPSocket.js:callListenerVoid()-S");
    this.callListener(type);
    LOG("+++DBG++:TCPSocket.js:callListenerVoid()-E");
  },

  /**
   * This method is expected to be called by TCPSocketChild to update child's
   * readyState.
   */
  updateReadyState: function ts_updateReadyState(readyState) {
    LOG("+++DBG++:TCPSocket.js:updateReadyState()-S");
    if (!this._inChild) {
      LOG("Calling updateReadyState in parent, which should only be called " +
          "in child");
      LOG("+++DBG++:TCPSocket.js:updateReadyState()-E_return");
      return;
    }
    this._readyState = readyState;
    LOG("+++DBG++:TCPSocket.js:updateReadyState()-E");
  },

  updateBufferedAmount: function ts_updateBufferedAmount(bufferedAmount, trackingNumber) {
    LOG("+++DBG++:TCPSocket.js:updateBufferedAmount()-S");
    if (trackingNumber != this._trackingNumber) {
      LOG("updateBufferedAmount is called but trackingNumber is not matched " +
          "parent's trackingNumber: " + trackingNumber + ", child's trackingNumber: " +
          this._trackingNumber);
      LOG("+++DBG++:TCPSocket.js:updateBufferedAmount()-E_return");
      return;
    }
    this._bufferedAmount = bufferedAmount;
    if (bufferedAmount == 0) {
      if (this._waitingForDrain) {
        this._waitingForDrain = false;
        this.callListener("drain");
      }
    } else {
      LOG("bufferedAmount is updated but haven't reaches zero. bufferedAmount: " +
          bufferedAmount);
    }
    LOG("+++DBG++:TCPSocket.js:updateBufferedAmount()-E");
  },

  createAcceptedParent: function ts_createAcceptedParent(transport, binaryType) {
    LOG("+++DBG++:TCPSocket.js:createAcceptedParent()-S");
    let that = new TCPSocket();
    that._transport = transport;
    that._initStream(binaryType);

    // ReadyState is kOpen since accepted transport stream has already been connected
    that._readyState = kOPEN;
    that._inputStreamPump = new InputStreamPump(that._socketInputStream, -1, -1, 0, 0, false);
    that._inputStreamPump.asyncRead(that, null);

    LOG("+++DBG++:TCPSocket.js:createAcceptedParent()-E");
    return that;
  },

  createAcceptedChild: function ts_createAcceptedChild(socketChild, binaryType, windowObject) {
    LOG("+++DBG++:TCPSocket.js:createAcceptedChild()-S");
    let that = new TCPSocket();

    that._binaryType = binaryType;
    that._inChild = true;
    that._readyState = kOPEN;
    socketChild.setSocketAndWindow(that, windowObject);
    that._socketBridge = socketChild;

    LOG("+++DBG++:TCPSocket.js:createAcceptedChild()-E");
    return that;
  },

  setAppId: function ts_setAppId(appId) {
    LOG("+++DBG++:TCPSocket.js:setAppId()-S");
#ifdef MOZ_WIDGET_GONK
    this._appId = appId;
#else
    // Do nothing because _appId only exists on Gonk-specific platform.
#endif
    LOG("+++DBG++:TCPSocket.js:setAppId()-E");
  },

  setOnUpdateBufferedAmountHandler: function(aFunction) {
    LOG("+++DBG++:TCPSocket.js:setOnUpdateBufferedAmountHandler()-S");
    if (typeof(aFunction) == 'function') {
      this._onUpdateBufferedAmount = aFunction;
    } else {
      throw new Error("only function can be passed to " +
                      "setOnUpdateBufferedAmountHandler");
    }
    LOG("+++DBG++:TCPSocket.js:setOnUpdateBufferedAmountHandler()-E");
  },

  /**
   * Handle the requst of sending data and update trackingNumber from
   * child.
   * This function is expected to be called by TCPSocketChild.
   */
  onRecvSendFromChild: function(data, byteOffset, byteLength, trackingNumber) {
    LOG("+++DBG++:TCPSocket.js:onRecvSendFromChild()-S");
    this._trackingNumber = trackingNumber;
    this.send(data, byteOffset, byteLength);
    LOG("+++DBG++:TCPSocket.js:onRecvSendFromChild()-E");
  },

  /* end nsITCPSocketInternal methods */

  initWindowless: function ts_initWindowless() {
    LOG("+++DBG++:TCPSocket.js:initWindowless()-S");
    try {
      return Services.prefs.getBoolPref("dom.mozTCPSocket.enabled");
    } catch (e) {
      // no pref means return false
      LOG("+++DBG++:TCPSocket.js:initWindowless()-E_return");
      return false;
    }
    LOG("+++DBG++:TCPSocket.js:initWindowless()-E");
  },

  init: function ts_init(aWindow) {
    LOG("+++DBG++:TCPSocket.js:init()-S");
    if (!this.initWindowless())
      return null;

    let principal = aWindow.document.nodePrincipal;
    let secMan = Cc["@mozilla.org/scriptsecuritymanager;1"]
                   .getService(Ci.nsIScriptSecurityManager);

    let perm = principal == secMan.getSystemPrincipal()
                 ? Ci.nsIPermissionManager.ALLOW_ACTION
                 : Services.perms.testExactPermissionFromPrincipal(principal, "tcp-socket");

    this._hasPrivileges = perm == Ci.nsIPermissionManager.ALLOW_ACTION;

    let util = aWindow.QueryInterface(
      Ci.nsIInterfaceRequestor
    ).getInterface(Ci.nsIDOMWindowUtils);

    this.useWin = XPCNativeWrapper.unwrap(aWindow);
    this.innerWindowID = util.currentInnerWindowID;
    LOG("window init: " + this.innerWindowID);
    LOG("+++DBG++:TCPSocket.js:init()-E");
  },

  observe: function(aSubject, aTopic, aData) {
    LOG("+++DBG++:TCPSocket.js:observe()-S");
    if (aTopic == "inner-window-destroyed") {
      let wId = aSubject.QueryInterface(Ci.nsISupportsPRUint64).data;
      if (wId == this.innerWindowID) {
        LOG("inner-window-destroyed: " + this.innerWindowID);

        // This window is now dead, so we want to clear the callbacks
        // so that we don't get a "can't access dead object" when the
        // underlying stream goes to tell us that we are closed
        this.onopen = null;
        this.ondrain = null;
        this.ondata = null;
        this.onerror = null;
        this.onclose = null;

        this.useWin = null;

        // Clean up our socket
        this.close();
      }
    }
    LOG("+++DBG++:TCPSocket.js:observe()-E");
  },

  // nsIDOMTCPSocket
  open: function ts_open(host, port, options) {
    LOG("+++DBG++:TCPSocket.js:open()-S");
    this._inChild = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime)
                       .processType != Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT;
    LOG("content process: " + (this._inChild ? "true" : "false"));

    // in the testing case, init won't be called and
    // hasPrivileges will be null. We want to proceed to test.
    if (this._hasPrivileges !== true && this._hasPrivileges !== null) {
      throw new Error("TCPSocket does not have permission in this context.\n");
    }
    let that = new TCPSocket();

    that.useWin = this.useWin;
    that.innerWindowID = this.innerWindowID;
    that._inChild = this._inChild;

    LOG("window init: " + that.innerWindowID);
    Services.obs.addObserver(that, "inner-window-destroyed", true);

    LOG("startup called");
    LOG("Host info: " + host + ":" + port);

    that._readyState = kCONNECTING;
    that._host = host;
    that._port = port;
    if (options !== undefined) {
      if (options.useSecureTransport) {
          that._ssl = 'ssl';
      } else {
          that._ssl = false;
      }
      that._binaryType = options.binaryType || that._binaryType;
    }

    LOG("SSL: " + that.ssl);

    if (this._inChild) {
      that._socketBridge = Cc["@mozilla.org/tcp-socket-child;1"]
                             .createInstance(Ci.nsITCPSocketChild);
      that._socketBridge.sendOpen(that, host, port, !!that._ssl,
                                  that._binaryType, this.useWin, this.useWin || this);
      LOG("+++DBG++:TCPSocket.js:open()-E_return");
      return that;
    }

    let transport = that._transport = this._createTransport(host, port, that._ssl);
    transport.setEventSink(that, Services.tm.currentThread);
    that._initStream(that._binaryType);

#ifdef MOZ_WIDGET_GONK
    // Set _activeNetwork, which is only required for network statistics.
    // Note that nsINetworkManager, as well as nsINetworkStatsServiceProxy, is
    // Gonk-specific.
    let networkManager = Cc["@mozilla.org/network/manager;1"].getService(Ci.nsINetworkManager);
    if (networkManager) {
      that._activeNetwork = networkManager.active;
    }
#endif

    LOG("+++DBG++:TCPSocket.js:open()-E");
    return that;
  },

  upgradeToSecure: function ts_upgradeToSecure() {
    LOG("+++DBG++:TCPSocket.js:upgradeToSecure()-S");
    if (this._readyState !== kOPEN) {
      throw new Error("Socket not open.");
    }
    if (this._ssl == 'ssl') {
      // Already SSL
      LOG("+++DBG++:TCPSocket.js:upgradeToSecure()-E_return");
      return;
    }

    this._ssl = 'ssl';

    if (this._inChild) {
      this._socketBridge.sendStartTLS();
      LOG("+++DBG++:TCPSocket.js:upgradeToSecure()-E_return");
      return;
    }

    if (this._multiplexStream.count == 0) {
      this._activateTLS();
    } else {
      this._waitingForStartTLS = true;
    }
    LOG("+++DBG++:TCPSocket.js:upgradeToSecure()-E");
  },

  listen: function ts_listen(localPort, options, backlog) {
    // in the testing case, init won't be called and
    // hasPrivileges will be null. We want to proceed to test.
    LOG("+++DBG++:TCPSocket.js:listen()-S");
    if (this._hasPrivileges !== true && this._hasPrivileges !== null) {
      throw new Error("TCPSocket does not have permission in this context.\n");
    }

    let that = new TCPServerSocket(this.useWin || this);

    options = options || { binaryType : this.binaryType };
    backlog = backlog || -1;
    that.listen(localPort, options, backlog);
    LOG("+++DBG++:TCPSocket.js:listen()-E");
    return that;
  },

  close: function ts_close() {
    LOG("+++DBG++:TCPSocket.js:close()-S");
    if (this._readyState === kCLOSED || this._readyState === kCLOSING)
      return;

    LOG("close called");
    this._readyState = kCLOSING;

    if (this._inChild) {
      this._socketBridge.sendClose();
      LOG("+++DBG++:TCPSocket.js:close()-E_return");
      return;
    }

    if (!this._multiplexStream.count) {
      this._socketOutputStream.close();
    }
    this._socketInputStream.close();
    LOG("+++DBG++:TCPSocket.js:close()-E");
  },

  send: function ts_send(data, byteOffset, byteLength) {
    LOG("+++DBG++:TCPSocket.js:send()-S");
    if (this._readyState !== kOPEN) {
      throw new Error("Socket not open.");
    }

    if (this._binaryType === "arraybuffer") {
      byteLength = byteLength || data.byteLength;
    }

    if (this._inChild) {
      this._socketBridge.sendSend(data, byteOffset, byteLength, ++this._trackingNumber);
    }

    let length = this._binaryType === "arraybuffer" ? byteLength : data.length;
    let newBufferedAmount = this.bufferedAmount + length;
    let bufferFull = newBufferedAmount >= BUFFER_SIZE;

    if (bufferFull) {
      // If we buffered more than some arbitrary amount of data,
      // (65535 right now) we should tell the caller so they can
      // wait until ondrain is called if they so desire. Once all the
      // buffered data has been written to the socket, ondrain is
      // called.
      this._waitingForDrain = true;
    }

    if (this._inChild) {
      // In child, we just add buffer length to our bufferedAmount and let
      // parent to update our bufferedAmount when data have been sent.
      this._bufferedAmount = newBufferedAmount;
      LOG("+++DBG++:TCPSocket.js:send()-E_return");
      return !bufferFull;
    }

    let new_stream;
    if (this._binaryType === "arraybuffer") {
      new_stream = new ArrayBufferInputStream();
      new_stream.setData(data, byteOffset, byteLength);
    } else {
      new_stream = new StringInputStream();
      new_stream.setData(data, length);
    }

    if (this._waitingForStartTLS) {
      // When we are waiting for starttls, new_stream is added to pendingData
      // and will be appended to multiplexStream after tls had been set up.
      this._pendingDataAfterStartTLS.push(new_stream);
    } else {
      this._multiplexStream.appendStream(new_stream);
    }

    this._ensureCopying();

#ifdef MOZ_WIDGET_GONK
    // Collect transmitted amount for network statistics.
    this._txBytes += length;
    this._saveNetworkStats(false);
#endif

    LOG("+++DBG++:TCPSocket.js:send()-E");
    return !bufferFull;
  },

  suspend: function ts_suspend() {
    LOG("+++DBG++:TCPSocket.js:suspend()-S");
    if (this._inChild) {
      this._socketBridge.sendSuspend();
      LOG("+++DBG++:TCPSocket.js:suspend()-E_return");
      return;
    }

    if (this._inputStreamPump) {
      this._inputStreamPump.suspend();
    } else {
      ++this._suspendCount;
    }
    LOG("+++DBG++:TCPSocket.js:suspend()-E");
  },

  resume: function ts_resume() {
    LOG("+++DBG++:TCPSocket.js:resume()-S");
    if (this._inChild) {
      this._socketBridge.sendResume();
      LOG("+++DBG++:TCPSocket.js:resume()-E_return");
      return;
    }

    if (this._inputStreamPump) {
      this._inputStreamPump.resume();
    } else if (this._suspendCount < 1) {
      throw new Error(kRESUME_ERROR);
    } else {
      --this._suspendCount;
    }
    LOG("+++DBG++:TCPSocket.js:resume()-E");
  },

  _maybeReportErrorAndCloseIfOpen: function(status) {
    LOG("+++DBG++:TCPSocket.js:_maybeReportErrorAndCloseIfOpen()-S");
#ifdef MOZ_WIDGET_GONK
    // Save network statistics once the connection is closed.
    // For now this function is Gonk-specific.
    this._saveNetworkStats(true);
#endif

    // If we're closed, we've already reported the error or just don't need to
    // report the error.
    if (this._readyState === kCLOSED)
      return;
    this._readyState = kCLOSED;

    if (!Components.isSuccessCode(status)) {
      // Convert the status code to an appropriate error message.  Raw constants
      // are used inline in all cases for consistency.  Some error codes are
      // available in Components.results, some aren't.  Network error codes are
      // effectively stable, NSS error codes are officially not, but we have no
      // symbolic way to dynamically resolve them anyways (other than an ability
      // to determine the error class.)
      let errName, errType;
      // security module? (and this is an error)
      if ((status & 0xff0000) === 0x5a0000) {
        const nsINSSErrorsService = Ci.nsINSSErrorsService;
        let nssErrorsService = Cc['@mozilla.org/nss_errors_service;1']
                                 .getService(nsINSSErrorsService);
        let errorClass;
        // getErrorClass will throw a generic NS_ERROR_FAILURE if the error code is
        // somehow not in the set of covered errors.
        try {
          errorClass = nssErrorsService.getErrorClass(status);
        }
        catch (ex) {
          errorClass = 'SecurityProtocol';
        }
        switch (errorClass) {
          case nsINSSErrorsService.ERROR_CLASS_SSL_PROTOCOL:
            errType = 'SecurityProtocol';
            break;
          case nsINSSErrorsService.ERROR_CLASS_BAD_CERT:
            errType = 'SecurityCertificate';
            break;
          // no default is required; the platform impl automatically defaults to
          // ERROR_CLASS_SSL_PROTOCOL.
        }

        // NSS_SEC errors (happen below the base value because of negative vals)
        if ((status & 0xffff) <
            Math.abs(nsINSSErrorsService.NSS_SEC_ERROR_BASE)) {
          // The bases are actually negative, so in our positive numeric space, we
          // need to subtract the base off our value.
          let nssErr = Math.abs(nsINSSErrorsService.NSS_SEC_ERROR_BASE) -
                         (status & 0xffff);
          switch (nssErr) {
            case 11: // SEC_ERROR_EXPIRED_CERTIFICATE, sec(11)
              errName = 'SecurityExpiredCertificateError';
              break;
            case 12: // SEC_ERROR_REVOKED_CERTIFICATE, sec(12)
              errName = 'SecurityRevokedCertificateError';
              break;
            // per bsmith, we will be unable to tell these errors apart very soon,
            // so it makes sense to just folder them all together already.
            case 13: // SEC_ERROR_UNKNOWN_ISSUER, sec(13)
            case 20: // SEC_ERROR_UNTRUSTED_ISSUER, sec(20)
            case 21: // SEC_ERROR_UNTRUSTED_CERT, sec(21)
            case 36: // SEC_ERROR_CA_CERT_INVALID, sec(36)
              errName = 'SecurityUntrustedCertificateIssuerError';
              break;
            case 90: // SEC_ERROR_INADEQUATE_KEY_USAGE, sec(90)
              errName = 'SecurityInadequateKeyUsageError';
              break;
            case 176: // SEC_ERROR_CERT_SIGNATURE_ALGORITHM_DISABLED, sec(176)
              errName = 'SecurityCertificateSignatureAlgorithmDisabledError';
              break;
            default:
              errName = 'SecurityError';
              break;
          }
        }
        // NSS_SSL errors
        else {
          let sslErr = Math.abs(nsINSSErrorsService.NSS_SSL_ERROR_BASE) -
                         (status & 0xffff);
          switch (sslErr) {
            case 3: // SSL_ERROR_NO_CERTIFICATE, ssl(3)
              errName = 'SecurityNoCertificateError';
              break;
            case 4: // SSL_ERROR_BAD_CERTIFICATE, ssl(4)
              errName = 'SecurityBadCertificateError';
              break;
            case 8: // SSL_ERROR_UNSUPPORTED_CERTIFICATE_TYPE, ssl(8)
              errName = 'SecurityUnsupportedCertificateTypeError';
              break;
            case 9: // SSL_ERROR_UNSUPPORTED_VERSION, ssl(9)
              errName = 'SecurityUnsupportedTLSVersionError';
              break;
            case 12: // SSL_ERROR_BAD_CERT_DOMAIN, ssl(12)
              errName = 'SecurityCertificateDomainMismatchError';
              break;
            default:
              errName = 'SecurityError';
              break;
          }
        }
      }
      // must be network
      else {
        errType = 'Network';
        switch (status) {
          // connect to host:port failed
          case 0x804B000C: // NS_ERROR_CONNECTION_REFUSED, network(13)
            errName = 'ConnectionRefusedError';
            break;
          // network timeout error
          case 0x804B000E: // NS_ERROR_NET_TIMEOUT, network(14)
            errName = 'NetworkTimeoutError';
            break;
          // hostname lookup failed
          case 0x804B001E: // NS_ERROR_UNKNOWN_HOST, network(30)
            errName = 'DomainNotFoundError';
            break;
          case 0x804B0047: // NS_ERROR_NET_INTERRUPT, network(71)
            errName = 'NetworkInterruptError';
            break;
          default:
            errName = 'NetworkError';
            break;
        }
      }
      let err = createTCPError(this.useWin, errName, errType);
      this.callListener("error", err);
    }
    this.callListener("close");
    LOG("+++DBG++:TCPSocket.js:_maybeReportErrorAndCloseIfOpen()-E");
  },

  // nsITransportEventSink (Triggered by transport.setEventSink)
  onTransportStatus: function ts_onTransportStatus(
    LOG("+++DBG++:TCPSocket.js:onTransportStatus()-S");
    transport, status, progress, max) {
    if (status === Ci.nsISocketTransport.STATUS_CONNECTED_TO) {
      this._readyState = kOPEN;
      this.callListener("open");

      this._inputStreamPump = new InputStreamPump(
        this._socketInputStream, -1, -1, 0, 0, false
      );

      while (this._suspendCount--) {
        this._inputStreamPump.suspend();
      }

      this._inputStreamPump.asyncRead(this, null);
    }
    LOG("+++DBG++:TCPSocket.js:onTransportStatus()-E");
  },

  // nsIAsyncInputStream (Triggered by _socketInputStream.asyncWait)
  // Only used for detecting connection refused
  onInputStreamReady: function ts_onInputStreamReady(input) {
    LOG("+++DBG++:TCPSocket.js:onInputStreamReady()-S");
    try {
      input.available();
    } catch (e) {
      // NS_ERROR_CONNECTION_REFUSED
      this._maybeReportErrorAndCloseIfOpen(0x804B000C);
    }
    LOG("+++DBG++:TCPSocket.js:onInputStreamReady()-E");
  },

  // nsIRequestObserver (Triggered by _inputStreamPump.asyncRead)
  onStartRequest: function ts_onStartRequest(request, context) {
  },

  // nsIRequestObserver (Triggered by _inputStreamPump.asyncRead)
  onStopRequest: function ts_onStopRequest(request, context, status) {
    let buffered_output = this._multiplexStream.count !== 0;

    this._inputStreamPump = null;

    let statusIsError = !Components.isSuccessCode(status);

    if (buffered_output && !statusIsError) {
      // If we have some buffered output still, and status is not an
      // error, the other side has done a half-close, but we don't
      // want to be in the close state until we are done sending
      // everything that was buffered. We also don't want to call onclose
      // yet.
      return;
    }

    // We call this even if there is no error.
    this._maybeReportErrorAndCloseIfOpen(status);
  },

  // nsIStreamListener (Triggered by _inputStreamPump.asyncRead)
  onDataAvailable: function ts_onDataAvailable(request, context, inputStream, offset, count) {
    if (this._binaryType === "arraybuffer") {
      let buffer = new (this.useWin ? this.useWin.ArrayBuffer : ArrayBuffer)(count);
      this._inputStreamBinary.readArrayBuffer(count, buffer);
      this.callListener("data", buffer);
    } else {
      this.callListener("data", this._inputStreamScriptable.read(count));
    }

#ifdef MOZ_WIDGET_GONK
    // Collect received amount for network statistics.
    this._rxBytes += count;
    this._saveNetworkStats(false);
#endif
  },

  classID: Components.ID("{cda91b22-6472-11e1-aa11-834fec09cd0a}"),

  classInfo: XPCOMUtils.generateCI({
    classID: Components.ID("{cda91b22-6472-11e1-aa11-834fec09cd0a}"),
    contractID: "@mozilla.org/tcp-socket;1",
    classDescription: "Client TCP Socket",
    interfaces: [
      Ci.nsIDOMTCPSocket,
    ],
    flags: Ci.nsIClassInfo.DOM_OBJECT,
  }),

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIDOMTCPSocket,
    Ci.nsITCPSocketInternal,
    Ci.nsIDOMGlobalPropertyInitializer,
    Ci.nsIObserver,
    Ci.nsISupportsWeakReference
  ])
}

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([TCPSocket]);
