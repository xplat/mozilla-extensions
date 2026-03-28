// viewer.js — Media Viewer UI  (no chrome.* / browser.* calls)
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
// LOOPBACK, FILE_PROXY_PREFIX, DIR_PROXY_PREFIX, THUMB_PROXY_PREFIX,
// QUEUE_DIR_PROXY_PREFIX, LS_*, toProxyFile(), applyAvSettings(),
// initMediaElVolume() — all defined in media-shared.js (loaded first).

// Maps file extension (lowercase, no dot) → media category.
// Only extensions that should be selectable/viewable belong here;
// anything absent returns 'unknown'.
const MEDIA_TYPES = {
  // images (rendered natively by the browser)
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', tiff: 'image', tif: 'image', svg: 'image', ico: 'image',
  // video
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video',
  mov: 'video', avi: 'video', mkv: 'video', flv: 'video', wmv: 'video', '3gp': 'video',
  // audio
  mp3: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio',
  m4a: 'audio', aac: 'audio', opus: 'audio', wav: 'audio',
};

function mediaType(filename) {
  var dot = filename.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  return MEDIA_TYPES[filename.slice(dot + 1).toLowerCase()] || 'unknown';
}

// Known standard video dimensions (width × height as "WxH" strings) that
// should trigger auto-fullscreen when played from the beginning.
// Covers HD/4K/8K broadcast, DVD (NTSC + PAL, fullscreen + widescreen output),
// and the VGA/SVGA/XGA fullscreen formats common on old computers.
const FULLSCREEN_DIMS = new Set([
  // HD / broadcast
  '1920x1080', '1280x720',
  // 480p — widescreen (anamorphic output) and 4:3
  '854x480', '852x480', '640x480',
  // 4K UHD / DCI 4K / 8K
  '3840x2160', '4096x2160', '7680x4320',
  // 1440p (QHD) and 2K DCI
  '2560x1440', '2048x1080',
  // DVD fullscreen: NTSC 720×480, PAL 720×576
  '720x480', '720x576',
  // DVD widescreen PAL output
  '1024x576',
  // Old computer fullscreen: VGA, SVGA, XGA
  '800x600', '1024x768',
]);

// ── Mutable state ──────────────────────────────────────────────────────────
//
// ui, focusMode, selectorWidthPx / SELECTOR_W_*, dragMode, dragState,
// selectorStateBeforeFS — declared in viewer-ui.js (loaded first).
//
// currentDir / currentFile / listing / selectedIdx — owned by viewer-selector.js.

// transformHostEl, mainImageEl, imgSpinnerEl — declared in viewer-media-image.js.
// applyImageTransform, showImage, zoom/rotate/scale/scroll — viewer-media-image.js.

// _qState, _queueSelIdx, _vqLoad/_vqNext/_vqPrev, cycleQueueMode,
// renderQueuePane, handleQueueFocusKey, _collectAndQueueDir —
// all defined in viewer-queue-mgt.js (loaded before this file).

// _updateChannelWiring, _bcPost, _mediaListenCh — defined in viewer-audio.js.

// Deferred image↔media transition state:
//   _deferredMediaType ('video'|'audio'|'gif'|null): set when starting an
//     image→media load without adding the CSS class yet (the old image stays
//     visible until loadedmetadata fires, then we do the swap).
//   _pendingMediaStop (bool): set when starting a media→image preload without
//     stopping the current media yet (the old media keeps playing until the
//     image's load event fires, then we do the swap).
var _deferredMediaType = null;
var _pendingMediaStop  = false;

// Full path of whatever is currently loaded (or being loaded) in the content
// pane.  Set by showMediaFile() from either an explicit fullPath argument or
// from selector globals (currentDir + filename).  Queue-item loads pass
// fullPath explicitly so they never need to mutate currentDir / currentFile.
var _contentPath = null;

// True when the content pane is playing a video queue item (set by showMediaFile
// when called from _vqLoad).  Event handlers use this — not ui.queueMode — so
// that the playback source identity survives queue mode changes (e.g. cycling
// back to selector or audio-queue mode while the queue video keeps playing).
var _isQueueContent = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
// UI-framework refs (screens, selector, panes, buttons, queue) — viewer-ui.js.
// Content-pane and media refs remain here pending viewer-content.js extraction.

// transformHostEl, mainImageEl, imgSpinnerEl — declared in viewer-media-image.js.
var transitionCoverEl = document.getElementById('transition-cover');
var infoOverlayEl     = document.getElementById('info-overlay');
var infoContentEl     = document.getElementById('info-content');
var noImageHintEl     = document.getElementById('no-image-hint');

// ── Proxy URL helpers ──────────────────────────────────────────────────────
// toProxyFile() is defined in media-shared.js.

function toProxyThumb(fileUrl) {
  var path    = fileUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return THUMB_PROXY_PREFIX + encoded;
}

function toProxyDir(dirUrl, recursive) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  var url     = DIR_PROXY_PREFIX + encoded;
  if (recursive) url += '?recursive=1';
  return url;
}

function toProxyQueueDir(dirUrl) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return QUEUE_DIR_PROXY_PREFIX + encoded;
}

// ── Directory loading ──────────────────────────────────────────────────────
// Delegated to selector module (viewer-selector.js).

// ── Selector rendering ─────────────────────────────────────────────────────
// Delegated to selector module (viewer-selector.js).

// ── Image display, transform, zoom/rotate/scale/scroll ───────────────────────
// Moved to viewer-media-image.js.

// ── Queue mode ─────────────────────────────────────────────────────────────
// Moved to viewer-queue-mgt.js.

// ── Image navigation / toggle helpers ─────────────────────────────────────
// Delegated to selector module (viewer-selector.js):
//   selector.nextFile(), selector.prevFile(), selector.goToParent(),
//   selector.toggleThumbnails(), selector.toggleRecursive(),
//   selector.toggleHidden(), selector.cycleSortBy()

// ── Info overlay ───────────────────────────────────────────────────────────

function toggleInfoOverlay() {
  var hidden = infoOverlayEl.classList.contains('hidden');
  if (hidden) {
    // Use the content-pane path if something is loaded; fall back to the
    // selector's currentFile (e.g. when no media has loaded yet).
    var filename = _contentPath ? _contentPath.replace(/.*\//, '')
                                : selector.currentFile;
    updateInfoOverlay(filename);
    infoOverlayEl.classList.remove('hidden');
  } else {
    infoOverlayEl.classList.add('hidden');
  }
}

function updateInfoOverlay(filename) {
  if (!filename) { infoContentEl.textContent = ''; return; }
  var item  = selector.listing.find(function(i) { return i.u === filename; });
  var lines = [filename];
  if (item) {
    if (item.s !== undefined) lines.push(fmtSize(item.s));
    if (item.m)               lines.push(fmtDate(item.m, true));
  }
  if (activeMediaEl && isFinite(activeMediaEl.duration)) {
    lines.push(fmtTime(activeMediaEl.duration));
    if (activeMediaEl === videoEl && videoEl.videoWidth) {
      lines.push(videoEl.videoWidth + '\u00d7' + videoEl.videoHeight + ' px');
    }
  } else if (mainImageEl.naturalWidth) {
    lines.push(mainImageEl.naturalWidth + '\u00d7' + mainImageEl.naturalHeight + ' px');
  }
  infoContentEl.textContent = lines.join('\n');
}

// ── Focus mode, applyUiState, global keydown ──────────────────────────────
// Moved to viewer-ui.js.

// handleQueueFocusKey — moved to viewer-queue-mgt.js.

function handleViewerKey(e, key, ctrl, plain) {
  // Media-mode overrides: applied when a controllable video or audio file is
  // active (gif-loop videos are excluded — they behave like static images).
  if (plain && activeMediaEl && !imagePaneEl.classList.contains('media-gif')) {
    switch (key) {
      // Seek (mplayer defaults: ←/→ ±10 s, ↑/↓ ±1 min, PgUp/PgDn ±10 min)
      case 'ArrowLeft':  e.preventDefault(); seekRelative(-10);  return;
      case 'ArrowRight': e.preventDefault(); seekRelative(+10);  return;
      case 'ArrowUp':    e.preventDefault(); seekRelative(+60);  return;
      case 'ArrowDown':  e.preventDefault(); seekRelative(-60);  return;
      case 'PageUp':     e.preventDefault(); seekRelative(+600); return;
      case 'PageDown':   e.preventDefault(); seekRelative(-600); return;
      case 'Home':       e.preventDefault();
        activeMediaEl.currentTime = 0; _updateVideoControls(); return;
      case 'Backspace':  e.preventDefault();
        activeMediaEl.playbackRate = 1; return;
      // Navigation
      case 'Enter': e.preventDefault();
        ui.queueMode === 'video' ? _vqNext() : selector.nextFile(); return;
      case 'b': e.preventDefault();
        ui.queueMode === 'video' ? _vqPrev() : selector.prevFile(); return;
      // Play / pause
      case ' ':
        e.preventDefault();
        if (activeMediaEl.ended) { ui.queueMode === 'video' ? _vqNext() : selector.nextFile(); }
        else                     { togglePlayPause(); }
        return;
      // Playback rate  (</>: ±0.1 step, matching mplayer's [/] moved to angle brackets)
      //                ({/}: halve/double, as in mplayer)
      case '<': e.preventDefault();
        activeMediaEl.playbackRate = Math.max(0.25, +(activeMediaEl.playbackRate - 0.1).toFixed(2));
        return;
      case '>': e.preventDefault();
        activeMediaEl.playbackRate = Math.min(4.0,  +(activeMediaEl.playbackRate + 0.1).toFixed(2));
        return;
      case '{': e.preventDefault();
        activeMediaEl.playbackRate = Math.max(0.25, activeMediaEl.playbackRate / 2);
        return;
      case '}': e.preventDefault();
        activeMediaEl.playbackRate = Math.min(4.0,  activeMediaEl.playbackRate * 2);
        return;
      // Audio / video track cycling
      case 'a':
      case '#': e.preventDefault(); cycleAudioTrack(); return;
      case '_': e.preventDefault(); cycleVideoTrack(); return;
      // OSD / info
      case 'o': e.preventDefault(); toggleInfoOverlay(); return;
      // Color/quality (video only; overrides image quick-zoom keys 1-4)
      // mplayer layout: 1/2 contrast, 3/4 brightness, 5/6 hue, 7/8 saturation
      case '1': case '2': case '3': case '4':
      case '5': case '6': case '7': case '8':
        if (imagePaneEl.classList.contains('media-video')) {
          e.preventDefault();
          if      (key === '1') adjustVideoFilter('contrast',   -0.1);
          else if (key === '2') adjustVideoFilter('contrast',   +0.1);
          else if (key === '3') adjustVideoFilter('brightness', -0.1);
          else if (key === '4') adjustVideoFilter('brightness', +0.1);
          else if (key === '5') adjustVideoFilter('hue',        -10);
          else if (key === '6') adjustVideoFilter('hue',        +10);
          else if (key === '7') adjustVideoFilter('saturation', -0.1);
          else if (key === '8') adjustVideoFilter('saturation', +0.1);
          return;
        }
        break;
    }
  }

  if (plain) {
    switch (key) {
      // Scrolling — 100 px steps
      case 'ArrowUp':    e.preventDefault(); scrollImage(0, -100); break;
      case 'ArrowDown':  e.preventDefault(); scrollImage(0, +100); break;
      case 'ArrowLeft':  e.preventDefault(); scrollImage(-100, 0); break;
      case 'ArrowRight': e.preventDefault(); scrollImage(+100, 0); break;
      // Large scrolling — ~90% of pane
      case 'PageUp':
        e.preventDefault();
        scrollImage(0, -(imagePaneEl.clientHeight * 0.9));
        break;
      case 'PageDown':
        e.preventDefault();
        scrollImage(0, +(imagePaneEl.clientHeight * 0.9));
        break;
      case '-':
        e.preventDefault();
        scrollImage(-(imagePaneEl.clientWidth * 0.9), 0);
        break;
      case '=':
        e.preventDefault();
        scrollImage(+(imagePaneEl.clientWidth * 0.9), 0);
        break;
      // Jump to corners
      case 'Home':
        e.preventDefault();
        imagePaneEl.scrollLeft = 0;
        imagePaneEl.scrollTop  = 0;
        break;
      case 'End':
        e.preventDefault();
        imagePaneEl.scrollLeft = imagePaneEl.scrollWidth;
        imagePaneEl.scrollTop  = imagePaneEl.scrollHeight;
        break;
      // Image navigation
      case 'Enter':
      case ' ':
        e.preventDefault();
        ui.queueMode === 'video' ? _vqNext() : selector.nextFile();
        break;
      case 'b':
        ui.queueMode === 'video' ? _vqPrev() : selector.prevFile();
        break;
      // Rotation (xzgv r/R/N)
      case 'r': rotateBy(90);        break;
      case 'R': rotateBy(-90);       break;
      case 'N': resetOrientation();  break;
      // Mirror / flip (M/F for consistency; F avoids fullscreen conflict)
      case 'M': toggleMirror(); break;  // horizontal mirror (xzgv m)
      case 'F': toggleFlip();   break;  // vertical flip    (xzgv f)
      // Scale (xzgv d/D/s/S/n)
      case 'd': scaleDouble(); break;
      case 'D': scaleHalve();  break;
      case 's': scaleStep(+1); break;
      case 'S': scaleStep(-1); break;
      case 'n': scaleTo1();    break;
      // Quick zoom levels
      case '1': scaleTo1();                                    break;
      case '2': ui.zoomFit=false; ui.scale=2; applyImageTransform(); persistState(false); break;
      case '3': ui.zoomFit=false; ui.scale=3; applyImageTransform(); persistState(false); break;
      case '4': ui.zoomFit=false; ui.scale=4; applyImageTransform(); persistState(false); break;
      // Zoom-fit toggle (z) and reduce-only toggle (` — replaces xzgv Alt-r)
      case 'z': toggleZoom(); break;
      case '`':
        ui.zoomReduceOnly = !ui.zoomReduceOnly;
        if (ui.zoomFit) applyImageTransform();
        persistState(false);
        break;
      // Info (xzgv : / ;)
      case ':':
      case ';': e.preventDefault(); toggleInfoOverlay(); break;
    }
  } else if (ctrl) {
    // Fine scrolling — 10 px steps
    switch (key) {
      case 'ArrowUp':    e.preventDefault(); scrollImage(0, -10);  break;
      case 'ArrowDown':  e.preventDefault(); scrollImage(0, +10);  break;
      case 'ArrowLeft':  e.preventDefault(); scrollImage(-10,  0); break;
      case 'ArrowRight': e.preventDefault(); scrollImage(+10,  0); break;
    }
  }
}

// ── Button listeners ───────────────────────────────────────────────────────

if (btnRecursive) btnRecursive.addEventListener('click', selector.toggleRecursive);
if (btnHidden)    btnHidden.addEventListener('click', selector.toggleHidden);
if (btnSort)      btnSort.addEventListener('click', selector.cycleSortBy);

// ── History (back/forward) ─────────────────────────────────────────────────

window.addEventListener('popstate', function(e) {
  _stopActiveMedia();
  applyHistoryState(e.state);
  var params = getUrlParams();

  if (params.dir !== selector.currentDir) {
    selector.setFromHistory(params.dir, params.file || null);
    selector.loadDir(params.dir, false);
  } else {
    selector.setFromHistory(params.dir, params.file || null);
    applyUiState();
    if (params.file) {
      var idx = selector.listing.findIndex(function(i) { return i.u === params.file; });
      if (idx >= 0) selector.selectItem(idx, true);
      showMediaFile(params.file);
    }
  }
});

// ── Utility functions ──────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)               return bytes + '\u00a0B';
  if (bytes < 1024 * 1024)        return (bytes / 1024).toFixed(1) + '\u00a0KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + '\u00a0MB';
  return (bytes / 1073741824).toFixed(1) + '\u00a0GB';
}

function fmtDate(unixSecs, full) {
  var d = new Date(unixSecs * 1000);
  return full ? d.toLocaleString() : d.toLocaleDateString();
}

// ── Media playback ─────────────────────────────────────────────────────────

var videoEl         = document.getElementById('main-video');
var audioEl         = document.getElementById('main-audio');
var mediaErrorEl    = document.getElementById('media-error');
var mediaErrorMsgEl = document.getElementById('media-error-msg');

var activeMediaEl     = null;   // currently active <video> or <audio>, or null
var _shouldAnnounce   = false;  // true when audio-bearing media loaded; cleared after first 'playing' event
// _hasAnnounced — declared in viewer-audio.js (also written here in _onMediaPlaying/_onMediaEnded/_stopActiveMedia).
// _autoplay, _posCheckpointTimer — declared in viewer-media-playable.js.
var _pendingAutoFS    = false;  // true when auto-fullscreen should fire on the next 'playing' event
var _pendingQueuePlay = false;  // true when a video-queue advance should autoplay regardless of _autoplay

// Video color/quality filter state (reset on each new file; applied via CSS filter on videoEl)
var _vContrast   = 1.0;  // CSS contrast()   — mplayer keys 1/2
var _vBrightness = 1.0;  // CSS brightness() — mplayer keys 3/4
var _vHue        = 0;    // CSS hue-rotate() degrees — mplayer keys 5/6
var _vSaturation = 1.0;  // CSS saturate()   — mplayer keys 7/8

// Stereo balance (Web Audio API): _panValue, _audioCtx, _panNode defined in
// media-shared.js.  Both elements are wired into the graph eagerly so that
// balance is always applied regardless of which element is active.
_ensureAudioContext();
try { _audioCtx.createMediaElementSource(audioEl).connect(_panNode); }
catch (err) { console.warn('createMediaElementSource(audioEl) failed:', err); }
try { _audioCtx.createMediaElementSource(videoEl).connect(_panNode); }
catch (err) { console.warn('createMediaElementSource(videoEl) failed:', err); }

// ── BroadcastChannel infrastructure ──────────────────────────────────────────
// _bcPost, _mediaListenCh, _onMediaMsg, _updateChannelWiring,
// visibilitychange listener — moved to viewer-audio.js.

// ── Transition cover, stop/tear-down, position persistence, controls HUD ─────
// _startTransitionCover, _endTransitionCover, _stopActiveMedia,
// _clearPosCheckpoint, _posKey, _savePosition, _getSavedPosition,
// _clearSavedPosition, fmtTime, _updateVideoControls,
// progress-bar click listener — moved to viewer-media-playable.js.

// ── Media element event listeners ───────────────────────────────────────────

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
      if (_deferredMediaType) {
        _deferredMediaType = 'gif';  // class added below at swap time
      } else {
        imagePaneEl.classList.replace('media-video', 'media-gif');
      }
    }
  }

  // Restore saved position before playback starts (gif-loops are excluded:
  // they have no meaningful temporal position to resume).
  // Video queue uses its own per-queue time (_qState.video.time broadcast from
  // background), not the file's general saved position, so queue watching doesn't
  // pollute the file's own resume point.
  var saved = 0;
  if (!isGif) {
    saved = _isQueueContent ? (_qState.video.time || 0)
                            : _getSavedPosition(fileUrl);
    if (saved > 0 && isFinite(mediaEl.duration) && saved < mediaEl.duration) {
      mediaEl.currentTime = saved;
    }
  }

  // image→media deferred swap: media is ready, now atomically replace the image.
  if (_deferredMediaType) {
    var dType = _deferredMediaType;
    _deferredMediaType = null;
    _startTransitionCover();
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    imagePaneEl.classList.add(dType === 'gif'   ? 'media-gif'   :
                              dType === 'video' ? 'media-video' : 'media-audio');
    // Cover fades out below, after _updateVideoControls().
  }

  // Notify other tabs to pause before we start playing anything with audio
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
    if (_isQueueContent && el === videoEl && !el.paused && !el.ended) {
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
  if (_isQueueContent) {
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

// ── Media control helpers ────────────────────────────────────────────────────
// togglePlayPause, toggleMute, adjustVolume, adjustBalance — moved to viewer-audio.js.
// toggleAutoplay, seekRelative — moved to viewer-media-playable.js.

// ── Video color/quality filter ───────────────────────────────────────────────
//
// Applies CSS filter to the video element.  mplayer key layout:
//   1/2 contrast, 3/4 brightness, 5/6 hue-rotate, 7/8 saturate
// Filter is reset to defaults when a new file is opened (showMedia).

function _applyVideoFilter() {
  var parts = [];
  if (_vContrast   !== 1.0) parts.push('contrast('   + _vContrast.toFixed(2)   + ')');
  if (_vBrightness !== 1.0) parts.push('brightness(' + _vBrightness.toFixed(2) + ')');
  if (_vHue        !== 0)   parts.push('hue-rotate(' + _vHue                   + 'deg)');
  if (_vSaturation !== 1.0) parts.push('saturate('   + _vSaturation.toFixed(2) + ')');
  videoEl.style.filter = parts.join(' ');
}

function adjustVideoFilter(prop, delta) {
  if (prop === 'contrast') {
    _vContrast   = +Math.max(0, Math.min(3, _vContrast   + delta)).toFixed(2);
  } else if (prop === 'brightness') {
    _vBrightness = +Math.max(0, Math.min(3, _vBrightness + delta)).toFixed(2);
  } else if (prop === 'hue') {
    _vHue = ((_vHue + delta) % 360 + 360) % 360;
    if (_vHue > 180) _vHue -= 360;
  } else if (prop === 'saturation') {
    _vSaturation = +Math.max(0, Math.min(3, _vSaturation + delta)).toFixed(2);
  }
  _applyVideoFilter();
}

// ── Track switching ──────────────────────────────────────────────────────────

function cycleAudioTrack() {
  if (!activeMediaEl) return;
  var tracks = activeMediaEl.audioTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].enabled) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].enabled = (i === next); }
}

function cycleVideoTrack() {
  var tracks = videoEl.videoTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].selected) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].selected = (i === next); }
}

// ── Show media file (dispatcher) ────────────────────────────────────────────

// fullPath: optional explicit path (e.g. for video-queue items).  When omitted,
// the path is constructed from selector.currentDir + filename as usual.
// isQueueItem: true when called from _vqLoad — suppresses per-file position
// persistence and routes time tracking through the video queue state instead.
function showMediaFile(filename, fullPath, isQueueItem) {
  _contentPath    = fullPath || (selector.currentDir ? selector.currentDir.replace(/\/$/, '') + '/' + filename : null);
  _isQueueContent = !!isQueueItem;
  if (!_contentPath) return;
  var type = mediaType(filename);

  // Cancel any in-flight image preload.
  if (_imgPendingLoad) {
    _imgPendingLoad.onload = _imgPendingLoad.onerror = null;
    _imgPendingLoad.src    = '';
    _imgPendingLoad        = null;
  }

  // Cancel any in-progress deferred transition, restoring a clean slate.
  if (_deferredMediaType) {
    // Media was loading invisibly behind the old image; just stop it.
    _deferredMediaType = null;
    _stopActiveMedia();
    // Old image state (src, image-loaded) is intact — no further cleanup.
  } else if (_pendingMediaStop) {
    // Image was preloading behind the old media; stop media now.
    _pendingMediaStop = false;
    _stopActiveMedia();
    mainImageEl.style.visibility = '';
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
  }

  var wasMedia = imagePaneEl.classList.contains('media-video') ||
                 imagePaneEl.classList.contains('media-audio') ||
                 imagePaneEl.classList.contains('media-gif');

  if (type === 'image') {
    if (wasMedia) {
      // media→image: keep media playing while image preloads; stop it only
      // once the image's load event fires (see mainImageEl 'load' handler).
      _pendingMediaStop = true;
      showImage(filename);
    } else {
      // image→image: preload+visibility:hidden is already seamless, no cover.
      showImage(filename);
    }
  } else if (type === 'video' || type === 'audio') {
    if (!wasMedia) {
      // image→media: load media invisibly (no CSS class yet); old image stays
      // visible until loadedmetadata fires (see _onMediaLoadedMetadata).
      _deferredMediaType = type;
      showMedia(filename, type, /*deferred=*/ true);
    } else {
      // media→media: a brief blank with cover is acceptable.
      _startTransitionCover();
      _stopActiveMedia();
      mainImageEl.src = '';
      imagePaneEl.classList.remove('image-loaded');
      showMedia(filename, type, /*deferred=*/ false);
    }
  } else {
    // Unknown type: show empty pane / no-content hint.
    _startTransitionCover();
    _stopActiveMedia();
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    requestAnimationFrame(function() {
      transitionCoverEl.classList.remove('covering');
    });
  }
}

// deferred=true: called from image→media path; don't add the CSS display class
// yet — the old image stays visible.  _onMediaLoadedMetadata() will do the swap.
function showMedia(filename, type, deferred) {
  // _contentPath is always set by showMediaFile() before showMedia() is called.
  var proxyUrl = toProxyFile(_contentPath);

  activeMediaEl      = (type === 'video') ? videoEl : audioEl;
  activeMediaEl.loop   = false;
  activeMediaEl.volume = parseFloat(localStorage.getItem('media-volume') || '1');
  activeMediaEl.muted  = localStorage.getItem('media-muted') === 'true';
  // Balance is applied via _panNode (shared, initialised from localStorage in
  // media-shared.js) and kept in sync on every adjustBalance() / av-settings
  // message, so no per-file re-sync is needed here.
  _updateChannelWiring();  // activeMediaEl just changed

  // Reset per-file video filter to defaults.
  _vContrast = _vBrightness = 1.0;
  _vHue = 0;
  _vSaturation = 1.0;
  videoEl.style.filter = '';

  if (!deferred) {
    // Immediate mode: show spinner and media class right away.
    imgSpinnerEl.classList.remove('hidden');
    imagePaneEl.classList.add(type === 'video' ? 'media-video' : 'media-audio');
  }
  // Deferred: old image stays visible; no spinner, no class until ready.

  activeMediaEl.src = proxyUrl;
  // loadedmetadata fires next → _onMediaLoadedMetadata()

  if (!infoOverlayEl.classList.contains('hidden')) {
    updateInfoOverlay(filename);
  }
  document.title = filename + ' — Media Viewer';
}

// ── Initialisation ─────────────────────────────────────────────────────────

function init() {
  applyHistoryState(history.state);

  var params = getUrlParams();
  if (!params.dir) {
    showScreen('pick');
    return;
  }

  selector.setFromHistory(params.dir, params.file || null);
  selector.loadDir(params.dir, false);
}

init();
