/* @flow */

import { ZalgoPromise } from 'zalgo-promise/src';
import { getDomain, getFrameByName, isWindowClosed, getDomainFromUrl, normalizeMockUrl, type CrossDomainWindowType } from 'cross-domain-utils/src';

import { CONFIG, MESSAGE_NAME } from '../conf';
import { awaitWindowHello } from '../lib';
import { global, windowStore, globalStore } from '../global';

import { getBridgeName, documentBodyReady, registerRemoteSendMessage, registerRemoteWindow } from './common';

let bridges = globalStore('bridges');
let bridgeFrames = globalStore('bridgeFrames');
let popupWindowsByName = globalStore('popupWindowsByName');
let popupWindowsByWin = windowStore('popupWindowsByWin');

function listenForRegister(source, domain) {
    global.on(MESSAGE_NAME.OPEN_TUNNEL, { window: source, domain }, ({ origin, data }) => {

        if (origin !== domain) {
            throw new Error(`Domain ${ domain } does not match origin ${ origin }`);
        }

        if (!data.name) {
            throw new Error(`Register window expected to be passed window name`);
        }

        if (!data.sendMessage) {
            throw new Error(`Register window expected to be passed sendMessage method`);
        }

        if (!popupWindowsByName.has(data.name)) {
            throw new Error(`Window with name ${ data.name } does not exist, or was not opened by this window`);
        }

        // $FlowFixMe
        if (!popupWindowsByName.get(data.name).domain) {
            throw new Error(`We do not have a registered domain for window ${ data.name }`);
        }

        // $FlowFixMe
        if (popupWindowsByName.get(data.name).domain !== origin) {
            // $FlowFixMe
            throw new Error(`Message origin ${ origin } does not matched registered window origin ${ popupWindowsByName.get(data.name).domain }`);
        }

        // $FlowFixMe
        registerRemoteSendMessage(popupWindowsByName.get(data.name).win, domain, data.sendMessage);

        return {
            sendMessage(message) {

                if (!window || window.closed) {
                    return;
                }

                let winDetails = popupWindowsByName.get(data.name);

                if (!winDetails) {
                    return;
                }

                try {
                    global.receiveMessage({
                        data:   message,
                        origin: winDetails.domain,
                        source: winDetails.win
                    });
                } catch (err) {
                    ZalgoPromise.reject(err);
                }
            }
        };
    });
}

function openBridgeFrame(name : string, url : string) : HTMLIFrameElement {

    let iframe = document.createElement(`iframe`);

    iframe.setAttribute(`name`, name);
    iframe.setAttribute(`id`,   name);

    iframe.setAttribute(`style`, `display: none; margin: 0; padding: 0; border: 0px none; overflow: hidden;`);
    iframe.setAttribute(`frameborder`, `0`);
    iframe.setAttribute(`border`, `0`);
    iframe.setAttribute(`scrolling`, `no`);
    iframe.setAttribute(`allowTransparency`, `true`);

    iframe.setAttribute(`tabindex`, `-1`);
    iframe.setAttribute(`hidden`, `true`);
    iframe.setAttribute(`title`, ``);
    iframe.setAttribute(`role`, `presentation`);

    iframe.src = url;

    return iframe;
}

export function hasBridge(url : string, domain : string) : boolean {
    return bridges.has(domain || getDomainFromUrl(url));
}

export function openBridge(url : string, domain : string) : ZalgoPromise<CrossDomainWindowType> {
    domain = domain || getDomainFromUrl(url);
    
    return bridges.getOrSet(domain, () => ZalgoPromise.try(() => {

        if (getDomain() === domain) {
            throw new Error(`Can not open bridge on the same domain as current domain: ${ domain }`);
        }

        let name  = getBridgeName(domain);
        let frame = getFrameByName(window, name);

        if (frame) {
            throw new Error(`Frame with name ${ name } already exists on page`);
        }

        let iframe = openBridgeFrame(name, url);
        bridgeFrames.set(domain, iframe);

        return documentBodyReady.then(body => {

            body.appendChild(iframe);

            let bridge = iframe.contentWindow;

            listenForRegister(bridge, domain);

            return new ZalgoPromise((resolve, reject) => {

                iframe.onload = resolve;
                iframe.onerror = reject;

            }).then(() => {

                return awaitWindowHello(bridge, CONFIG.BRIDGE_TIMEOUT, `Bridge ${ url }`);

            }).then(() => {

                return bridge;
            });
        });
    }));
}

type WinDetails = {|
    win : CrossDomainWindowType,
    domain? : ?string,
    name? : ?string
|};

export function linkWindow({ win, name, domain } : WinDetails) : WinDetails {

    for (let winName of popupWindowsByName.keys()) {
        // $FlowFixMe
        if (isWindowClosed(popupWindowsByName.get(winName).win)) {
            popupWindowsByName.del(winName);
        }
    }

    let details : WinDetails = popupWindowsByWin.getOrSet(win, () => {
        if (!name) {
            return { win };
        }
        
        return popupWindowsByName.getOrSet(name, () => {
            return { win, name };
        });
    });

    if (details.win && details.win !== win) {
        throw new Error(`Different window already linked for window: ${ name || 'undefined' }`);
    }

    if (name) {
        if (details.name && details.name !== name) {
            throw new Error(`Different window already linked for name ${ name }: ${ details.name }`);
        }

        details.name = name;
        popupWindowsByName.set(name, details);
    }

    if (domain) {
        details.domain = domain;
        registerRemoteWindow(win);
    }

    popupWindowsByWin.set(win, details);
    
    return details;
}

export function linkUrl(win : CrossDomainWindowType, url : string) {
    linkWindow({ win, domain: getDomainFromUrl(url) });
}

let windowOpen = window.open;

window.open = function windowOpenWrapper(url : string, name : string, options : string, last : mixed) : mixed {
    let win = windowOpen.call(this, normalizeMockUrl(url), name, options, last);

    if (!win) {
        return win;
    }

    linkWindow({ win, name, domain: url ? getDomainFromUrl(url) : null });

    return win;
};

export function destroyBridges() {
    for (let domain of bridgeFrames.keys()) {
        let frame = bridgeFrames.get(domain);
        if (frame && frame.parentNode) {
            frame.parentNode.removeChild(frame);
        }
    }
    bridgeFrames.reset();
    bridges.reset();
}
