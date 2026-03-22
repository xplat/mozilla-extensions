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

// ── Native messaging — file open from command line ────────────────────────────
//
// We maintain a single long-lived native port. The host polls the queue
// directory and sends {"event":"open",...} messages when cbz-open drops a
// request file. We also expose a message channel so viewer.js can request
// file chunks through the background (since content/viewer pages can't use
// native messaging directly).
//
// If the native host isn't installed, connectNative() will fail silently —
// the extension still works for http/https and the popup file picker.

var nativePort = null;

// Map of pending chunk requests: requestId -> {resolve, reject}
var pendingChunks = {};
var nextRequestId = 1;

function connectNative() {
  if (nativePort) return;

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    // Host not installed — that's fine, just no CLI support.
    nativePort = null;
    return;
  }

  nativePort.onMessage.addListener(function(msg) {
    if (msg.event === 'open') {
      // cbz-open dropped a file request; open the viewer.
      // The viewer will fetch file chunks via background messages.
      handleNativeOpen(msg);
    } else if (msg.status === 'ok' || msg.status === 'chunk' || msg.status === 'error') {
      // Response to a stat or read command — route to waiting promise.
      var id = msg._reqId;
      if (id && pendingChunks[id]) {
        if (msg.status === 'error') {
          pendingChunks[id].reject(new Error(msg.message));
        } else {
          pendingChunks[id].resolve(msg);
        }
        delete pendingChunks[id];
      }
    }
  });

  nativePort.onDisconnect.addListener(function() {
    nativePort = null;
    pendingChunks = {};
    // Reconnect after a short delay so we keep watching the queue
    // even if the host crashes or is restarted.
    setTimeout(connectNative, 3000);
  });
}

function sendNative(msg) {
  return new Promise(function(resolve, reject) {
    if (!nativePort) {
      reject(new Error('Native host not connected'));
      return;
    }
    var id = nextRequestId++;
    msg._reqId = id;
    pendingChunks[id] = { resolve: resolve, reject: reject };
    // Timeout after 30s to avoid leaking promises on host errors
    setTimeout(function() {
      if (pendingChunks[id]) {
        delete pendingChunks[id];
        reject(new Error('Native host timeout'));
      }
    }, 30000);
    nativePort.postMessage(msg);
  });
}

function handleNativeOpen(msg) {
  // msg = { event:"open", path:"/abs/path", name:"file.cbz", size:N, page:1 }
  // We encode the path as a special cbz-native: URL so the viewer knows to
  // request chunks via background messages rather than fetch().
  var encoded = 'cbz-native://' + encodeURIComponent(msg.path);
  var viewerUrl = buildViewerUrl(encoded, msg.name, msg.page || 1);
  chrome.tabs.create({ url: viewerUrl });
}

// ── Message relay from viewer page ───────────────────────────────────────────
// viewer.js sends chrome.runtime.sendMessage({type:'nativeStat'/'nativeRead'})
// and we forward to the native host, returning the response.

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.type === 'nativeStat') {
    sendNative({ cmd: 'stat', path: request.path })
      .then(function(r) { sendResponse({ ok: true, size: r.size, name: r.name }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true; // async
  }

  if (request.type === 'nativeRead') {
    sendNative({ cmd: 'read', path: request.path,
                 offset: request.offset, length: request.length })
      .then(function(r) { sendResponse({ ok: true, data: r.data, length: r.length }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true; // async
  }
});

// Start native connection at extension load
connectNative();
