// native-messaging.js — shared native messaging plumbing for background scripts.
//
// Load via importScripts('native-messaging.js') after defining:
//   HOST_NAME        — string: native messaging host identifier
//   handleNativeOpen — function(msg): called when the host sends an 'open' event
//
// Provides into the service-worker global scope:
//   nativePort, pendingQueue, serverPort, serverToken, connectNative()
'use strict';

var nativePort   = null;
var pendingQueue = [];
var serverPort   = null;
var serverToken  = null;

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
