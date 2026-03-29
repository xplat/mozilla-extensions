'use strict';
// ── viewer-media-playable.js ──────────────────────────────────────────────────
//
// Common audio+video playback infrastructure: media element refs, lifecycle
// flags, event handlers, autoplay, seek, saved-position persistence, controls
// HUD, transition cover, and stop/tear-down.
//
// Declares these globals used by other modules:
//   videoEl, audioEl, audioPlaceholderEl, activeMediaEl,
//   _pendingAutoFS, _pendingQueuePlay,
//   _autoplay, _posCheckpointTimer,
//   _clearPosCheckpoint,
//   _posKey, _savePosition, _getSavedPosition, _clearSavedPosition,
//   fmtTime, _updateVideoControls,
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia, _mediaErrorMessage,
//   toggleAutoplay, seekRelative,
//   videoProgressEl, videoSeekFillEl, videoTimeEl, videoVolEl.
//
// Calls into globals defined in earlier / later modules:
//   imagePaneEl, selectorStateBeforeFS, ui, applySelector, (viewer-ui.js)
//   _hasAnnounced, _bcPost, _updateChannelWiring,          (viewer-audio.js)
//   _qState, _vqLoad,                                      (viewer-queue-mgt.js)
//   _panValue,                                             (media-shared.js)
//   content,                                               (viewer-content.js)
//   _contentPath,                                          (viewer.js)
//   transitionCoverEl, errorContentEl.                     (viewer.js)

// ── HUD DOM refs ──────────────────────────────────────────────────────────────

var videoProgressEl     = document.getElementById('video-progress');
var videoSeekFillEl     = document.getElementById('video-seek-fill');
var videoTimeEl         = document.getElementById('video-time');
var videoVolEl          = document.getElementById('video-vol');
var audioPlaceholderEl  = document.getElementById('audio-placeholder');

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
// Used for content transitions.  Snaps opaque (transition:none) to hide any
// intermediate layout state, then fades out (0.15s) when new content is ready.
// Callers may write DOM into transitionCoverEl before calling _startTransitionCover()
// (e.g. a screenshot of the outgoing content); innerHTML is cleared automatically
// when the fade ends so covers remain composable.
// Calling _endTransitionCover() when no cover was started is harmless.

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

// Clear any content written into the cover (e.g. screenshot overlays) once the
// fade has completed so it doesn't linger invisibly and affect layout.
transitionCoverEl.addEventListener('transitionend', function() {
  if (!transitionCoverEl.classList.contains('covering')) {
    transitionCoverEl.innerHTML = '';
  }
});

// ── Stop / tear-down ──────────────────────────────────────────────────────────

function _stopActiveMedia(mediaEl) {
  _clearPosCheckpoint();
  _pendingAutoFS    = false;
  _pendingQueuePlay = false;
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _bcPost('media-viewer', { cmd: 'media-stopped' });
  }
  if (!mediaEl) return;
  mediaEl.pause();
  mediaEl.src = '';
  mediaEl     = null;
  _contentPath      = null;
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

// ── Media element refs and playback lifecycle flags ───────────────────────────

var videoEl   = document.getElementById('main-video');
var audioEl   = document.getElementById('main-audio');

var activeMediaEl     = null;   // currently active <video> or <audio>, or null
var _pendingAutoFS    = false;  // true when auto-fullscreen should fire on the next 'playing' event
var _pendingQueuePlay = false;  // true when a video-queue advance should autoplay regardless of _autoplay

// ── Media element event handlers ─────────────────────────────────────────────
//
// loadedmetadata is handled by _loadPlayable() in viewer-media.js, which
// awaits it via LoadContext.waitFor().  The handlers below manage ongoing
// playback state after a load has committed.

function _onTimeUpdate() {
  _updateVideoControls();
  if (_posCheckpointTimer !== null) return;
  var el = this;
  _posCheckpointTimer = setTimeout(function() {
    _posCheckpointTimer = null;
    if (content.isQueueContent && el === videoEl && !el.paused && !el.ended) {
      // In video queue mode, track position in background's queue state rather
      // than the file's own saved position so queue watching doesn't affect normal
      // resume behaviour when the file is opened outside the queue.
      _bcPost('media-queue', { cmd: 'q-vtime', time: el.currentTime });
    } else {
      _savePosition(el);
    }
  }, 5000);
}

function _onMediaEnded() {
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _bcPost('media-viewer', { cmd: 'media-stopped' });
  }
  // In video queue mode, auto-advance to the next queue item.
  if (content.isQueueContent) {
    var next = _qState.video.index + 1;
    _vqLoad(next);  // no-op if past end; sets _pendingQueuePlay for autoplay
    _updateChannelWiring();  // no longer playing
    return;
  }
  if (_contentPath) _clearSavedPosition(_contentPath);
  _updateVideoControls();
  _updateChannelWiring();  // no longer playing
}

function _onMediaPlaying() {
  if (_pendingAutoFS && this === videoEl && !document.fullscreenElement) {
    _pendingAutoFS = false;
    selectorStateBeforeFS = ui.selectorVisible;
    ui.selectorVisible = false;
    applySelector();
    document.documentElement.requestFullscreen().catch(function() {
      ui.selectorVisible = selectorStateBeforeFS;
      applySelector();
    });
  }
  _updateChannelWiring();  // now playing
}

// Build a human-readable message from a media element's error information.
function _mediaErrorMessage(el, path) {
  var ext  = path ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : "unknown";
  var code = el.error ? el.error.code : 0;
  if (ext === 'mkv' && code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return 'MKV playback is not supported in this version of Firefox.\n' +
           'Try enabling media.mkv.enabled in about:config, or upgrade to a newer Firefox.';
  }
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
      code === MediaError.MEDIA_ERR_DECODE) {
    return 'This file format is not supported by your browser (' + ext.toUpperCase() + ').';
  }
  return el.error.message || 'Error loading media.';
}

function _onMediaError(e) {
  // Guard: if src was cleared during navigation, an error is expected.
  if (!e.currentTarget.src) return;
  // Guard: error during an active load — the load's own catch will redirect to
  // ErrorContent with the same message; nothing to do here.
  if (content.future) return;
  var msg = _mediaErrorMessage(e.currentTarget, content.current.fullPath);
  // Error during committed playback (e.g. stream interrupted): load ErrorContent.
  content.load(new ErrorContent(content.current, msg));
}

videoEl.addEventListener('playing',        _onMediaPlaying);
audioEl.addEventListener('playing',        _onMediaPlaying);
videoEl.addEventListener('timeupdate',     _onTimeUpdate);
audioEl.addEventListener('timeupdate',     _onTimeUpdate);
videoEl.addEventListener('ended',          _onMediaEnded);
audioEl.addEventListener('ended',          _onMediaEnded);
videoEl.addEventListener('error',          _onMediaError);
audioEl.addEventListener('error',          _onMediaError);
