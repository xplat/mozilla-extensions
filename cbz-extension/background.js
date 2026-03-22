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
  var url = VIEWER_HTML + '?src=' + encodeURIComponent(src);
  if (name) url += '&name=' + encodeURIComponent(name);
  if (page && page > 1) url += '&page=' + page;
  return url;
}

function isCbzByUrl(url) {
  try {
    var u = new URL(url);
    if (u.pathname.toLowerCase().endsWith('.cbz')) return true;
    var frag = u.hash;
    if (frag === '#cbz' || frag.startsWith('#cbz&') || frag.startsWith('#cbz=')) return true;
  } catch (e) {}
  return false;
}

function isAlreadyViewer(url) {
  return url.startsWith(VIEWER_HTML) || url.startsWith(chrome.runtime.getURL(''));
}

// ── webRequest interception (http/https) ──────────────────────────────────────
// file:// is not interceptable via webRequest in Firefox, so local files are
// opened directly as viewer tabs with src=file://... by handleNativeOpen.

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
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['blocking', 'responseHeaders']
);

// ── Native messaging ──────────────────────────────────────────────────────────

var nativePort = null;
var pendingQueue = [];

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

    var pending = pendingQueue.shift();
    if (!pending) return;
    clearTimeout(pending.timeoutId);

    if (msg.status === 'error') {
      pending.reject(new Error(msg.message || 'Native host error'));
    } else {
      pending.resolve(msg);
    }
  });

  nativePort.onDisconnect.addListener(function() {
    nativePort = null;
    var queue = pendingQueue;
    pendingQueue = [];
    for (var i = 0; i < queue.length; i++) {
      clearTimeout(queue[i].timeoutId);
      queue[i].reject(new Error('Native host disconnected'));
    }
    setTimeout(function() { connectNative(); }, 3000);
  });
}

function sendNative(msg) {
  return new Promise(function(resolve, reject) {
    if (!nativePort) {
      reject(new Error('Native host not connected'));
      return;
    }
    var timeoutId = setTimeout(function() {
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
  // Build a proper file:// URL from the path. Using the URL constructor
  // ensures special characters in the path are percent-encoded correctly.
  // We pass this as src= in the viewer URL. Tabs with src=file://... survive
  // extension reloads; tabs with src=cbz-native://... do not.
  // Page position is stored in the URL fragment by the viewer via
  // history.replaceState, so session restore preserves it automatically.
  // Construct a valid file:// URL by encoding each path segment individually.
  // msg.path is a raw filesystem path (e.g. "/home/user/My Comics/[Vol].cbz")
  // which may contain spaces, brackets, and other characters that are valid in
  // filenames but must be percent-encoded in URLs. We split on '/', encode each
  // segment with encodeURIComponent, then rejoin — this encodes everything that
  // needs encoding without double-encoding the '/' separators.
  var fileUrl = 'file://' + msg.path.split('/').map(encodeURIComponent).join('/');
  var page = msg.page || 1;
  chrome.tabs.create({ url: buildViewerUrl(fileUrl, msg.name, page) });
}

// ── Port-based message handler ───────────────────────────────────────────────
// Viewer pages connect via chrome.runtime.connect (long-lived port) so that
// if the background dies the port.onDisconnect fires on the viewer side,
// allowing it to reject pending promises and settle into an error state rather
// than hanging as "loading" (which causes Firefox to close the tab on reload).

chrome.runtime.onConnect.addListener(function(port) {
  if (port.name !== 'viewer') return;

  port.onMessage.addListener(function(request) {
    var id = request._id;

    function reply(msg) {
      // Port may have disconnected by the time we reply; guard against that.
      try { port.postMessage(Object.assign({ _id: id }, msg)); } catch (_) {}
    }

    if (request.type === 'nativeStat') {
      sendNative({ cmd: 'stat', path: request.path })
        .then(function(r) { reply({ ok: true, size: r.size, name: r.name }); })
        .catch(function(e) { reply({ error: e.message }); });
      return;
    }

    if (request.type === 'nativeRead') {
      sendNative({ cmd: 'read', path: request.path,
                   offset: request.offset, length: request.length })
        .then(function(r) { reply({ ok: true, data: r.data, length: r.length }); })
        .catch(function(e) { reply({ error: e.message }); });
      return;
    }
  });
});

connectNative();
