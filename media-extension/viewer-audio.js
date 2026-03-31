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
//   playAndAnnounce,
//   togglePlayPause, toggleMute, adjustVolume, adjustBalance.
//
// Calls into globals defined in earlier / later modules:
//   applyAvSettings, _panValue, _panNode, _ensureAudioContext,  (media-shared.js)
//   activeMediaEl, _updateVideoControls,                        (viewer.js)
//   updateQueueChannelWiring.                                   (viewer-queue-mgt.js)

// True after we've broadcast 'pause' to other tabs; cleared on stop/end.
var _hasAnnounced = false;

// ── BroadcastChannel infrastructure ──────────────────────────────────────────
//
// Sends always use ephemeral create-post-close objects (_bcPost) so a tab is
// never woken up by its own messages.
//
// _mediaListenCh ('media-viewer') is opened and closed dynamically by
// _updateChannelWiring(); a tab that has nothing to receive keeps no channel
// open and causes zero wakeups.
//
// _queueListenCh ('media-queue') is owned by viewer-queue-mgt.js and managed
// via updateQueueChannelWiring(), called from _updateChannelWiring() here.

function _bcPost(name, msg) {
  var ch = new BroadcastChannel(name);
  ch.postMessage(msg);
  ch.close();
}

var _mediaListenCh = null;

function _onMediaMsg(e) {
  if (!e.data) return;
  var cmd = e.data.cmd;
  if (cmd === 'pause') {
    // Another tab started playing and wants everyone else to stop.
    if (activeMediaEl && !activeMediaEl.paused) activeMediaEl.pause();
    // Yield the baton — we are no longer the active player.
    if (_hasAnnounced) {
      _hasAnnounced = false;
      _updateChannelWiring();  // may close channel now that baton is yielded
    }
  } else if (cmd === 'pause-toggle') {
    // A tab with no active media is asking whoever holds the baton to toggle.
    // Must work whether we are currently playing OR paused (e.g. remotely paused).
    if (activeMediaEl) togglePlayPause();
  } else if (cmd === 'av-settings') {
    var d = e.data;
    // The sender should already have done this once and for all:
    // if (d.volume  !== undefined) localStorage.setItem('media-volume',  String(d.volume));
    // if (d.muted   !== undefined) localStorage.setItem('media-muted',   String(d.muted));
    // if (d.balance !== undefined) localStorage.setItem('media-balance', String(d.balance));
    if (activeMediaEl) {
      applyAvSettings(activeMediaEl, d);
      _updateVideoControls();
    }
  }
}

// Recalculate which listener channels should be open and open/close as needed.
// Idempotent — safe to call on every relevant state change.
function _updateChannelWiring() {
  var visible = document.visibilityState === 'visible';
  var playing = !!(activeMediaEl && !activeMediaEl.paused);

  // Keep the channel open while playing, while holding the baton (_hasAnnounced),
  // or while foregrounded with active media (so av-settings display stays live).
  var needMedia = playing || _hasAnnounced || (visible && activeMediaEl !== null);
  if (needMedia && !_mediaListenCh) {
    _mediaListenCh = new BroadcastChannel('media-viewer');
    _mediaListenCh.onmessage = _onMediaMsg;
  } else if (!needMedia && _mediaListenCh) {
    _mediaListenCh.close();
    _mediaListenCh = null;
  }

  updateQueueChannelWiring(visible);
}

// On visibility change: re-apply persisted A/V settings (may have drifted while
// hidden), then rewire channels for the new visibility state.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && activeMediaEl) {
    loadAvSettings();
  }
  _updateChannelWiring();
});

function loadAvSettings() {
  applyAvSettings(activeMediaEl, {
    volume:  parseFloat(localStorage.getItem('media-volume')  || '1'),
    muted:   localStorage.getItem('media-muted')  === 'true',
    balance: parseFloat(localStorage.getItem('media-balance') || '0'),
  });
  _updateVideoControls();
}

// ── A/V control helpers ───────────────────────────────────────────────────────

// Start playback on el.  If el has audio tracks and we don't already hold the
// baton, announce to other tabs and acquire it.  Autoplay rejections are
// silenced, matching the .catch(function(){}) convention at all other play sites.
// Call this instead of el.play().catch() whenever the element might have audio.
function playAndAnnounce(el) {
  el.play().then(function() {
    if (_hasAnnounced) return;
    var tracks = el.audioTracks;
    if (tracks ? tracks.length > 0 : el.mozHasAudio) {
      _hasAnnounced = true;
      _updateChannelWiring();
      // we now have a broadcast channel open and listening.
      // broadcast on it so we don't hear our own broadcast.
      _mediaListenCh.postMessage({ cmd: 'pause' });
    }
  }).catch(function() {});
}

function togglePlayPause() {
  if (!activeMediaEl) return;
  if (activeMediaEl.ended) {
    activeMediaEl.currentTime = 0;
    playAndAnnounce(activeMediaEl);
  } else if (activeMediaEl.paused) {
    playAndAnnounce(activeMediaEl);
  } else {
    activeMediaEl.pause();
  }
  _updateVideoControls();
}

function toggleMute() {
  var muted;
  if (activeMediaEl) {
    activeMediaEl.muted = !activeMediaEl.muted;
    muted = activeMediaEl.muted;
  } else {
    muted = !(localStorage.getItem('media-muted') === 'true');
  }
  localStorage.setItem('media-muted', String(muted));
  _bcPost('media-viewer', { cmd: 'av-settings', muted: muted });
  _updateVideoControls();
}

// Adjust volume by dBDelta decibels.  Using dB steps gives perceptually uniform
// increments (~1.5 dB ≈ a just-noticeable loudness change; ~20 steps full→silence).
function adjustVolume(dBDelta) {
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
  if (activeMediaEl) {
    activeMediaEl.volume = vol;
    activeMediaEl.muted  = false;
  }
  localStorage.setItem('media-volume', String(vol));
  localStorage.setItem('media-muted',  'false');
  _bcPost('media-viewer', { cmd: 'av-settings', volume: vol, muted: false });
  _updateVideoControls();
}

function adjustBalance(delta) {
  _panValue = +Math.max(-1, Math.min(1, _panValue + delta)).toFixed(1);
  _panNode.pan.value = _panValue;
  _ensureAudioContext();  // resume if suspended
  localStorage.setItem('media-balance', String(_panValue));
  _bcPost('media-viewer', { cmd: 'av-settings', balance: _panValue });
  _updateVideoControls();
}
