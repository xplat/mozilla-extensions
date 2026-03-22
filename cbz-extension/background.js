// background.js — background script (works as MV3 service worker in Chrome,
// MV3 background script in Firefox via "scripts" key).
//
// Interception strategy:
//   1. webRequest.onHeadersReceived with blocking redirect handles both
//      http/https AND file:// navigations, firing before the browser decides
//      to download or render the response. This is the only reliable way to
//      intercept file:// CBZs in Firefox (which shows a save dialog otherwise).
//   2. webRequestBlocking is declared so Firefox allows the redirectUrl return.
//   3. Fragment-based detection (#cbz) is handled by content.js.

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

// Single blocking listener covering http, https, and file://
// Returning { redirectUrl } works in both Chrome MV3 (where blocking is
// allowed for extensions with host permissions) and Firefox MV3
// (which requires the webRequestBlocking permission declared in manifest).
chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    if (details.type !== 'main_frame') return {};
    if (isAlreadyViewer(details.url)) return {};

    // For file:// URLs the content-type header is set by the browser based on
    // file extension. A .cbz file will get application/zip or octet-stream.
    // We check the URL extension directly — that's sufficient and reliable.
    if (isCbzByUrl(details.url)) {
      return { redirectUrl: buildViewerUrl(details.url) };
    }

    // For http/https, also check the actual content-type header so we catch
    // servers that serve CBZ with a cbz-specific mime type, or zip mime + cbz URL.
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
      return { redirectUrl: buildViewerUrl(details.url) };
    }

    return {};
  },
  // file:// must be listed explicitly; <all_urls> covers it in Firefox but
  // we list all three schemes to be unambiguous.
  { urls: ['http://*/*', 'https://*/*', 'file:///*'], types: ['main_frame'] },
  ['blocking', 'responseHeaders']
);
