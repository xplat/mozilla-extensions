// bridge-worker.js — Web Worker that owns the extension port
// Runs as a Worker (not in a page window), so its ExtensionPageContextChild
// has a rootWindow of WorkerGlobalScope, not the viewer tab's window.
// Firefox extension shutdown therefore destroys this worker context without
// closing the tab.
//
// Protocol with viewer.js (via postMessage):
//   viewer → worker:  { _id, type, ...args }
//   worker → viewer:  { _id, ...result } or { _bridgeDisconnect: true }

'use strict';

let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'viewer' });

  port.onMessage.addListener(msg => {
    postMessage(msg);
  });

  port.onDisconnect.addListener(() => {
    postMessage({ _bridgeDisconnect: true });
    port = null;
  });
}

onmessage = e => {
  const msg = e.data;
  if (!port) {
    postMessage({ _id: msg._id, error: 'Background not connected' });
    return;
  }
  try {
    port.postMessage(msg);
  } catch (err) {
    postMessage({ _id: msg._id, error: err.message });
  }
};

connect();
