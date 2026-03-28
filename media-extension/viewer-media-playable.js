'use strict';
// ── viewer-media-playable.js ──────────────────────────────────────────────────
//
// Common audio+video playback infrastructure: autoplay flag, seek, saved-position
// persistence, controls HUD, transition cover, and stop/tear-down.
//
// Declares these globals used by other modules:
//   _autoplay, _posCheckpointTimer,
//   _clearPosCheckpoint,
//   _posKey, _savePosition, _getSavedPosition, _clearSavedPosition,
//   fmtTime, _updateVideoControls,
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia,
//   toggleAutoplay, seekRelative,
//   videoProgressEl, videoSeekFillEl, videoTimeEl, videoVolEl.
//
// Calls into globals defined in earlier / later modules:
//   imagePaneEl,                                     (viewer-ui.js)
//   _hasAnnounced, _bcPost, _updateChannelWiring,    (viewer-audio.js)
//   _panValue,                                       (media-shared.js)
//   activeMediaEl, _contentPath,                     (viewer.js)
//   _pendingAutoFS, _pendingQueuePlay, _shouldAnnounce, (viewer.js)
//   transitionCoverEl, mainImageEl, mediaErrorEl.    (viewer.js)

// ── HUD DOM refs ──────────────────────────────────────────────────────────────

var videoProgressEl = document.getElementById('video-progress');
var videoSeekFillEl = document.getElementById('video-seek-fill');
var videoTimeEl     = document.getElementById('video-time');
var videoVolEl      = document.getElementById('video-vol');

// ── Autoplay flag and position-checkpoint timer ───────────────────────────────

var _autoplay           = true;  // if false, media loads but does not start playing
var _posCheckpointTimer = null;  // setTimeout handle for position-save throttle

function _clearPosCheckpoint() {
  if (_posCheckpointTimer !== null) {
    clearTimeout(_posCheckpointTimer);
    _posCheckpointTimer = null;
  }
}

// ── Position persistence ──────────────────────────────────────────────────────

function _posKey(fileUrl) {
  return 'media-pos:' + fileUrl.replace(/^file:\/\//, '');
}

function _savePosition(mediaEl) {
  if (!_contentPath || mediaEl.paused || mediaEl.ended) return;
  if (imagePaneEl.classList.contains('media-gif')) return;
  localStorage.setItem(_posKey(_contentPath), String(mediaEl.currentTime));
}

function _getSavedPosition(fileUrl) {
  var raw = localStorage.getItem(_posKey(fileUrl));
  return raw ? parseFloat(raw) : 0;
}

function _clearSavedPosition(fileUrl) {
  localStorage.removeItem(_posKey(fileUrl));
}

// ── Controls HUD ──────────────────────────────────────────────────────────────

function fmtTime(secs) {
  var s = Math.floor(secs);
  var m = Math.floor(s / 60);
  var h = Math.floor(m / 60);
  m = m % 60;
  s = s % 60;
  var pad = function(n) { return n < 10 ? '0' + n : String(n); };
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function _updateVideoControls() {
  if (!activeMediaEl) return;
  var cur = activeMediaEl.currentTime || 0;
  var dur = activeMediaEl.duration;
  if (videoTimeEl) {
    videoTimeEl.textContent = fmtTime(cur) + ' / ' + (isFinite(dur) ? fmtTime(dur) : '?');
  }
  if (videoSeekFillEl && isFinite(dur) && dur > 0) {
    videoSeekFillEl.style.width = (cur / dur * 100).toFixed(2) + '%';
  }
  if (videoVolEl) {
    var rawVol = activeMediaEl.volume;
    var volStr = (rawVol <= 0)
      ? '-\u221edB'
      : (Math.round(20 * Math.log10(rawVol)) + 'dB');
    var text = activeMediaEl.muted ? 'MUTED' : ('VOL\u00a0' + volStr);
    if (_panValue !== 0) {
      var side = _panValue > 0 ? 'R' : 'L';
      text += '\u2002' + side + Math.abs(_panValue).toFixed(1);
    }
    if (!_autoplay) text += '\u2002MANUAL';
    videoVolEl.textContent = text;
  }
}

// Progress bar click-to-seek
if (videoProgressEl) {
  videoProgressEl.addEventListener('click', function(e) {
    if (!activeMediaEl || !isFinite(activeMediaEl.duration)) return;
    var rect = videoProgressEl.getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    activeMediaEl.currentTime = frac * activeMediaEl.duration;
    _updateVideoControls();
  });
}

// ── Transition cover ──────────────────────────────────────────────────────────
//
// Used for image↔media mode switches.  Snaps opaque (transition:none) to hide
// any intermediate layout state, then fades out (0.15s) when new content is
// ready.  Calling _endTransitionCover() when no cover was started is harmless.

function _startTransitionCover() {
  transitionCoverEl.classList.add('covering');
}

function _endTransitionCover() {
  // One rAF defers the fade until after the browser has painted the newly
  // ready content at least once, so the fade reveals a stable frame.
  requestAnimationFrame(function() {
    transitionCoverEl.classList.remove('covering');
  });
}

// ── Stop / tear-down ──────────────────────────────────────────────────────────

function _stopActiveMedia() {
  _clearPosCheckpoint();
  _pendingAutoFS    = false;
  _pendingQueuePlay = false;
  _shouldAnnounce   = false;
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _bcPost('media-viewer', { cmd: 'media-stopped' });
  }
  if (mediaErrorEl) mediaErrorEl.classList.add('hidden');
  if (!activeMediaEl) return;
  activeMediaEl.pause();
  activeMediaEl.src = '';
  activeMediaEl     = null;
  _contentPath      = null;
  imagePaneEl.classList.remove('media-video', 'media-audio', 'media-gif');
  _updateChannelWiring();  // activeMediaEl just cleared
}

// ── Autoplay toggle and relative seek ────────────────────────────────────────

function toggleAutoplay() {
  _autoplay = !_autoplay;
  _updateVideoControls();
}

// secs may be negative (seek back) or positive (seek forward)
function seekRelative(secs) {
  if (!activeMediaEl || !isFinite(activeMediaEl.duration)) return;
  activeMediaEl.currentTime =
    Math.max(0, Math.min(activeMediaEl.duration, activeMediaEl.currentTime + secs));
  _updateVideoControls();
}
