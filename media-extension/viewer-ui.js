'use strict';
// ── viewer-ui.js ──────────────────────────────────────────────────────────────
//
// Persistent UI state, screen management, URL/history helpers, pane geometry,
// focus mode, fullscreen, drag handling, and the global key dispatcher.
//
// Declares these globals used by other modules:
//   ui, focusMode, selectorWidthPx, SELECTOR_W_DEFAULT,
//   setFocusMode, showScreen, persistState, applyHistoryState, getUrlParams,
//   applySelector, applyUiState, toggleSelector, toggleFullscreen,
//   setSelectorWidth, adjustSelectorWidth,
//   (DOM refs) pickScreenEl, loadingScreenEl, errorScreenEl, viewerScreenEl,
//     dirPathEl, fileListEl, selectorPaneEl, imagePaneEl, paneDividerEl,
//     btnRecursive, btnHidden, btnSort,
//     queuePaneEl, queuePaneTitleEl, queueListEl, queueClearBtn.
//
// Calls into globals defined in later modules (viewer-selector.js, viewer.js):
//   selector, toggleInfoOverlay, cycleQueueMode, renderQueuePane,
//   toggleMute, togglePlayPause, adjustVolume, adjustBalance, toggleAutoplay,
//   _bcPost, _qState, _queueSelIdx, activeMediaEl, _updateVideoControls,
//   handleQueueFocusKey, handleViewerKey, applyImageTransform,
//   mainImageEl, videoProgressEl.

// ── DOM refs ──────────────────────────────────────────────────────────────────

var pickScreenEl    = document.getElementById('pick-screen');
var loadingScreenEl = document.getElementById('loading-screen');
var errorScreenEl   = document.getElementById('error-screen');
var viewerScreenEl  = document.getElementById('viewer-screen');

var dirPathEl      = document.getElementById('dir-path');
var fileListEl     = document.getElementById('file-list');
var selectorPaneEl = document.getElementById('selector-pane');
var imagePaneEl    = document.getElementById('image-pane');
var paneDividerEl  = document.getElementById('pane-divider');

var btnRecursive = document.getElementById('btn-recursive');
var btnHidden    = document.getElementById('btn-hidden');
var btnSort      = document.getElementById('btn-sort');

var queuePaneEl      = document.getElementById('queue-pane');
var queuePaneTitleEl = document.getElementById('queue-pane-title');
var queueListEl      = document.getElementById('queue-list');
var queueClearBtn    = document.getElementById('queue-clear-btn');

// ── Persistent UI state ───────────────────────────────────────────────────────
//
// Most fields are persisted in history.state; queueMode is NOT (resets on load).

var ui = {
  zoomFit:         true,
  zoomReduceOnly:  true,   // in fit mode: shrink large images but don't enlarge small ones
  recursive:       false,
  selectorVisible: true,
  showHidden:      false,
  sortBy:          'name', // 'name' | 'mtime' | 'size'
  thumbnails:      false,  // v — thumbnail grid vs filename list
  // Image transform
  rotation:        0,      // 0 | 90 | 180 | 270 (degrees)
  mirror:          false,  // horizontal mirror (m key)
  flip:            false,  // vertical flip   (F key)
  scale:           1.0,    // scale factor when zoomFit=false
  // Queue mode — NOT persisted (resets on page load)
  queueMode:       null,   // null | 'audio' | 'video'
};

// ── Focus mode ────────────────────────────────────────────────────────────────

var focusMode = 'selector'; // 'selector' | 'viewer' | 'queue'

function setFocusMode(mode) {
  focusMode = mode;
  viewerScreenEl.dataset.focus = mode;
}

// ── Screen visibility ─────────────────────────────────────────────────────────

function showScreen(name) {
  pickScreenEl.classList.add('hidden');
  loadingScreenEl.classList.add('hidden');
  errorScreenEl.classList.add('hidden');
  viewerScreenEl.classList.add('hidden');
  document.getElementById(name + '-screen').classList.remove('hidden');
}

// ── URL & history state ───────────────────────────────────────────────────────

function getUrlParams() {
  var p = new URLSearchParams(window.location.search);
  return { dir: p.get('dir'), file: p.get('file') };
}

function buildPageUrl(dir, file) {
  var url = '?dir=' + encodeURIComponent(dir);
  if (file) url += '&file=' + encodeURIComponent(file);
  return url;
}

function persistState(push, newDir, newFile) {
  var dir  = (newDir  !== undefined) ? newDir  : selector.currentDir;
  var file = (newFile !== undefined) ? newFile : selector.currentFile;
  var state = {
    zoomFit:         ui.zoomFit,
    zoomReduceOnly:  ui.zoomReduceOnly,
    recursive:       ui.recursive,
    selectorVisible: ui.selectorVisible,
    showHidden:      ui.showHidden,
    sortBy:          ui.sortBy,
    thumbnails:      ui.thumbnails,
    rotation:        ui.rotation,
    mirror:          ui.mirror,
    flip:            ui.flip,
    scale:           ui.scale,
  };
  var url = buildPageUrl(dir, file);
  if (push) {
    history.pushState(state, '', url);
  } else {
    history.replaceState(state, '', url);
  }
}

function applyHistoryState(state) {
  if (!state || typeof state !== 'object') return;
  if (typeof state.zoomFit         === 'boolean') ui.zoomFit         = state.zoomFit;
  if (typeof state.zoomReduceOnly  === 'boolean') ui.zoomReduceOnly  = state.zoomReduceOnly;
  if (typeof state.recursive       === 'boolean') ui.recursive       = state.recursive;
  if (typeof state.selectorVisible === 'boolean') ui.selectorVisible = state.selectorVisible;
  if (typeof state.showHidden      === 'boolean') ui.showHidden      = state.showHidden;
  if (typeof state.thumbnails      === 'boolean') ui.thumbnails      = state.thumbnails;
  if (typeof state.mirror          === 'boolean') ui.mirror          = state.mirror;
  if (typeof state.flip            === 'boolean') ui.flip            = state.flip;
  if (['name','mtime','size'].indexOf(state.sortBy) !== -1) ui.sortBy = state.sortBy;
  if (state.rotation === 0 || state.rotation === 90 ||
      state.rotation === 180 || state.rotation === 270) ui.rotation = state.rotation;
  if (typeof state.scale === 'number' && state.scale > 0) ui.scale  = state.scale;
}

// ── Pane width ────────────────────────────────────────────────────────────────
// Keyboard: [ narrows, ] widens, ~ resets.  Also set by divider drag.

var selectorWidthPx    = 260;
var SELECTOR_W_DEFAULT = 260;
var SELECTOR_W_MIN     = 80;
var SELECTOR_W_MAX     = 600;

function setSelectorWidth(w) {
  selectorWidthPx = Math.max(SELECTOR_W_MIN, Math.min(SELECTOR_W_MAX, Math.round(w)));
  document.documentElement.style.setProperty('--selector-w', selectorWidthPx + 'px');
}

function adjustSelectorWidth(delta) {
  setSelectorWidth(selectorWidthPx + delta);
}

// ── Selector / queue pane visibility ─────────────────────────────────────────

function applySelector() {
  viewerScreenEl.classList.toggle('no-selector', !ui.selectorVisible);
  viewerScreenEl.classList.toggle('queue-mode',  !!ui.queueMode);
  if (ui.queueMode && queuePaneTitleEl) {
    queuePaneTitleEl.textContent = (ui.queueMode === 'video') ? 'VIDEO QUEUE' : 'AUDIO QUEUE';
  }
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
}

function toggleSelector() {
  ui.selectorVisible = !ui.selectorVisible;
  applySelector();
  persistState(false);
}

// ── Apply full UI state ───────────────────────────────────────────────────────

function applyUiState() {
  applySelector();
  if (mainImageEl.naturalWidth) applyImageTransform();
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
  if (btnHidden)    btnHidden.classList.toggle('active', ui.showHidden);
  var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
  if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

var selectorStateBeforeFS = true;

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    selectorStateBeforeFS = ui.selectorVisible;
    ui.selectorVisible = false;
    applySelector();
    document.documentElement.requestFullscreen().catch(function() {
      ui.selectorVisible = selectorStateBeforeFS;
      applySelector();
    });
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', function() {
  if (!document.fullscreenElement) {
    ui.selectorVisible = selectorStateBeforeFS;
    applySelector();
  }
});

// ── Drag: image pan and divider resize ───────────────────────────────────────

var dragMode  = null;  // null | 'image' | 'divider'
var dragState = {};

imagePaneEl.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  // Don't treat clicks inside the video-controls overlay as image-pane drags.
  if (videoProgressEl && videoProgressEl.contains(e.target)) return;
  dragMode = 'image';
  dragState.wasDrag = false;
  dragState.startX  = e.clientX;
  dragState.startY  = e.clientY;
  dragState.scrollX = imagePaneEl.scrollLeft;
  dragState.scrollY = imagePaneEl.scrollTop;
  e.preventDefault();
});

if (paneDividerEl) {
  paneDividerEl.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    dragMode = 'divider';
    dragState.startX = e.clientX;
    dragState.startW = selectorWidthPx;
    paneDividerEl.classList.add('dragging');
    e.preventDefault();
  });
}

document.addEventListener('mousemove', function(e) {
  if (dragMode === 'image') {
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.wasDrag = true;
    imagePaneEl.scrollLeft = dragState.scrollX - dx;
    imagePaneEl.scrollTop  = dragState.scrollY - dy;
  } else if (dragMode === 'divider') {
    setSelectorWidth(dragState.startW + (e.clientX - dragState.startX));
  }
});

document.addEventListener('mouseup', function() {
  if (dragMode === 'image' && !dragState.wasDrag) {
    setFocusMode('viewer');
    if (activeMediaEl) {
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
  }
  if (dragMode === 'divider' && paneDividerEl) {
    paneDividerEl.classList.remove('dragging');
  }
  dragMode = null;
});

// Clicking the selector pane body refocuses it.
selectorPaneEl.addEventListener('mousedown', function() {
  setFocusMode('selector');
});

// ── Global keyboard dispatcher ────────────────────────────────────────────────
//
// Handles keys that are truly global (work regardless of focused pane), then
// dispatches to the focused pane's handler for everything else.

document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  var key   = e.key;
  var ctrl  = e.ctrlKey && !e.altKey && !e.metaKey;
  var plain = !e.ctrlKey && !e.altKey && !e.metaKey;

  if (plain) {
    switch (key) {
      case 'Z':
        e.preventDefault(); toggleSelector(); return;
      case 'f':
        e.preventDefault(); toggleFullscreen(); return;
      case 'i':
        e.preventDefault(); toggleInfoOverlay(); return;
      case '.':
        e.preventDefault();
        // In video/audio viewer focus: step forward one frame.
        if (focusMode === 'viewer' && activeMediaEl) {
          activeMediaEl.currentTime =
            Math.min(activeMediaEl.duration, activeMediaEl.currentTime + 1 / 30);
          _updateVideoControls();
        } else {
          selector.toggleHidden();
        }
        return;
      case 'v':
        e.preventDefault(); selector.toggleThumbnails(); return;
      case 'Tab': {
        e.preventDefault();
        if (ui.queueMode) {
          var nextQF = (focusMode === 'viewer') ? 'queue' : 'viewer';
          if (nextQF === 'queue')
            _queueSelIdx = _qState[ui.queueMode === 'video' ? 'video' : 'audio'].index;
          setFocusMode(nextQF);
          renderQueuePane();
        } else {
          setFocusMode(focusMode === 'selector' ? 'viewer' : 'selector');
        }
        return;
      }
      case 'Escape':
        if (focusMode === 'viewer') { e.preventDefault(); setFocusMode('selector'); }
        return;
      // Pane-width adjustment (xzgv [ ] ~)
      case '[': e.preventDefault(); adjustSelectorWidth(-16); return;
      case ']': e.preventDefault(); adjustSelectorWidth(+16); return;
      case '~': e.preventDefault(); setSelectorWidth(SELECTOR_W_DEFAULT); return;
      // Global A/V keys — always active regardless of focused pane.
      case 'm': e.preventDefault(); toggleMute();        return;
      case 'p':
        e.preventDefault();
        if (activeMediaEl) {
          togglePlayPause();
        } else {
          // No local media — forward to whichever other tab holds the baton.
          _bcPost('media-viewer', { cmd: 'pause-toggle' });
        }
        return;
      case '9': e.preventDefault(); adjustVolume(-1.5);  return;
      case '0': e.preventDefault(); adjustVolume(+1.5);  return;
      case '(': e.preventDefault(); adjustBalance(-0.1); return;
      case ')': e.preventDefault(); adjustBalance(+0.1); return;
      case 'A': e.preventDefault(); toggleAutoplay(); return;
      // Queue
      case 'Q': e.preventDefault(); cycleQueueMode();     return;
      case '\\':
        e.preventDefault();
        _bcPost('media-queue', { cmd: 'q-toggle' });
        return;
    }
  }

  if (focusMode === 'queue') {
    if (plain) handleQueueFocusKey(e, key);
  } else if (focusMode === 'selector') {
    selector.handleKey(e, key, ctrl, plain);
  } else {
    handleViewerKey(e, key, ctrl, plain);
  }
});
