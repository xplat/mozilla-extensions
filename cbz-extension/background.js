// background.js — background script (MV3, Firefox + Chrome)
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

// Fixed loopback address for the file server and config sentinel.
// 127.7.203.66 — all of 127.0.0.0/8 is loopback on Linux/macOS, this
// specific address is unlikely to conflict with anything real.
const LOOPBACK = '127.7.203.66';

// Current server coordinates from the native host. Null until host starts.
var serverPort  = null;
var serverToken = null;

function serverBase() {
  if (!serverPort || !serverToken) return null;
  return 'http://' + LOOPBACK + ':' + serverPort + '/' + serverToken;
}

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

// ── Config sentinel intercept ─────────────────────────────────────────────────
// The viewer fetches http://LOOPBACK/cbz-config (no port — port 80, which we
// never actually bind) just to trigger this interception. We redirect to a
// data: URL containing the current port and token. This lets the viewer get
// fresh server coordinates on every load without any chrome.* calls, so no
// ExtensionPageContextChild is created and Firefox won't close the tab on
// extension reload.

var SENTINEL_URL = 'http://' + LOOPBACK + '/cbz-config';

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    var cfg  = JSON.stringify({ port: serverPort, token: serverToken });
    var data = 'data:application/json,' + encodeURIComponent(cfg);
    return { redirectUrl: data };
  },
  { urls: [SENTINEL_URL], types: ['xmlhttprequest', 'other'] },
  ['blocking']
);

// ── HTTP/HTTPS CBZ interception ───────────────────────────────────────────────

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

var nativePort   = null;
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
    if (msg.event === 'server') {
      serverPort  = msg.port;
      serverToken = msg.token;
      return;
    }
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
    nativePort  = null;
    serverPort  = null;
    serverToken = null;
    var queue   = pendingQueue;
    pendingQueue = [];
    for (var i = 0; i < queue.length; i++) {
      clearTimeout(queue[i].timeoutId);
      queue[i].reject(new Error('Native host disconnected'));
    }
    setTimeout(function() { connectNative(); }, 3000);
  });
}

function handleNativeOpen(msg) {
  // src= is the file:// URL — clean, stable across extension reloads, no
  // server coordinates baked in. The viewer fetches cbz-config on load to
  // get the current port+token and derives the HTTP fetch URL from there.
  var fileUrl = 'file://' + msg.path.split('/').map(encodeURIComponent).join('/');
  chrome.tabs.create({ url: buildViewerUrl(fileUrl, msg.name, msg.page || 1) });
}

connectNative();
