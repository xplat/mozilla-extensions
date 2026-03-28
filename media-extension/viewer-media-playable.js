'use strict';
// ── viewer-media-playable.js ──────────────────────────────────────────────────
//
// Common audio+video playback infrastructure: media element refs, lifecycle
// flags, event handlers, autoplay, seek, saved-position persistence, controls
// HUD, transition cover, and stop/tear-down.
//
// Declares these globals used by other modules:
//   videoEl, audioEl, activeMediaEl,
//   _shouldAnnounce, _pendingAutoFS, _pendingQueuePlay,
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
//   imagePaneEl, selectorStateBeforeFS, ui, applySelector, (viewer-ui.js)
//   _hasAnnounced, _bcPost, _updateChannelWiring,          (viewer-audio.js)
//   _qState, _vqLoad,                                      (viewer-queue-mgt.js)
//   _panValue,                                             (media-shared.js)
//   ImageContent, GifContent, PlayableContent,
//   VideoContent,                                          (viewer-media.js)
//   content,                                               (viewer-content.js)
//   _contentPath,                                          (viewer.js)
//   FULLSCREEN_DIMS,                                       (viewer.js)
//   transitionCoverEl, mainImageEl, imgSpinnerEl,          (viewer-media-image.js)
//   mediaErrorEl, mediaErrorMsgEl.                         (viewer.js)

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

// ── Media element refs and playback lifecycle flags ───────────────────────────

var videoEl   = document.getElementById('main-video');
var audioEl   = document.getElementById('main-audio');

var activeMediaEl     = null;   // currently active <video> or <audio>, or null
var _shouldAnnounce   = false;  // true when audio-bearing media loaded; cleared after first 'playing' event
var _pendingAutoFS    = false;  // true when auto-fullscreen should fire on the next 'playing' event
var _pendingQueuePlay = false;  // true when a video-queue advance should autoplay regardless of _autoplay

// ── Media element event handlers ─────────────────────────────────────────────
//
// Temporarily in this module pending content-object refactoring, which will
// let loadedmetadata/ended/playing/error be split by media type.

function _onMediaLoadedMetadata() {
  imgSpinnerEl.classList.add('hidden');
  var mediaEl = this;
  var fileUrl = _contentPath;

  // Detect gif-loop first: short video with no audio → play silently in a loop.
  // Must run before the position-restore below so we can skip restoring for gifs.
  var isGif = false;
  if (mediaEl === videoEl) {
    if (isFinite(videoEl.duration) && videoEl.duration < 60 && !videoEl.mozHasAudio) {
      isGif = true;
      videoEl.loop  = true;
      videoEl.muted = true;
      // Reclassify the future occupant from VideoContent to GifContent so
      // ContentPane deduplication and CSS-class logic use the correct type.
      if (content.future instanceof VideoContent) {
        content.redirect(new GifContent(content.future.fullPath));
      }
      if (!content._isDeferred()) {
        // Immediate mode (media→gif): swap the CSS class right now.
        imagePaneEl.classList.replace('media-video', 'media-gif');
      }
      // Deferred mode (image→gif): class is added below in the deferred-swap block.
    }
  }

  // Restore saved position before playback starts (gif-loops are excluded:
  // they have no meaningful temporal position to resume).
  // Video queue uses its own per-queue time (_qState.video.time broadcast from
  // background), not the file's general saved position, so queue watching doesn't
  // pollute the file's own resume point.
  var saved = 0;
  if (!isGif) {
    saved = content.isQueueContent ? (_qState.video.time || 0)
                                   : _getSavedPosition(fileUrl);
    if (saved > 0 && isFinite(mediaEl.duration) && saved < mediaEl.duration) {
      mediaEl.currentTime = saved;
    }
  }

  // image→media deferred swap: media is ready, now atomically replace the image.
  if (content._isDeferred()) {
    var fut = content.future;
    var cssClass = (fut instanceof GifContent)   ? 'media-gif'   :
                   (fut instanceof VideoContent)  ? 'media-video' : 'media-audio';
    _startTransitionCover();
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    imagePaneEl.classList.add(cssClass);
    // Cover fades out below, after _updateVideoControls().
  }
  content.commitFuture(content.future);

  // Schedule cross-tab pause for the moment playback actually starts,
  // not here — otherwise loading without autoplay still pauses other tabs.
  var hasAudio = mediaEl === audioEl ||
                 (mediaEl === videoEl && videoEl.mozHasAudio &&
                  !imagePaneEl.classList.contains('media-gif'));
  _shouldAnnounce = hasAudio;

  // Auto-fullscreen: widescreen video (≥ 3:2 aspect) played from the beginning.
  // Skipped when restoring a saved position (the user already watched part of it)
  // or when already fullscreen or when gif-loop mode.
  // The actual fullscreen request is deferred to the 'playing' event so it fires
  // when the user actually starts playback rather than when the file loads.
  _pendingAutoFS = (mediaEl === videoEl &&
      !imagePaneEl.classList.contains('media-gif') &&
      !document.fullscreenElement &&
      !(saved > 0) &&
      FULLSCREEN_DIMS.has(videoEl.videoWidth + 'x' + videoEl.videoHeight));

  _updateVideoControls();
  _endTransitionCover();
  // Gif-loops always play (they're treated as looping images, not video).
  // For real video/audio, respect the autoplay toggle; video-queue advances
  // always play regardless (_pendingQueuePlay) to keep the queue running.
  if (_autoplay || imagePaneEl.classList.contains('media-gif') || _pendingQueuePlay) {
    _pendingQueuePlay = false;
    mediaEl.play().catch(function() {});
  }
}

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
  if (_shouldAnnounce) {
    _shouldAnnounce = false;
    _hasAnnounced   = true;
    _bcPost('media-viewer', { cmd: 'pause' });
  }
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

function _onMediaError() {
  imgSpinnerEl.classList.add('hidden');
  // Guard: if src was cleared during navigation activeMediaEl is already null.
  if (!activeMediaEl || !_contentPath) return;
  var ext = _contentPath.slice(_contentPath.lastIndexOf('.') + 1).toLowerCase();
  var code = activeMediaEl.error ? activeMediaEl.error.code : 0;
  var msg;
  if (ext === 'mkv' && code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    msg = 'MKV playback is not supported in this version of Firefox.\n' +
          'Try enabling media.mkv.enabled in about:config, or upgrade to a newer Firefox.';
  } else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
             code === MediaError.MEDIA_ERR_DECODE) {
    msg = 'This file format is not supported by your browser (' + ext.toUpperCase() + ').';
  } else {
    msg = 'Error loading media.';
  }
  if (mediaErrorMsgEl) mediaErrorMsgEl.textContent = msg;
  if (mediaErrorEl)    mediaErrorEl.classList.remove('hidden');
}

videoEl.addEventListener('loadedmetadata', _onMediaLoadedMetadata);
audioEl.addEventListener('loadedmetadata', _onMediaLoadedMetadata);
videoEl.addEventListener('playing',        _onMediaPlaying);
audioEl.addEventListener('playing',        _onMediaPlaying);
videoEl.addEventListener('timeupdate',     _onTimeUpdate);
audioEl.addEventListener('timeupdate',     _onTimeUpdate);
videoEl.addEventListener('ended',          _onMediaEnded);
audioEl.addEventListener('ended',          _onMediaEnded);
videoEl.addEventListener('error',          _onMediaError);
audioEl.addEventListener('error',          _onMediaError);
