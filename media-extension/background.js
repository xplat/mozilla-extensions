// background.js — Media Viewer background script (MV3, Firefox)
'use strict';

const VIEWER_HTML = chrome.runtime.getURL('viewer.html');
const HOST_NAME   = 'media_viewer_host';

// Fixed loopback address distinct from the CBZ viewer's 127.7.203.66.
// All of 127.0.0.0/8 is loopback on Linux/macOS; this specific address is
// unlikely to conflict with anything real, and file paths won't leak off the
// machine if redirect handling has a bug.
const LOOPBACK = '127.7.203.98';

// Proxy URL prefixes used by the viewer.  The background rewrites every
// request to the real server URL (with port + token) on the fly, so neither
// the port nor the token ever appear in the viewer page or its URL.
const FILE_PROXY_PREFIX      = 'http://' + LOOPBACK + '/media-file/';
const DIR_PROXY_PREFIX       = 'http://' + LOOPBACK + '/media-dir/';
const THUMB_PROXY_PREFIX     = 'http://' + LOOPBACK + '/media-thumb/';
const QUEUE_DIR_PROXY_PREFIX = 'http://' + LOOPBACK + '/media-queue-dir/';

// ── Per-request proxy redirect ────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    // Only allow requests originating from our own extension pages.
    var origin = details.originUrl || details.documentUrl || '';
    if (!origin.startsWith(chrome.runtime.getURL(''))) {
      return { cancel: true };
    }

    if (!serverPort || !serverToken) {
      return { cancel: true };
    }

    var url = details.url;
    var encodedPath;

    if (url.startsWith(FILE_PROXY_PREFIX)) {
      encodedPath = url.slice(FILE_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-file/' + encodedPath
      };
    }

    if (url.startsWith(DIR_PROXY_PREFIX)) {
      encodedPath = url.slice(DIR_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-dir/' + encodedPath
      };
    }

    if (url.startsWith(THUMB_PROXY_PREFIX)) {
      encodedPath = url.slice(THUMB_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-thumb/' + encodedPath
      };
    }

    if (url.startsWith(QUEUE_DIR_PROXY_PREFIX)) {
      encodedPath = url.slice(QUEUE_DIR_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-queue-dir/' + encodedPath
      };
    }

    return { cancel: true };
  },
  {
    urls: [FILE_PROXY_PREFIX + '*', DIR_PROXY_PREFIX + '*',
           THUMB_PROXY_PREFIX + '*', QUEUE_DIR_PROXY_PREFIX + '*'],
    types: ['xmlhttprequest', 'image', 'media', 'other']
  },
  ['blocking']
);

// ── Native messaging ──────────────────────────────────────────────────────

function handleNativeOpen(msg) {
  // Build a file:// URL for the directory (stable, pasteable).
  // Encode each path segment so spaces/special chars are valid in the URL.
  var dirPath    = msg.dir  || '';
  var fileName   = msg.file || '';
  var encodedDir = dirPath.split('/').map(encodeURIComponent).join('/');
  var dirUrl     = 'file://' + encodedDir;

  var viewerUrl  = VIEWER_HTML + '?dir=' + encodeURIComponent(dirUrl);
  if (fileName) {
    viewerUrl += '&file=' + encodeURIComponent(fileName);
  }
  chrome.tabs.create({ url: viewerUrl });
}

// handleNativeOpen and HOST_NAME are defined above; load shared plumbing.
importScripts('native-messaging.js');
connectNative();
