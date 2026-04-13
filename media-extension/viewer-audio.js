'use strict';
// ── viewer-audio.js ───────────────────────────────────────────────────────────
//
// Cross-tab media baton (BroadcastChannel 'media-viewer') and A/V control
// helpers: mute, volume, balance, play/pause.
//
// Declares these globals used by other modules:
//   _hasAnnounced,
//   _bcPost,
//   _mediaListenCh, _updateChannelWiring,
//   avSettingsWatcher,
//   playAndAnnounce,
//   togglePlayPause, toggleMute, adjustVolume, adjustBalance.
//
// Calls into globals defined in earlier / later modules:
//   applyAvSettings, _panValue, _panNode, _ensureAudioContext,  (media-shared.js)
//   updateQueueChannelWiring.                                   (viewer-queue-mgt.js)
//   WatchableEventTarget.                                       (viewer-util.js)
//   audioEl, audioPlaceholderEl.                               (viewer-media-audio.js)

import { WatchableEventTarget } from './viewer-util.js';

// True after we've broadcast 'pause' to other tabs; cleared on stop/end.
let _hasAnnounced = false;

// Watchable event target for A/V settings changes.  Other tabs subscribe to
// know when to fetch and apply persisted settings.
export const avSettingsWatcher = new WatchableEventTarget();

function _emitAvSettingsChange() {
  avSettingsWatcher.dispatchEvent(new Event('avSettingsChange'));
}

// ── BroadcastChannel infrastructure ──────────────────────────────────────────
//
// _mediaListenCh ('media-viewer') is opened and closed dynamically by
// _updateChannelWiring(); a tab that has nothing to receive keeps no channel
// open and causes zero wakeups.

const CHANNEL = 'media-viewer';

/** @type {BroadcastChannel | null} */
let _mediaListenCh = null;

/**
 * Post a message to all listening tabs on the media-viewer channel.
 * Uses an ephemeral channel if we don't already have one open.
 * @param {Object} msg - The message to broadcast
 */
function _bcPost(msg) {
  if (_mediaListenCh !== null) {
    return _mediaListenCh.postMessage(msg);
  }
  var ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(msg);
  ch.close();
}


/**
 * Handle incoming BroadcastChannel messages from other tabs.
 * Routes between pause notifications, pause-toggle requests, and A/V settings updates.
 * @param {MessageEvent} e - The broadcast message event
 */
function _onMediaMsg(e) {
  if (!e.data) return;
  var cmd = e.data.cmd;
  if (cmd === 'pause') {
    // Another tab started playing and wants everyone else to stop.
    if (batonHolder && !batonHolder.paused) batonHolder.pause();
    // Yield the baton — we are no longer the active player.
    if (_hasAnnounced) {
      _hasAnnounced = false;
      batonHolder = null;
      _updateChannelWiring();  // may close channel now that baton is yielded
    }
  } else if (cmd === 'pause-toggle') {
    // A tab with no active media is asking whoever holds the baton to toggle.
    // Must work whether we are currently playing OR paused (e.g. remotely paused).
    if (batonHolder) togglePlayPause();
  } else if (cmd === 'av-settings') {
    var d = e.data;
    // The sender should already have done this once and for all:
    // if (d.volume  !== undefined) localStorage.setItem('media-volume',  String(d.volume));
    // if (d.muted   !== undefined) localStorage.setItem('media-muted',   String(d.muted));
    // if (d.balance !== undefined) localStorage.setItem('media-balance', String(d.balance));
    if (batonHolder) {
      applyAvSettings(batonHolder, d);
      _emitAvSettingsChange();
    }
  }
}

// Recalculate which listener channels should be open and open/close as needed.
// Idempotent — safe to call on every relevant state change.
export function _updateChannelWiring() {
  var visible = document.visibilityState === 'visible';

  var needMedia = _hasAnnounced || (avSettingsWatcher.watched() && visible);
  if (needMedia && !_mediaListenCh) {
    _mediaListenCh = new BroadcastChannel(CHANNEL);
    _mediaListenCh.onmessage = _onMediaMsg;
  } else if (!needMedia && _mediaListenCh) {
    _mediaListenCh.close();
    _mediaListenCh = null;
  }
}

// On visibility change: re-apply persisted A/V settings (may have drifted while
// hidden), then rewire channels for the new visibility state.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    _emitAvSettingsChange();
  }
  _updateChannelWiring();
});

/**
 * Load and apply A/V settings from localStorage to a media element.
 * @param {HTMLMediaElement} el - Media element to configure
 */
export function loadAvSettings(el) {
  applyAvSettings(el, {
    volume:  parseFloat(localStorage.getItem('media-volume')  || '1'),
    muted:   localStorage.getItem('media-muted')  === 'true',
    balance: parseFloat(localStorage.getItem('media-balance') || '0'),
  });
}

// ── Web Audio API wiring ──────────────────────────────────────────────────────
// Hook called by modules that own media elements to wire them into the stereo
// balance (pan) system. _panValue, _audioCtx, _panNode are defined in media-shared.js.

/**
 * Wire a media element into the stereo balance (pan) system.
 * @param {HTMLMediaElement} mediaEl - Media element to wire
 */
export function wireMediaElement(mediaEl) {
  _ensureAudioContext();
  try {
    (/** @type {AudioContext} */ (_audioCtx)).createMediaElementSource(mediaEl).connect(/** @type {StereoPannerNode} */ (_panNode));
  } catch (err) {
    console.warn('createMediaElementSource failed:', err);
  }
}

// ── A/V state accessors ────────────────────────────────────────────────────────
// Query current audio/video settings without exposing localStorage implementation.

export function getAudioVolume() {
  return parseFloat(localStorage.getItem('media-volume') || '1');
}

export function isAudioMuted() {
  return localStorage.getItem('media-muted') === 'true';
}

export function getAudioBalance() {
  return parseFloat(localStorage.getItem('media-balance') || '0');
}

// ── A/V control helpers ───────────────────────────────────────────────────────

/** @type {HTMLMediaElement | null} - The element currently holding playback baton */
let batonHolder = null;

/**
 * Start playback on a media element. If it has audio tracks and we don't already
 * hold the baton, announce to other tabs and acquire it. Autoplay rejections are
 * silenced, matching the .catch(function(){}) convention at all other play sites.
 * Call this instead of el.play().catch() whenever the element might have audio.
 * @param {HTMLMediaElement} el - The media element to play
 */
export function playAndAnnounce(el) {
  el.play().then(function() {
    /* tsc's type info for media elements doesn't include the fields we're using */
    let tracks = (/** @type {any} */ (el)).audioTracks;
    if (tracks ? tracks.length > 0 : (/** @type {any} */ (el)).mozHasAudio) {
      batonHolder = el;
      if (!_hasAnnounced) {
        _hasAnnounced = true;
        _updateChannelWiring();
        _bcPost({ cmd: 'pause' });
      }
      el.addEventListener('ended', _onMediaEnded);
    }
  }).catch(function() {});
}

// XXX need to more consistently drop/pick up baton on pause/play ...

/**
 * Handle media 'ended' event. Yields the baton if we were the active player.
 * @this {HTMLMediaElement}
 */
function _onMediaEnded() {
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _bcPost({ cmd: 'media-stopped' });
  }
  _updateChannelWiring();  // no longer playing
  this.removeEventListener('ended', _onMediaEnded);
}

/**
 * Drop the audio baton if the given element currently holds it.
 * @param {HTMLMediaElement} el - The media element that may hold the baton
 */
export function dropAudioBaton(el) {
  if (!batonHolder || el !== batonHolder) return;
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _bcPost({ cmd: 'media-stopped' });
  }
}

export function togglePlayPause() {
  if (!batonHolder) return;
  if (batonHolder.ended) {
    batonHolder.currentTime = 0;
    playAndAnnounce(batonHolder);
  } else if (batonHolder.paused) {
    playAndAnnounce(batonHolder);
  } else {
    batonHolder.pause();
  }
}

// Handle 'p' key press: toggle playback locally or forward to other tabs
export function handlePlayPauseKey() {
  if (batonHolder) {
    togglePlayPause();
  } else {
    // No local media — forward to whichever other tab holds the baton.
    _bcPost({ cmd: 'pause-toggle' });
  }
}

export function toggleMute() {
  var muted;
  if (batonHolder) {
    batonHolder.muted = !batonHolder.muted;
    muted = batonHolder.muted;
  } else {
    muted = !(localStorage.getItem('media-muted') === 'true');
  }
  localStorage.setItem('media-muted', String(muted));
  _bcPost({ cmd: 'av-settings', muted: muted });
  _emitAvSettingsChange();
}

/**
 * Adjust volume by dBDelta decibels. Using dB steps gives perceptually uniform
 * increments (~1.5 dB ≈ a just-noticeable loudness change; ~20 steps full→silence).
 * @param {number} dBDelta - Volume adjustment in decibels
 */
export function adjustVolume(dBDelta) {
  var current = parseFloat(localStorage.getItem('media-volume') || '1');
  var vol;
  if (current <= 0) {
    // At zero, stepping up goes to a minimal audible level (~-40 dB).
    vol = (dBDelta > 0) ? Math.pow(10, -40 / 20) : 0;
  } else {
    var newdB = 20 * Math.log10(current) + dBDelta;
    vol = (newdB <= -40) ? 0 : Math.min(1, Math.pow(10, newdB / 20));
  }
  vol = +vol.toFixed(4);
  if (batonHolder) {
    batonHolder.volume = vol;
    batonHolder.muted  = false;
  }
  localStorage.setItem('media-volume', String(vol));
  localStorage.setItem('media-muted',  'false');
  _bcPost({ cmd: 'av-settings', volume: vol, muted: false });
  _emitAvSettingsChange();
}

/**
 * Adjust stereo balance (pan) by the given delta, clamped to [-1, 1].
 * @param {number} delta - Pan adjustment increment
 */
export function adjustBalance(delta) {
  _panValue = +Math.max(-1, Math.min(1, _panValue + delta)).toFixed(1);
  _ensureAudioContext();  // resume if suspended
  (/** @type {StereoPannerNode} */ (_panNode)).pan.value = _panValue;
  localStorage.setItem('media-balance', String(_panValue));
  _bcPost({ cmd: 'av-settings', balance: _panValue });
  _emitAvSettingsChange();
}
