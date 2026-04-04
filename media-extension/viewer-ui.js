'use strict';
// ── viewer-ui.js ──────────────────────────────────────────────────────────────
//
// Persistent UI state, screen management, URL/history helpers, pane geometry,
// focus mode, fullscreen, divider drag, and the global key dispatcher.
//
// Declares these globals used by other modules:
//   ui, focusMode, selectorWidthPx, SELECTOR_W_DEFAULT,
//   setFocusMode, showScreen, persistState, applyHistoryState, getUrlParams,
//   applySelector, applyUiState, toggleSelector, toggleFullscreen,
//   setSelectorWidth, adjustSelectorWidth,
//   (DOM refs) pickScreenEl, loadingScreenEl, errorScreenEl, viewerScreenEl,
//     dirPathEl, fileListEl, selectorPaneEl, imagePaneEl, paneDividerEl,
//     btnRecursive, btnHidden, btnSort,
//     audioQueuePaneEl, audioQueueClearBtn,
//     videoQueuePaneEl, videoQueueClearBtn.
//
// Calls into globals defined in later modules:
//   selector, toggleInfoOverlay, cycleQueueMode (viewer-selector.js, viewer.js)
//   audioQueueList, videoQueueList (viewer-queue-mgt.js)
//   toggleMute, togglePlayPause, adjustVolume, adjustBalance, toggleAutoplay (viewer-media.js)
//   _bcPost, _qState, activeMediaEl (viewer.js)
//   handleViewerKey, applyImageTransform (viewer.js)
//   mainImageEl (viewer-media-image.js)

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

var audioQueuePaneEl   = document.getElementById('audio-queue-pane');
var audioQueueClearBtn = document.getElementById('audio-queue-clear-btn');
var videoQueuePaneEl   = document.getElementById('video-queue-pane');
var videoQueueClearBtn = document.getElementById('video-queue-clear-btn');

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

var focusMode = 'list'; // 'list' | 'viewer'

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
  viewerScreenEl.dataset.queueMode = ui.queueMode || '';
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
}

// Returns the FileList instance for the currently active queue pane, or null.
// Forward references audioQueueList / videoQueueList — defined in viewer-queue-mgt.js
// which loads after this file, but this function is only called at runtime.
function _activeQueueList() {
  if (ui.queueMode === 'audio') return audioQueueList;
  if (ui.queueMode === 'video') return videoQueueList;
  return null;
}

function toggleSelector() {
  ui.selectorVisible = !ui.selectorVisible;
  applySelector();
  persistState(false);
}

// ── Thumbnail mode ────────────────────────────────────────────────────────────

function toggleThumbnails() {
  ui.thumbnails = !ui.thumbnails;
  persistState(false);
  viewerScreenEl.classList.toggle('thumbnails', ui.thumbnails);
  if (ui.thumbnails) selector.prefetchThumbnails();
}

// ── Apply full UI state ───────────────────────────────────────────────────────

function applyUiState() {
  applySelector();
  viewerScreenEl.classList.toggle('thumbnails', ui.thumbnails);
  if (mainImageEl.naturalWidth) applyImageTransform();
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
  if (btnHidden)    btnHidden.classList.toggle('active', ui.showHidden);
  var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
  if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  } else {
    document.exitFullscreen();
  }
}

// ── Drag: divider resize and image-pane focus ─────────────────────────────────

// Clicking anywhere in the image pane takes viewer focus.
imagePaneEl.addEventListener('pointerdown', function() {
  setFocusMode('viewer');
});

if (paneDividerEl) {
  paneDividerEl.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    paneDividerEl.setPointerCapture(e.pointerId);
    var startX = e.clientX;
    var startW = selectorWidthPx;
    paneDividerEl.classList.add('dragging');
    e.preventDefault();

    paneDividerEl.addEventListener('pointermove', function onMove(ev) {
      setSelectorWidth(startW + (ev.clientX - startX));
    });

    paneDividerEl.addEventListener('pointerup', function onUp() {
      paneDividerEl.classList.remove('dragging');
      paneDividerEl.removeEventListener('pointermove', onMove);
      paneDividerEl.removeEventListener('pointerup',   onUp);
    });
  });
}

// Clicking the selector pane body refocuses it.
selectorPaneEl.addEventListener('mousedown', function() {
  setFocusMode('list');
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
      case ':':
      case ';':
        e.preventDefault(); toggleInfoOverlay(); return;
      case 'v':
        e.preventDefault(); toggleThumbnails(); return;
      case 'Tab': {
        e.preventDefault();
        setFocusMode(focusMode === 'list' ? 'viewer' : 'list');
        // When returning to list focus in queue mode, sync cursor to active item.
        if (ui.queueMode && focusMode === 'list') {
          _activeQueueList()?.receiveFocus();
        }
        return;
      }
      case 'Escape':
        if (focusMode === 'viewer') { e.preventDefault(); setFocusMode('list'); }
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

  if (focusMode === 'list') {
    if (ui.queueMode) {
      _activeQueueList()?.handleKey(e, key, ctrl, plain);
    } else {
      selector.handleKey(e, key, ctrl, plain);
    }
  } else {
    handleViewerKey(e, key, ctrl, plain);
  }
});
