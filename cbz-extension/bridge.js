// bridge.js — runs inside a hidden moz-extension:// iframe embedded in viewer.html
//
// This iframe exists solely to own the ExtensionPageContextChild so that
// the parent viewer tab (which has no chrome.* calls of its own) is not
// recorded in Firefox's extension context map and therefore not closed when
// the extension reloads.
//
// Protocol (postMessage between parent and iframe):
//   Parent → iframe:  { _id: number, type: string, ...args }
//   iframe → parent:  { _id: number, ok: bool, ...result } or { _id: number, error: string }
//
// The iframe connects to the background via chrome.runtime.connect and relays.

'use strict';

const parent = window.parent;
const port   = chrome.runtime.connect({ name: 'viewer' });

// Relay background → parent
port.onMessage.addListener(msg => {
  parent.postMessage({ _bridgeReply: true, ...msg }, '*');
});

// If background disconnects, tell parent so it can recreate the iframe
port.onDisconnect.addListener(() => {
  parent.postMessage({ _bridgeDisconnect: true }, '*');
});

// Tell parent the bridge is live and ready to relay
parent.postMessage({ _bridgeReady: true, _bridgeInit: true }, '*');

// Relay parent → background
window.addEventListener('message', e => {
  if (e.source !== parent) return;
  const msg = e.data;
  if (!msg || msg._bridgeReply || msg._bridgeDisconnect) return;
  try {
    port.postMessage(msg);
  } catch (_) {
    // Port already dead; disconnect message will handle it
  }
});
