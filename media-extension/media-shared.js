// media-shared.js — constants and helpers shared between background.js and viewer.js.
//
// Loaded via manifest background.scripts (before background.js) and via a plain
// <script> tag in viewer.html (before viewer.js).  Must use only web platform
// APIs — no chrome.* / browser.* — so that viewer pages can load it safely.
'use strict';

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

// localStorage keys shared across background and viewer scripts.
const LS_VOLUME  = 'media-volume';
const LS_MUTED   = 'media-muted';
const LS_BALANCE = 'media-balance';
const LS_AQ      = 'media-audio-queue';
const LS_VQ      = 'media-video-queue';

/**
 * Convert a file:// URL to a proxy URL that the background's webRequest
 * listener will rewrite to the real server endpoint.
 * @param {string} fileUrl
 * @returns {string}
 */
function toProxyFile(fileUrl) {
  var path    = fileUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return FILE_PROXY_PREFIX + encoded;
}

// ── Shared Web Audio state ────────────────────────────────────────────────
//
// One AudioContext and StereoPannerNode are shared across all audio output in
// a given script context (background or viewer tab).  Each caller wires its
// own HTMLMediaElements into the graph via createMediaElementSource(el).connect(_panNode);
// that part is intentionally left to the caller because createMediaElementSource
// is one-shot per element and the set of elements differs between contexts.

var _panValue = parseFloat(localStorage.getItem(LS_BALANCE) || '0');
/** @type {AudioContext | null} */
var _audioCtx = null;
/** @type {StereoPannerNode | null} */
var _panNode  = null;

/**
 * Ensure the AudioContext + StereoPannerNode chain exists.  No-op if already
 * created; resumes a suspended context (browser autoplay policy on web pages).
 * Callers should invoke this before any createMediaElementSource() call and
 * before playing audio that needs to be routed through the panner.
 * @returns {asserts _panNode is StereoPannerNode}
 */
function _ensureAudioContext() {
  if (_audioCtx) {
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(function() {});
    return;
  }
  _audioCtx = new AudioContext();
  _panNode  = _audioCtx.createStereoPanner();
  _panNode.pan.value = _panValue;
  _panNode.connect(_audioCtx.destination);
}

/**
 * Apply an av-settings broadcast payload to an HTMLMediaElement and the
 * shared panner.  All three properties are optional; absent ones are skipped.
 * @param {HTMLMediaElement} mediaEl
 * @param {{volume?: number, muted?: boolean, balance?: number}} d
 * @returns {void}
 */
function applyAvSettings(mediaEl, d) {
  if (d.volume  !== undefined) mediaEl.volume = d.volume;
  if (d.muted   !== undefined) mediaEl.muted  = d.muted;
  if (d.balance !== undefined) {
    _panValue = d.balance;
    if (_panNode) _panNode.pan.value = _panValue;
  }
}

/**
 * Initialise an HTMLMediaElement's volume and mute state from localStorage,
 * falling back to full volume / unmuted if no values have been saved yet.
 * @param {HTMLMediaElement} mediaEl
 * @returns {void}
 */
function initMediaElVolume(mediaEl) {
  mediaEl.volume = parseFloat(localStorage.getItem(LS_VOLUME) || '1');
  mediaEl.muted  = localStorage.getItem(LS_MUTED) === 'true';
}
