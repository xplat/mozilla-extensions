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

function handleNativeOpen(msg) {
  // Encode each path segment so spaces/brackets etc. are valid in the URL.
  // Store file:// URL as src so the tab URL is familiar and session-restore
  // friendly. The viewer maps it to a proxy URL for fetching.
  var encodedPath = msg.path.split('/').map(encodeURIComponent).join('/');
  var fileUrl = 'file://' + encodedPath;
  chrome.tabs.create({ url: buildViewerUrl(fileUrl, msg.name, msg.page || 1) });
}

// handleNativeOpen and HOST_NAME are defined above; load shared plumbing.
// importScripts is only available in service-worker contexts (Chrome MV3);
// in Firefox MV3 event-page contexts it is undefined, and native-messaging.js
// is instead listed first in the manifest's background.scripts array.
if (typeof importScripts !== 'undefined') importScripts('native-messaging.js');
setupProxyRedirect();
connectNative();
