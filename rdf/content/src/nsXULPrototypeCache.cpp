/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * The contents of this file are subject to the Netscape Public
 * License Version 1.1 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of
 * the License at http://www.mozilla.org/NPL/
 *
 * Software distributed under the License is distributed on an "AS
 * IS" basis, WITHOUT WARRANTY OF ANY KIND, either express or
 * implied. See the License for the specific language governing
 * rights and limitations under the License.
 *
 * The Original Code is Mozilla Communicator client code.
 *
 * The Initial Developer of the Original Code is Netscape Communications
 * Corporation.  Portions created by Netscape are
 * Copyright (C) 1998 Netscape Communications Corporation. All
 * Rights Reserved.
 *
 * Contributor(s): 
 */

/*



 */

#include "nsCOMPtr.h"
#include "nsICSSStyleSheet.h"
#include "nsIXULPrototypeCache.h"
#include "nsIXULPrototypeDocument.h"
#include "nsIURI.h"
#include "nsHashtable.h"
#include "nsXPIDLString.h"
#include "plstr.h"


class nsXULPrototypeCache : public nsIXULPrototypeCache
{
public:
    // nsISupports
    NS_DECL_ISUPPORTS

    NS_IMETHOD GetPrototype(nsIURI* aURI, nsIXULPrototypeDocument** _result);
    NS_IMETHOD PutPrototype(nsIXULPrototypeDocument* aDocument);
    NS_IMETHOD FlushPrototypes();

    NS_IMETHOD GetStyleSheet(nsIURI* aURI, nsICSSStyleSheet** _result);
    NS_IMETHOD PutStyleSheet(nsICSSStyleSheet* aStyleSheet);
    NS_IMETHOD FlushStyleSheets();

    NS_IMETHOD Flush();

protected:
    friend NS_IMETHODIMP
    NS_NewXULPrototypeCache(nsISupports* aOuter, REFNSIID aIID, void** aResult);

    nsXULPrototypeCache();
    virtual ~nsXULPrototypeCache();

    nsSupportsHashtable mPrototypeTable;
    nsSupportsHashtable mStyleSheetTable;


    class nsIURIKey : public nsHashKey {
    protected:
        nsCOMPtr<nsIURI> mKey;
  
    public:
        nsIURIKey(nsIURI* key) : mKey(key) {}
        ~nsIURIKey(void) {}
  
        PRUint32 HashValue(void) const {
            nsXPIDLCString spec;
            mKey->GetSpec(getter_Copies(spec));
            return (PRUint32) PL_HashString(spec);
        }

        PRBool Equals(const nsHashKey *aKey) const {
            PRBool eq;
            mKey->Equals( ((nsIURIKey*) aKey)->mKey, &eq );
            return eq;
        }

        nsHashKey *Clone(void) const {
            return new nsIURIKey(mKey);
        }
    };
};



nsXULPrototypeCache::nsXULPrototypeCache()
{
    NS_INIT_REFCNT();
}


nsXULPrototypeCache::~nsXULPrototypeCache()
{
}


NS_IMPL_ISUPPORTS1(nsXULPrototypeCache, nsIXULPrototypeCache);


NS_IMETHODIMP
NS_NewXULPrototypeCache(nsISupports* aOuter, REFNSIID aIID, void** aResult)
{
    NS_PRECONDITION(! aOuter, "no aggregation");
    if (aOuter)
        return NS_ERROR_NO_AGGREGATION;

    nsXULPrototypeCache* result = new nsXULPrototypeCache();
    if (! result)
        return NS_ERROR_OUT_OF_MEMORY;

    nsresult rv;

    NS_ADDREF(result);
    rv = result->QueryInterface(aIID, aResult);
    NS_RELEASE(result);

    return rv;
}


//----------------------------------------------------------------------


NS_IMETHODIMP
nsXULPrototypeCache::GetPrototype(nsIURI* aURI, nsIXULPrototypeDocument** _result)
{
    nsIURIKey key(aURI);
    *_result = NS_STATIC_CAST(nsIXULPrototypeDocument*, mPrototypeTable.Get(&key));
    return NS_OK;
}


NS_IMETHODIMP
nsXULPrototypeCache::PutPrototype(nsIXULPrototypeDocument* aDocument)
{
    nsresult rv;
    nsCOMPtr<nsIURI> uri;
    rv = aDocument->GetURI(getter_AddRefs(uri));

    nsIURIKey key(uri);
    nsIXULPrototypeDocument* oldproto = NS_STATIC_CAST(nsIXULPrototypeDocument*, mPrototypeTable.Put(&key, aDocument));
    NS_IF_RELEASE(oldproto);

    return NS_OK;
}


NS_IMETHODIMP
nsXULPrototypeCache::FlushPrototypes()
{
    mPrototypeTable.Reset();
    return NS_OK;
}


NS_IMETHODIMP
nsXULPrototypeCache::GetStyleSheet(nsIURI* aURI, nsICSSStyleSheet** _result)
{
    nsIURIKey key(aURI);
    *_result = NS_STATIC_CAST(nsICSSStyleSheet*, mStyleSheetTable.Get(&key));
    return NS_OK;
}


NS_IMETHODIMP
nsXULPrototypeCache::PutStyleSheet(nsICSSStyleSheet* aStyleSheet)
{
    nsresult rv;
    nsCOMPtr<nsIURI> uri;
    rv = aStyleSheet->GetURL(*getter_AddRefs(uri));

    nsIURIKey key(uri);
    nsICSSStyleSheet* oldsheet = NS_STATIC_CAST(nsICSSStyleSheet*, mStyleSheetTable.Put(&key, aStyleSheet));
    NS_IF_RELEASE(oldsheet);

    return NS_OK;
}


NS_IMETHODIMP
nsXULPrototypeCache::FlushStyleSheets()
{
    mStyleSheetTable.Reset();
    return NS_OK;
}


NS_IMETHODIMP
nsXULPrototypeCache::Flush()
{
    FlushPrototypes();
    FlushStyleSheets();
    return NS_OK;
}

