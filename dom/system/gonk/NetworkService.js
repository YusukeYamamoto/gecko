/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const NETWORKSERVICE_CONTRACTID = "@mozilla.org/network/service;1";
const NETWORKSERVICE_CID = Components.ID("{c14cabaf-bb8e-470d-a2f1-2cb6de6c5e5c}");

// 1xx - Requested action is proceeding
const NETD_COMMAND_PROCEEDING   = 100;
// 2xx - Requested action has been successfully completed
const NETD_COMMAND_OKAY         = 200;
// 4xx - The command is accepted but the requested action didn't
// take place.
const NETD_COMMAND_FAIL         = 400;
// 5xx - The command syntax or parameters error
const NETD_COMMAND_ERROR        = 500;
// 6xx - Unsolicited broadcasts
const NETD_COMMAND_UNSOLICITED  = 600;

const WIFI_CTRL_INTERFACE = "wl0.1";

const MANUAL_PROXY_CONFIGURATION = 1;

const DEBUG = true;

function netdResponseType(code) {
  return Math.floor(code / 100) * 100;
}

function isError(code) {
  let type = netdResponseType(code);
  return (type !== NETD_COMMAND_PROCEEDING && type !== NETD_COMMAND_OKAY);
}

function debug(msg) {
  dump("-*- NetworkService: " + msg + "\n");
}

/**
 * This component watches for network interfaces changing state and then
 * adjusts routes etc. accordingly.
 */
function NetworkService() {
  debug("+++DBG++:NetworkService.js:NetworkService()-S");
  if(DEBUG) debug("Starting net_worker.");
  this.worker = new ChromeWorker("resource://gre/modules/net_worker.js");
  this.worker.onmessage = this.handleWorkerMessage.bind(this);
  this.worker.onerror = function onerror(event) {
    if(DEBUG) debug("Received error from worker: " + event.filename + 
                    ":" + event.lineno + ": " + event.message + "\n");
    // Prevent the event from bubbling any further.
    event.preventDefault();
  };

  // Callbacks to invoke when a reply arrives from the net_worker.
  this.controlCallbacks = Object.create(null);
  debug("+++DBG++:NetworkService.js:NetworkService()-E");
}

NetworkService.prototype = {
  classID:   NETWORKSERVICE_CID,
  classInfo: XPCOMUtils.generateCI({classID: NETWORKSERVICE_CID,
                                    contractID: NETWORKSERVICE_CONTRACTID,
                                    classDescription: "Network Service",
                                    interfaces: [Ci.nsINetworkService]}),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsINetworkService,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIWorkerHolder]),

  // nsIWorkerHolder

  worker: null,

  // Helpers

  idgen: 0,
  controlMessage: function controlMessage(params, callback) {
    debug("+++DBG++:NetworkService.js:controlMessage()-S");
    if (callback) {
      let id = this.idgen++;
      params.id = id;
      this.controlCallbacks[id] = callback;
    }
    this.worker.postMessage(params);
    debug("+++DBG++:NetworkService.js:controlMessage()-E");
  },

  handleWorkerMessage: function handleWorkerMessage(e) {
    debug("+++DBG++:NetworkService.js:handleWorkerMessage()-S");
    if(DEBUG) debug("NetworkManager received message from worker: " + JSON.stringify(e.data));
    let response = e.data;
    let id = response.id;
    if (id === 'broadcast') {
      Services.obs.notifyObservers(null, response.topic, response.reason);
      debug("+++DBG++:NetworkService.js:handleWorkerMessage()-E_return");
      return;
    }
    let callback = this.controlCallbacks[id];
    if (callback) {
      callback.call(this, response);
      delete this.controlCallbacks[id];
    }
    debug("+++DBG++:NetworkService.js:handleWorkerMessage()-E");
  },

  // nsINetworkService

  getNetworkInterfaceStats: function getNetworkInterfaceStats(networkName, callback) {
    debug("+++DBG++:NetworkService.js:getNetworkInterfaceStats()-S");
    if(DEBUG) debug("getNetworkInterfaceStats for " + networkName);

    let params = {
      cmd: "getNetworkInterfaceStats",
      ifname: networkName
    };

    params.report = true;
    params.isAsync = true;

    this.controlMessage(params, function(result) {
      let success = !isError(result.resultCode);
      callback.networkStatsAvailable(success, result.rxBytes,
                                     result.txBytes, result.date);
    });
    debug("+++DBG++:NetworkService.js:getNetworkInterfaceStats()-E");
  },

  setNetworkInterfaceAlarm: function setNetworkInterfaceAlarm(networkName, threshold, callback) {
    debug("+++DBG++:NetworkService.js:setNetworkInterfaceAlarm()-S");
    if (!networkName) {
      callback.networkUsageAlarmResult(-1);
      return;
    }

    if (threshold < 0) {
      this._disableNetworkInterfaceAlarm(networkName, callback);
      debug("+++DBG++:NetworkService.js:setNetworkInterfaceAlarm()-E_return");
      return;
    }

    this._setNetworkInterfaceAlarm(networkName, threshold, callback);
    debug("+++DBG++:NetworkService.js:setNetworkInterfaceAlarm()-E");
  },

  _setNetworkInterfaceAlarm: function _setNetworkInterfaceAlarm(networkName, threshold, callback) {
    debug("setNetworkInterfaceAlarm for " + networkName + " at " + threshold + "bytes");

    let params = {
      cmd: "setNetworkInterfaceAlarm",
      ifname: networkName,
      threshold: threshold
    };

    params.report = true;
    params.isAsync = true;

    this.controlMessage(params, function(result) {
      if (!isError(result.resultCode)) {
        callback.networkUsageAlarmResult(null);
        return;
      }

      this._enableNetworkInterfaceAlarm(networkName, threshold, callback);
    });
  },

  _enableNetworkInterfaceAlarm: function _enableNetworkInterfaceAlarm(networkName, threshold, callback) {
    debug("enableNetworkInterfaceAlarm for " + networkName + " at " + threshold + "bytes");

    let params = {
      cmd: "enableNetworkInterfaceAlarm",
      ifname: networkName,
      threshold: threshold
    };

    params.report = true;
    params.isAsync = true;

    this.controlMessage(params, function(result) {
      if (!isError(result.resultCode)) {
        callback.networkUsageAlarmResult(null);
        return;
      }
      callback.networkUsageAlarmResult(result.reason);
    });
  },

  _disableNetworkInterfaceAlarm: function _disableNetworkInterfaceAlarm(networkName, callback) {
    debug("disableNetworkInterfaceAlarm for " + networkName);

    let params = {
      cmd: "disableNetworkInterfaceAlarm",
      ifname: networkName,
    };

    params.report = true;
    params.isAsync = true;

    this.controlMessage(params, function(result) {
      if (!isError(result.resultCode)) {
        callback.networkUsageAlarmResult(null);
        return;
      }
      callback.networkUsageAlarmResult(result.reason);
    });
  },

  setWifiOperationMode: function setWifiOperationMode(interfaceName, mode, callback) {
    debug("+++DBG++:NetworkService.js:setWifiOperationMode()-S");
    if(DEBUG) debug("setWifiOperationMode on " + interfaceName + " to " + mode);

    let params = {
      cmd: "setWifiOperationMode",
      ifname: interfaceName,
      mode: mode
    };

    params.report = true;
    params.isAsync = true;

    this.controlMessage(params, function(result) {
      if (isError(result.resultCode)) {
        callback.wifiOperationModeResult("netd command error");
      } else {
        callback.wifiOperationModeResult(null);
      }
    });
    debug("+++DBG++:NetworkService.js:setWifiOperationMode()-E");
  },

  resetRoutingTable: function resetRoutingTable(network) {
    debug("+++DBG++:NetworkService.js:resetRoutingTable()-S");
    if (!network.ip || !network.netmask) {
      if(DEBUG) debug("Either ip or netmask is null. Cannot reset routing table.");
      debug("+++DBG++:NetworkService.js:resetRoutingTable()-S_return");
      return;
    }
    let options = {
      cmd: "removeNetworkRoute",
      ifname: network.name,
      ip: network.ip,
      netmask: network.netmask
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:resetRoutingTable()-E");
  },

  setDNS: function setDNS(networkInterface) {
    debug("+++DBG++:NetworkService.js:setDNS()-S");
    if(DEBUG) debug("Going DNS to " + networkInterface.name);
    let options = {
      cmd: "setDNS",
      ifname: networkInterface.name,
      dns1_str: networkInterface.dns1,
      dns2_str: networkInterface.dns2
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:setDNS()-E");
  },

  setDefaultRouteAndDNS: function setDefaultRouteAndDNS(network, oldInterface) {
    debug("+++DBG++:NetworkService.js:setDefaultRouteAndDNS()-S");
    if(DEBUG) debug("Going to change route and DNS to " + network.name);
    let options = {
      cmd: "setDefaultRouteAndDNS",
      ifname: network.name,
      oldIfname: (oldInterface && oldInterface !== network) ? oldInterface.name : null,
      gateway_str: network.gateway,
      dns1_str: network.dns1,
      dns2_str: network.dns2
    };
    this.worker.postMessage(options);
    this.setNetworkProxy(network);
    debug("+++DBG++:NetworkService.js:setDefaultRouteAndDNS()-E");
  },

  removeDefaultRoute: function removeDefaultRoute(ifname) {
    debug("+++DBG++:NetworkService.js:removeDefaultRoute()-S");
    if(DEBUG) debug("Remove default route for " + ifname);
    let options = {
      cmd: "removeDefaultRoute",
      ifname: ifname
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:removeDefaultRoute()-E");
  },

  addHostRoute: function addHostRoute(network) {
    debug("+++DBG++:NetworkService.js:addHostRoute()-S");
    if(DEBUG) debug("Going to add host route on " + network.name);
    let options = {
      cmd: "addHostRoute",
      ifname: network.name,
      gateway: network.gateway,
      hostnames: [network.dns1, network.dns2, network.httpProxyHost]
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:addHostRoute()-E");
  },

  removeHostRoute: function removeHostRoute(network) {
    debug("+++DBG++:NetworkService.js:removeHostRoute()-S");
    if(DEBUG) debug("Going to remove host route on " + network.name);
    let options = {
      cmd: "removeHostRoute",
      ifname: network.name,
      gateway: network.gateway,
      hostnames: [network.dns1, network.dns2, network.httpProxyHost]
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:removeHostRoute()-E");
  },

  removeHostRoutes: function removeHostRoutes(ifname) {
    debug("+++DBG++:NetworkService.js:removeHostRoutes()-S");
    if(DEBUG) debug("Going to remove all host routes on " + ifname);
    let options = {
      cmd: "removeHostRoutes",
      ifname: ifname,
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:removeHostRoutes()-E");
  },

  addHostRouteWithResolve: function addHostRouteWithResolve(network, hosts) {
    debug("+++DBG++:NetworkService.js:addHostRouteWithResolve()-S");
    if(DEBUG) debug("Going to add host route after dns resolution on " + network.name);
    let options = {
      cmd: "addHostRoute",
      ifname: network.name,
      gateway: network.gateway,
      hostnames: hosts
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:addHostRouteWithResolve()-S");
  },

  removeHostRouteWithResolve: function removeHostRouteWithResolve(network, hosts) {
    debug("+++DBG++:NetworkService.js:removeHostRouteWithResolve()-S");
    if(DEBUG) debug("Going to remove host route after dns resolution on " + network.name);
    let options = {
      cmd: "removeHostRoute",
      ifname: network.name,
      gateway: network.gateway,
      hostnames: hosts
    };
    this.worker.postMessage(options);
    debug("+++DBG++:NetworkService.js:removeHostRouteWithResolve()-E");
  },

  setNetworkProxy: function setNetworkProxy(network) {
    debug("+++DBG++:NetworkService.js:setNetworkProxy()-S");
    try {
      if (!network.httpProxyHost || network.httpProxyHost === "") {
        // Sets direct connection to internet.
        Services.prefs.clearUserPref("network.proxy.type");
        Services.prefs.clearUserPref("network.proxy.share_proxy_settings");
        Services.prefs.clearUserPref("network.proxy.http");
        Services.prefs.clearUserPref("network.proxy.http_port");
        Services.prefs.clearUserPref("network.proxy.ssl");
        Services.prefs.clearUserPref("network.proxy.ssl_port");
        if(DEBUG) debug("No proxy support for " + network.name + " network interface.");
        debug("+++DBG++:NetworkService.js:setNetworkProxy()-E_return");
        return;
      }

      if(DEBUG) debug("Going to set proxy settings for " + network.name + " network interface.");
      // Sets manual proxy configuration.
      Services.prefs.setIntPref("network.proxy.type", MANUAL_PROXY_CONFIGURATION);
      // Do not use this proxy server for all protocols.
      Services.prefs.setBoolPref("network.proxy.share_proxy_settings", false);
      Services.prefs.setCharPref("network.proxy.http", network.httpProxyHost);
      Services.prefs.setCharPref("network.proxy.ssl", network.httpProxyHost);
      let port = network.httpProxyPort === 0 ? 8080 : network.httpProxyPort;
      Services.prefs.setIntPref("network.proxy.http_port", port);
      Services.prefs.setIntPref("network.proxy.ssl_port", port);
    } catch(ex) {
        if(DEBUG) debug("Exception " + ex + ". Unable to set proxy setting for " +
                         network.name + " network interface.");
    }
    debug("+++DBG++:NetworkService.js:setNetworkProxy()-E");
  },

  // Enable/Disable DHCP server.
  setDhcpServer: function setDhcpServer(enabled, config, callback) {
    debug("+++DBG++:NetworkService.js:setDhcpServer()-S");
    if (null === config) {
      config = {};
    }

    config.cmd = "setDhcpServer";
    config.isAsync = true;
    config.enabled = enabled;

    this.controlMessage(config, function setDhcpServerResult(response) {
      if (!response.success) {
        callback.dhcpServerResult('Set DHCP server error');
        debug("+++DBG++:NetworkService.js:setDhcpServer()-E_return");
        return;
      }
      callback.dhcpServerResult(null);
    });
    debug("+++DBG++:NetworkService.js:setDhcpServer()-E");
  },

  // Enable/disable WiFi tethering by sending commands to netd.
  setWifiTethering: function setWifiTethering(enable, config, callback) {
    debug("+++DBG++:NetworkService.js:setWifiTethering()-S");
    // config should've already contained:
    //   .ifname
    //   .internalIfname
    //   .externalIfname
    config.wifictrlinterfacename = WIFI_CTRL_INTERFACE;
    config.cmd = "setWifiTethering";

    // The callback function in controlMessage may not be fired immediately.
    config.isAsync = true;
    this.controlMessage(config, function setWifiTetheringResult(data) {
      let code = data.resultCode;
      let reason = data.resultReason;
      let enable = data.enable;
      let enableString = enable ? "Enable" : "Disable";

      if(DEBUG) debug(enableString + " Wifi tethering result: Code " + code + " reason " + reason);

      if (isError(code)) {
        callback.wifiTetheringEnabledChange("netd command error");
      } else {
        callback.wifiTetheringEnabledChange(null);
      }
    });
    debug("+++DBG++:NetworkService.js:setWifiTethering()-E");
  },

  // Enable/disable USB tethering by sending commands to netd.
  setUSBTethering: function setUSBTethering(enable, config, callback) {
    debug("+++DBG++:NetworkService.js:setWifiTethering()-S");
    config.cmd = "setUSBTethering";
    // The callback function in controlMessage may not be fired immediately.
    config.isAsync = true;
    this.controlMessage(config, function setUsbTetheringResult(data) {
      let code = data.resultCode;
      let reason = data.resultReason;
      let enable = data.enable;
      let enableString = enable ? "Enable" : "Disable";

      if(DEBUG) debug(enableString + " USB tethering result: Code " + code + " reason " + reason);

      if (isError(code)) {
        callback.usbTetheringEnabledChange("netd command error");
      } else {
        callback.usbTetheringEnabledChange(null);
      }
    });
    debug("+++DBG++:NetworkService.js:setUSBTethering()-E");
  },

  // Switch usb function by modifying property of persist.sys.usb.config.
  enableUsbRndis: function enableUsbRndis(enable, callback) {
    debug("+++DBG++:NetworkService.js:enableUsbRndis()-S");
    if(DEBUG) debug("enableUsbRndis: " + enable);

    let params = {
      cmd: "enableUsbRndis",
      enable: enable
    };
    // Ask net work to report the result when this value is set to true.
    if (callback) {
      params.report = true;
    } else {
      params.report = false;
    }

    // The callback function in controlMessage may not be fired immediately.
    params.isAsync = true;
    //this._usbTetheringAction = TETHERING_STATE_ONGOING;
    this.controlMessage(params, function (data) {
      callback.enableUsbRndisResult(data.result, data.enable);
    });
    debug("+++DBG++:NetworkService.js:enableUsbRndis()-E");
  },

  updateUpStream: function updateUpStream(previous, current, callback) {
    debug("+++DBG++:NetworkService.js:updateUpStream()-S");
    let params = {
      cmd: "updateUpStream",
      isAsync: true,
      previous: previous,
      current: current
    };

    this.controlMessage(params, function (data) {
      let code = data.resultCode;
      let reason = data.resultReason;
      if(DEBUG) debug("updateUpStream result: Code " + code + " reason " + reason);
      callback.updateUpStreamResult(!isError(code), data.current.externalIfname);
    });
    debug("+++DBG++:NetworkService.js:updateUpStream()-E");
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([NetworkService]);
