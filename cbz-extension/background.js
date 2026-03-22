// background.js — service worker (Manifest V3)
//
// Strategy:
//   1. webRequest.onHeadersReceived (non-blocking in MV3) reads content-type.
//      When a CBZ content-type is found, or an ambiguous zip mime on a .cbz URL,
//      we redirect via chrome.tabs.update.
//   2. webNavigation.onCommitted catches file:// URLs with .cbz extension.
//   3. Fragment-based detection (#cbz) is handled entirely by content.js.

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

function buildViewerUrl(originalUrl) {
  return VIEWER_HTML + '?src=' + encodeURIComponent(originalUrl);
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

// HTTP/HTTPS: intercept by content-type header
chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    if (details.type !== 'main_frame') return;
    if (isAlreadyViewer(details.url)) return;

    var contentType = '';
    var headers = details.responseHeaders || [];
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].name.toLowerCase() === 'content-type') {
        contentType = headers[i].value.toLowerCase().split(';')[0].trim();
        break;
      }
    }

    var isCbzMime = CBZ_MIME_TYPES.has(contentType);
    var isAmbiguous = AMBIGUOUS_MIME_TYPES.has(contentType);

    if (isCbzMime || (isAmbiguous && isCbzByUrl(details.url))) {
      chrome.tabs.update(details.tabId, { url: buildViewerUrl(details.url) });
    }
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders']
);

// file:// URLs: intercept by path extension via webNavigation
chrome.webNavigation.onCommitted.addListener(function(details) {
  if (details.frameId !== 0) return;
  var url = details.url;
  if (!url.startsWith('file://')) return;
  if (isAlreadyViewer(url)) return;
  if (isCbzByUrl(url)) {
    chrome.tabs.update(details.tabId, { url: buildViewerUrl(url) });
  }
});
