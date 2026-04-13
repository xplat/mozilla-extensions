// native-messaging.js — shared native messaging plumbing for background scripts.
//
// Load via importScripts('native-messaging.js') after defining:
//   HOST_NAME        — string: native messaging host identifier
//   handleNativeOpen — function(msg): called when the host sends an 'open' event
//   LOOPBACK         — string: placeholder loopback address (in media-shared.js)
//
// Automatically:
//   - Sets up chrome.webRequest.onBeforeRequest listener to intercept proxy URLs
//   - Rewrites http://LOOPBACK/... URLs to http://HOST:PORT/TOKEN/...
//
// Provides into the service-worker global scope:
//   nativePort, pendingQueue, serverHost, serverPort, serverToken, connectNative()
//   rewriteProxyUrl(url) — rewrites proxy placeholder URLs to real server URLs
'use strict';

var nativePort   = null;
var pendingQueue = [];
var serverHost   = null;
var serverPort   = null;
var serverToken  = null;

// Validate that a host is a raw IP in loopback network (127.0.0.0/8)
function _isLoopbackIP(host) {
  var parts = String(host).split('.');
  if (parts.length !== 4) return false;
  if (parts[0] !== '127') return false;
  for (var i = 0; i < 4; i++) {
    var num = parseInt(parts[i], 10);
    if (isNaN(num) || num < 0 || num > 255) return false;
  }
  return true;
}

// Rewrite proxy placeholder URLs to real server URLs.
// Takes a URL like http://127.7.203.98/media-file/... and rewrites it to
// http://ACTUAL_HOST:PORT/TOKEN/media-file/...
function rewriteProxyUrl(url) {
  if (!serverHost || !serverPort || !serverToken) return null;
  if (!url.startsWith('http://' + LOOPBACK + '/')) return null;

  var path = url.slice(('http://' + LOOPBACK + '/').length);
  return 'http://' + serverHost + ':' + serverPort + '/' + serverToken + '/' + path;
}

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    nativePort = null;
    return;
  }

  // Register the extension's origin with the native host for CORS
  var origin = chrome.runtime.getURL('').slice(0, -1);  // strip trailing /
  nativePort.postMessage({ cmd: 'register-origin', origin: origin });

  nativePort.onMessage.addListener(function(msg) {
    if (msg.event === 'server') {
      if (!_isLoopbackIP(msg.host)) {
        console.error('Native host sent invalid loopback address:', msg.host);
        return;
      }
      serverHost  = msg.host;
      serverPort  = msg.port;
      serverToken = msg.token;
      if (typeof handleNativeServer !== 'undefined') handleNativeServer();
      return;
    }
    if (msg.event === 'open') {
      handleNativeOpen(msg);
      return;
    }
    if (msg.event === 'queue') {
      if (typeof handleNativeQueue !== 'undefined') handleNativeQueue(msg);
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
    serverHost  = null;
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

// Set up webRequest listener to intercept and rewrite proxy URLs.
// Call this after LOOPBACK has been defined.
function setupProxyRedirect() {
  chrome.webRequest.onBeforeRequest.addListener(
    function(details) {
      // Only allow requests originating from our own extension pages.
      var origin = details.originUrl || details.documentUrl || '';
      if (!origin.startsWith(chrome.runtime.getURL(''))) {
        return { cancel: true };
      }

      var realUrl = rewriteProxyUrl(details.url);
      if (realUrl) {
        return { redirectUrl: realUrl };
      }

      return { cancel: true };
    },
    {
      urls: ['http://' + LOOPBACK + '/*'],
      types: ['xmlhttprequest', 'image', 'media', 'other']
    },
    ['blocking']
  );
}
