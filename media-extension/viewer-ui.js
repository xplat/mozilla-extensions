// ── viewer-ui.js ──────────────────────────────────────────────────────────────
//
// Screen management, focus mode, pane geometry, selector/queue pane visibility,
// thumbnail mode, fullscreen, divider drag, and the global key dispatcher.
//
// NOTE: This is a leaf module — it imports every other viewer module and
// therefore cannot itself be imported.  Do not add exports that other modules
// need; expose shared state as page-scope globals instead.
//
// Declares these globals used by other modules:
//   ui (selectorVisible, thumbnails, queueMode, focusMode,
//       setQueueMode, setFocusMode),
//   selectorWidthPx, SELECTOR_W_DEFAULT,
//   showScreen, applySelector, applyUiState,
//   toggleSelector, toggleFullscreen, setSelectorWidth, adjustSelectorWidth,
//   (DOM refs) loadingScreenEl, errorScreenEl, viewerScreenEl,
//     paneDividerEl.
//
// Calls into globals defined in later modules:
//   selector (viewer-selector.js)
//   toggleInfoOverlay (viewer-content.js)
//   content (viewer-content.js)
//   audioQueueList, videoQueueList                     (viewer-queue-mgt.js)
//   toggleMute, handlePlayPauseKey, adjustVolume, adjustBalance (viewer-audio.js)
//   toggleAutoplay (viewer-media-playable.js)
//   cycleQueueMode (viewer.js)

import * as State from './state.js';
import { toggleInfoOverlay, content, imagePaneEl } from './viewer-content.js';
import { initSelector, selector } from './viewer-selector.js';
import { toggleQueueMode, updateQueueChannelWiring } from './viewer-queue-mgt.js';
import { init as initQueueLists, audioQueueList, videoQueueList } from './viewer-queue-lists.js';
import { toggleAutoplay } from './viewer-media-playable.js';
import { toggleMute, handlePlayPauseKey, adjustVolume, adjustBalance } from './viewer-audio.js';
import { requireElement } from './viewer-util.js';

/** @typedef {import('./viewer-list.js').ItemList} ItemList */

// ── Persistent-state handles ──────────────────────────────────────────────────

const hSelectorVisible = State.reserve(State.Hidden, 'selectorVisible', State.Boolean,              true);
const hThumbnails      = State.reserve(State.Hidden, 'thumbnails',      State.Boolean,              false);
const hQueueMode       = State.reserve(State.Hidden, 'queueMode',       State.Enum('audio', 'video'), null);

// ── DOM refs ──────────────────────────────────────────────────────────────────

const loadingScreenEl = requireElement('loading-screen');
const errorScreenEl   = requireElement('error-screen');
const viewerScreenEl  = requireElement('viewer-screen');
const paneDividerEl   = requireElement('pane-divider');

// ── Persistent UI state ───────────────────────────────────────────────────────

export class UIState {
  constructor() {
    this._focusMode = 'list'; // 'list' | 'viewer'
  }

  get selectorVisible()  { return hSelectorVisible.get(); }
  set selectorVisible(v) { hSelectorVisible.set(v); }
  get thumbnails()       { return hThumbnails.get(); }
  set thumbnails(v)      { hThumbnails.set(v); }
  get queueMode()        { return hQueueMode.get(); }
  set queueMode(v)       { hQueueMode.set(v); }
  get focusMode()        { return this._focusMode; }
  set focusMode(v)       { this._focusMode = v; viewerScreenEl.dataset.focus = v; }

  /**
   * Set queue mode and apply all pane lifecycle hooks.
   * @param {'audio' | 'video' | null} mode
   */
  setQueueMode(mode) {
    this.queueMode = mode;
    applyModes();
  }

  /**
   * Set focus mode and apply all pane lifecycle hooks.
   * @param {'list' | 'viewer'} mode
   */
  setFocusMode(mode) {
    this.focusMode = mode;
    applyModes();
  }

  /**
   * Show a named screen by hiding others and revealing the target.
   * @param {'loading' | 'error' | 'viewer'} name - Screen name
   */
  showScreen(name) {
    loadingScreenEl.classList.add('hidden');
    errorScreenEl.classList.add('hidden');
    viewerScreenEl.classList.add('hidden');
    const screenEl = document.getElementById(name + '-screen');
    if (screenEl) screenEl.classList.remove('hidden');
  }
}

const ui = new UIState();

// Initialize selector and queue lists with the ui instance
initSelector(ui);
initQueueLists(ui);

// ── Applied UI state ──────────────────────────────────────────────────────────
//
// Tracks the pane and focus state that have actually been reflected to the DOM
// via lifecycle hooks (show/hide/receiveFocus/yieldFocus).  applyModes() diffs
// this against current persisted state and fires hooks for any transition.
//
// _appliedPane is null before the first call; thereafter it is the pane object
// (selector / audioQueueList / videoQueueList) that was last shown.

/** @type {ItemList | null} */
var _appliedPane    = null;
var _appliedFocused = false;

// Map queueMode string to the corresponding pane object.
/**
 * @param {'audio' | 'video' | null} mode
 * @returns {ItemList | null}
 */
function _paneForMode(mode) {
  if (mode === 'audio') return audioQueueList;
  if (mode === 'video') return videoQueueList;
  return selector ?? null;
}

// Apply persisted ui state to the pane objects, firing lifecycle hooks for
// any transition since the last call.  Hook order per pane: blur → hide → show → focus.
function applyModes() {
  var targetPane    = _paneForMode(ui.queueMode);
  var targetFocused = ui.focusMode === 'list';

  // blur: leaving focus (pane changed or focus mode leaving 'list')
  if (_appliedFocused && (_appliedPane !== targetPane || !targetFocused))
    _appliedPane?.yieldFocus();

  if (_appliedPane !== targetPane) {
    _appliedPane?.hide?.();   // hide: old pane
    targetPane?.show?.();     // show: new pane
  }

  // focus: entering focus (pane changed while focused, or focus mode entering 'list')
  if (targetFocused && (_appliedPane !== targetPane || !_appliedFocused))
    targetPane?.receiveFocus();

  _appliedPane    = targetPane;
  _appliedFocused = targetFocused;

  viewerScreenEl.classList.toggle('queue-mode', !!ui.queueMode);
  viewerScreenEl.dataset.queueMode = ui.queueMode || '';
  updateQueueChannelWiring(document.visibilityState === 'visible');
}

// ── Screen visibility ─────────────────────────────────────────────────────────


// ── Pane width ────────────────────────────────────────────────────────────────
// Keyboard: [ narrows, ] widens, ~ resets.  Also set by divider drag.

let selectorWidthPx    = 260;
const SELECTOR_W_DEFAULT = 260;
const SELECTOR_W_MIN     = 80;
const SELECTOR_W_MAX     = 600;

/**
 * @param {number} w
 */
function setSelectorWidth(w) {
  selectorWidthPx = Math.max(SELECTOR_W_MIN, Math.min(SELECTOR_W_MAX, Math.round(w)));
  document.documentElement.style.setProperty('--selector-w', selectorWidthPx + 'px');
}

/**
 * @param {number} delta
 */
function adjustSelectorWidth(delta) {
  setSelectorWidth(selectorWidthPx + delta);
}

// ── Selector / queue pane visibility ─────────────────────────────────────────

function applySelector() {
  viewerScreenEl.classList.toggle('no-selector', !ui.selectorVisible);
}

function toggleSelector() {
  ui.selectorVisible = !ui.selectorVisible;
  applySelector();
  State.save();
}

// ── Thumbnail mode ────────────────────────────────────────────────────────────

function toggleThumbnails() {
  ui.thumbnails = !ui.thumbnails;
  State.save();
  viewerScreenEl.classList.toggle('thumbnails', ui.thumbnails);
  if (ui.thumbnails) selector?.prefetchThumbnails();
}

// ── Apply full UI state ───────────────────────────────────────────────────────

function applyUiState() {
  applyModes();
  applySelector();
  viewerScreenEl.classList.toggle('thumbnails', ui.thumbnails);
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}

// ── Drag: divider resize and image-pane focus ─────────────────────────────────

// Clicking anywhere in the image pane takes viewer focus.
imagePaneEl.addEventListener('pointerdown', () => {
  ui.setFocusMode('viewer');
});

paneDividerEl.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
  if (e.button !== 0) return;
  paneDividerEl.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = selectorWidthPx;
  paneDividerEl.classList.add('dragging');
  e.preventDefault();

  /**
   * @param {PointerEvent} ev
   */
  function onMove(ev) {
    setSelectorWidth(startW + (ev.clientX - startX));
  }

  function onUp() {
    paneDividerEl.classList.remove('dragging');
    paneDividerEl.removeEventListener('pointermove', onMove);
    paneDividerEl.removeEventListener('pointerup',   onUp);
  }

  paneDividerEl.addEventListener('pointermove', onMove);
  paneDividerEl.addEventListener('pointerup', onUp);
});

// ── Queue mode cycling ────────────────────────────────────────────────────────

function cycleQueueMode() {
  var modes = /** @type {const} */ ([null, 'audio', 'video']);
  ui.setQueueMode(modes[(modes.indexOf(ui.queueMode) + 1) % modes.length]);
}

// ── Global keyboard dispatcher ────────────────────────────────────────────────
//
// Handles keys that are truly global (work regardless of focused pane), then
// dispatches to the focused pane's handler for everything else.

/**
 * @param {KeyboardEvent} e
 */
function handleGlobalKeydown(e) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

  const key   = e.key;
  const ctrl  = e.ctrlKey && !e.altKey && !e.metaKey;
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;

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
        ui.setFocusMode(ui.focusMode === 'list' ? 'viewer' : 'list');
        return;
      }
      case 'Escape':
        if (ui.focusMode === 'viewer') { e.preventDefault(); ui.setFocusMode('list'); }
        return;
      // Pane-width adjustment (xzgv [ ] ~)
      case '[': e.preventDefault(); adjustSelectorWidth(-16); return;
      case ']': e.preventDefault(); adjustSelectorWidth(+16); return;
      case '~': e.preventDefault(); setSelectorWidth(SELECTOR_W_DEFAULT); return;
      // Global A/V keys — always active regardless of focused pane.
      case 'm': e.preventDefault(); toggleMute();        return;
      case 'p': e.preventDefault(); handlePlayPauseKey(); return;
      case '9': e.preventDefault(); adjustVolume(-1.5);  return;
      case '0': e.preventDefault(); adjustVolume(+1.5);  return;
      case '(': e.preventDefault(); adjustBalance(-0.1); return;
      case ')': e.preventDefault(); adjustBalance(+0.1); return;
      case 'A': e.preventDefault(); toggleAutoplay(); return;
      // Queue
      case 'Q': e.preventDefault(); cycleQueueMode();     return;
      case '\\':
        e.preventDefault();
        toggleQueueMode();
        return;
    }
  }

  if (ui.focusMode === 'list') {
    _paneForMode(ui.queueMode)?.handleKey(e, key, ctrl, plain);
  } else {
    content.handleKey(e, key, ctrl, plain);
  }
}

document.addEventListener('keydown', handleGlobalKeydown);

// ── History (back/forward) ────────────────────────────────────────────────────

State.onLoad(() => { applyUiState(); });

// ── Page title management ────────────────────────────────────────────────────

/** @type {string | null} */
let contentTitle = null;
/** @type {string | null} */
let selectorTitle = null;

function updatePageTitle() {
  let titleFragment = contentTitle
    ?? getQueueTitle()
    ?? selectorTitle
    ?? 'Media Viewer';
  if (titleFragment !== 'Media Viewer') {
    document.title = titleFragment + ' — Media Viewer';
  } else {
    document.title = titleFragment;
  }
}

function getQueueTitle() {
  if (!ui.queueMode) return null;
  if (ui.queueMode === 'audio') return audioQueueList.titleFragment();
  if (ui.queueMode === 'video') return videoQueueList.titleFragment();
  return null;
}

/**
 * @param {CustomEvent<{occupant: import('./viewer-media.js').ContentOccupant}>} e
 */
function handleContentReady(e) {
  contentTitle = e.detail.occupant.titleFragment?.() ?? null;
  updatePageTitle();
}
addEventListener('contentReady', /** @type {EventListener} */ (handleContentReady));

/**
 * @param {CustomEvent<{selector: import('./viewer-selector.js').Selector}>} e
 */
function handleSelectorChanged(e) {
  selectorTitle = e.detail.selector.titleFragment();
  contentTitle = null;  // clear stale content title when dir changes
  updatePageTitle();
}
addEventListener('selectorChanged', /** @type {EventListener} */ (handleSelectorChanged));

// ── Initialisation ────────────────────────────────────────────────────────────

function init() {
  ui.showScreen('viewer');
  applyUiState();
}

init();
