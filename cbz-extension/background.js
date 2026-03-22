// background.js — background script
// Works as MV3 service worker in Chrome; MV3 background script in Firefox.

'use strict';

const CBZ_MIME_TYPES = new Set([
  'application/vnd.comicbook+zip',
  'application/x-cbz',
  'application/cbz',
]);

const AMBIGUOUS_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'application/x-zip',
  'application/zip-compressed',
]);

const VIEWER_HTML = chrome.runtime.getURL('viewer.html');
const HOST_NAME   = 'cbz_viewer_host';

function buildViewerUrl(src, name, page) {
  let url = VIEWER_HTML + '?src=' + encodeURIComponent(src);
  if (name) url += '&name=' + encodeURIComponent(name);
  if (page && page > 1) url += '&page=' + page;
  return url;
}

function isCbzByUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.toLowerCase().endsWith('.cbz')) return true;
    const frag = u.hash;
    if (frag === '#cbz' || frag.startsWith('#cbz&') || frag.startsWith('#cbz=')) return true;
  } catch (e) {}
  return false;
}

function isAlreadyViewer(url) {
  return url.startsWith(VIEWER_HTML) || url.startsWith(chrome.runtime.getURL(''));
}

// ── webRequest interception (http/https/file) ─────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    if (details.type !== 'main_frame') return {};
    if (isAlreadyViewer(details.url)) return {};

    if (isCbzByUrl(details.url)) {
      return { redirectUrl: buildViewerUrl(details.url, null, null) };
    }

    var contentType = '';
    var headers = details.responseHeaders || [];
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].name.toLowerCase() === 'content-type') {
        contentType = headers[i].value.toLowerCase().split(';')[0].trim();
        break;
      }
    }

    if (CBZ_MIME_TYPES.has(contentType) ||
        (AMBIGUOUS_MIME_TYPES.has(contentType) && isCbzByUrl(details.url))) {
      return { redirectUrl: buildViewerUrl(details.url, null, null) };
    }

    return {};
  },
  { urls: ['http://*/*', 'https://*/*', 'file:///*'], types: ['main_frame'] },
  ['blocking', 'responseHeaders']
);

// ── Popup file picker blob store ──────────────────────────────────────────────
// The popup reads the file into an ArrayBuffer and sends it here for safe-
// keeping. The viewer tab retrieves it by token, then we discard it.
// Tokens are random so they can't be guessed by other pages.

var blobStore = {};  // token -> { buffer: ArrayBuffer, name: string }

// ── Native messaging ──────────────────────────────────────────────────────────

var nativePort = null;

// Pending requests: id -> { resolve, reject, timeoutId }
// The id is assigned HERE and kept only in this map; it is NOT sent to the
// native host (which would have to echo it back). Instead we use the fact
// that native messaging is strictly sequential on a single port — each
// postMessage gets exactly one response before the next is sent.
// We therefore use a simple FIFO queue rather than IDs.
var pendingQueue = [];   // [ { resolve, reject, timeoutId }, ... ]

function connectNative() {
  if (nativePort) return;

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    nativePort = null;
    return;
  }

  nativePort.onMessage.addListener(function(msg) {
    if (msg.event === 'open') {
      handleNativeOpen(msg);
      return;
    }

    // Every other message is a response to the oldest pending request.
    var pending = pendingQueue.shift();
    if (!pending) return; // spurious message, ignore

    clearTimeout(pending.timeoutId);

    if (msg.status === 'error') {
      pending.reject(new Error(msg.message || 'Native host error'));
    } else {
      pending.resolve(msg);
    }
  });

  nativePort.onDisconnect.addListener(function() {
    nativePort = null;
    // Reject any requests that were in flight
    var queue = pendingQueue;
    pendingQueue = [];
    for (var i = 0; i < queue.length; i++) {
      clearTimeout(queue[i].timeoutId);
      queue[i].reject(new Error('Native host disconnected'));
    }
    setTimeout(connectNative, 3000);
  });
}

function sendNative(msg) {
  return new Promise(function(resolve, reject) {
    if (!nativePort) {
      reject(new Error('Native host not connected'));
      return;
    }
    var timeoutId = setTimeout(function() {
      // Remove from queue so later responses don't mis-route
      var idx = pendingQueue.findIndex(function(p) { return p.timeoutId === timeoutId; });
      if (idx !== -1) {
        pendingQueue.splice(idx, 1);
        reject(new Error('Native host timeout'));
      }
    }, 30000);
    pendingQueue.push({ resolve: resolve, reject: reject, timeoutId: timeoutId });
    nativePort.postMessage(msg);
  });
}

function handleNativeOpen(msg) {
  var encoded = 'cbz-native://' + encodeURIComponent(msg.path);
  chrome.tabs.create({ url: buildViewerUrl(encoded, msg.name, msg.page || 1) });
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {

  // Popup stores a file buffer here before opening the viewer tab
  if (request.type === 'storeBlob') {
    blobStore[request.token] = { buffer: request.buffer, name: request.name };
    sendResponse({ ok: true });
    return false;
  }

  // Viewer tab claims the buffer by token (cbz-blob:// src)
  if (request.type === 'claimBlob') {
    var entry = blobStore[request.token];
    if (entry) {
      delete blobStore[request.token];
      sendResponse({ ok: true, buffer: entry.buffer, name: entry.name });
    } else {
      sendResponse({ ok: false, error: 'Blob token not found (already claimed or expired)' });
    }
    return false;
  }

  // Viewer requests a stat or read from the native host
  if (request.type === 'nativeStat') {
    sendNative({ cmd: 'stat', path: request.path })
      .then(function(r) { sendResponse({ ok: true, size: r.size, name: r.name }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  if (request.type === 'nativeRead') {
    sendNative({ cmd: 'read', path: request.path,
                 offset: request.offset, length: request.length })
      .then(function(r) { sendResponse({ ok: true, data: r.data, length: r.length }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
});

connectNative();
