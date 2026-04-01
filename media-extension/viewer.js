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
// ui, focusMode, selectorWidthPx / SELECTOR_W_*, dragMode, dragState
//  — declared in viewer-ui.js (loaded first).
//
// currentDir / currentFile / listing / selectedIdx — owned by viewer-selector.js.

// transformHostEl, mainImageEl, imgSpinnerEl — declared in viewer-media-image.js.
// applyImageTransform, zoom/rotate/scale/scroll — viewer-media-image.js.

// _qState, _queueSelIdx, _vqLoad/_vqNext/_vqPrev, cycleQueueMode,
// renderQueuePane, handleQueueFocusKey, _collectAndQueueDir —
// all defined in viewer-queue-mgt.js (loaded before this file).

// _updateChannelWiring, _bcPost, _mediaListenCh — defined in viewer-audio.js.

// ── DOM refs ───────────────────────────────────────────────────────────────
// UI-framework refs (screens, selector, panes, buttons, queue) — viewer-ui.js.
// Content-pane and media refs remain here pending viewer-content.js extraction.

// transformHostEl, mainImageEl, imgSpinnerEl — declared in viewer-media-image.js.
// transitionCoverEl — declared in viewer-media-playable.js.
var infoOverlayEl     = document.getElementById('info-overlay');
var infoContentEl     = document.getElementById('info-content');
var noImageHintEl     = document.getElementById('no-image-hint');
var errorContentEl    = document.getElementById('error-content');

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
    var filename = content.fullPath ? content.fullPath.replace(/.*\//, '')
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
  content.handleKey(e, key, ctrl, plain);
}

// ── Button listeners ───────────────────────────────────────────────────────

if (btnRecursive) btnRecursive.addEventListener('click', selector.toggleRecursive);
if (btnHidden)    btnHidden.addEventListener('click', selector.toggleHidden);
if (btnSort)      btnSort.addEventListener('click', selector.cycleSortBy);

// ── History (back/forward) ─────────────────────────────────────────────────

window.addEventListener('popstate', function(e) {
  _stopActiveMedia(activeMediaEl);
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
      if (idx >= 0) selector.indicateLoaded(idx, true);
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
// videoEl, audioEl, activeMediaEl — declared in viewer-media-playable.js.
// _shouldAnnounce, _pendingAutoFS, _pendingQueuePlay — viewer-media-playable.js.
// _hasAnnounced — viewer-audio.js.
// _autoplay, _posCheckpointTimer — viewer-media-playable.js.

// Video color/quality filter state — moved to VideoContent in viewer-media-video.js.

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

// ── Media element event handlers ─────────────────────────────────────────────
// loadedmetadata — handled by _loadPlayable() in viewer-media.js (async).
// _onTimeUpdate, _onMediaEnded, _onMediaPlaying, _onMediaError
//   — ongoing playback handlers in viewer-media-playable.js.

// ── Media control helpers ────────────────────────────────────────────────────
// togglePlayPause, toggleMute, adjustVolume, adjustBalance — moved to viewer-audio.js.
// toggleAutoplay, seekRelative — moved to viewer-media-playable.js.

// ── Video color/quality filter ───────────────────────────────────────────────
// Moved to VideoContent._applyFilter / VideoContent._adjustFilter
// in viewer-media-video.js.

// ── Track switching ──────────────────────────────────────────────────────────
// cycleAudioTrack(el) — moved to viewer-media-playable.js.
// cycleVideoTrack(el) — moved to viewer-media-video.js.

// ── Show media file (dispatcher) ────────────────────────────────────────────

// fullPath: optional explicit path (e.g. for video-queue items).  When omitted,
// the path is constructed from selector.currentDir + filename as usual.
// isQueueItem: true when called from _vqLoad — suppresses per-file position
// persistence and routes time tracking through the video queue state instead.
function showMediaFile(filename, fullPath, isQueueItem) {
  var fp = fullPath ||
    (selector.currentDir
      ? selector.currentDir.replace(/\/$/, '') + '/' + filename
      : null);
  if (!fp) return;
  content.load(makeContentOccupant(fp, !!isQueueItem,
    isQueueItem ? _queueSelIdx : undefined));
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
