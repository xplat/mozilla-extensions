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

// Fixed loopback address. All of 127.0.0.0/8 is loopback on Linux/macOS;
// this specific address is unlikely to conflict with anything real, and
// file paths won't leak off the machine if redirect handling has a bug.
const LOOPBACK = '127.7.203.66';

// Proxy URL prefix that the viewer uses for all file reads.
// The background rewrites these to the real server URL on every request,
// so port/token changes (after extension update/restart) take effect
// immediately without any reload.
const PROXY_PREFIX = 'http://' + LOOPBACK + '/cbz-file/';

var serverPort  = null;
var serverToken = null;

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

// ── Per-request proxy redirect ────────────────────────────────────────────────
// The viewer fetches http://127.7.203.66/cbz-file/<encoded-path> for every
// read (Range or full). We intercept and rewrite to the real server URL using
// the current port and token. This is fully synchronous — no async work needed
// since port/token are already in memory. This means:
//   - No chrome.* calls in the viewer (no ExtensionPageContextChild)
//   - Post-update navigation works immediately (new port/token used at once)
//   - No separate config-fetch roundtrip on load

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (!serverPort || !serverToken) {
      // Native host not connected yet — let the request fail naturally
      return {};
    }
    // Rewrite: strip PROXY_PREFIX, prepend real server base
    var encodedPath = details.url.slice(PROXY_PREFIX.length);
    var realUrl = 'http://' + LOOPBACK + ':' + serverPort +
                  '/' + serverToken + '/' + encodedPath;
    return { redirectUrl: realUrl };
  },
  { urls: [PROXY_PREFIX + '*'], types: ['xmlhttprequest', 'other'] },
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
  // src= is the proxy URL — stable, no port/token, works across restarts.
  // Encode each path segment so spaces/brackets etc. are valid in the URL.
  var encodedPath = msg.path.split('/').map(encodeURIComponent).join('/');
  var proxyUrl = PROXY_PREFIX + encodedPath;
  // Store file:// URL as src so the tab URL is familiar and session-restore
  // friendly. The viewer maps it to a proxy URL for fetching.
  var fileUrl = 'file://' + encodedPath;
  chrome.tabs.create({ url: buildViewerUrl(fileUrl, msg.name, msg.page || 1) });
}

connectNative();
