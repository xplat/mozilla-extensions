// ── viewer-media-imagelike.js ─────────────────────────────────────────────────
//
// Shared base class for image and gif-loop content occupants, carrying most
// of the logic; the remainder is just wiring up the img or video element and
// the back-and-forth handoff between the two modes for the video element.
//
// Calls into globals defined in earlier / later modules:
//   FileContent.                                            (viewer-media.js)
//   imagePaneEl.                                            (viewer-content.js)

import { scrollImage, watcher } from './viewer-transform.js'
import { FileContent } from './viewer-media.js'
import { imagePaneEl } from './viewer-content.js'

/** @typedef {import('./viewer-transform.js').Transform} Transform */
/** @typedef {import('./viewer-list.js').ItemList} ItemList */
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */
/** @typedef {import('./viewer-load-context.js').LoadContext} LoadContext */

// ── Drag-to-scroll ────────────────────────────────────────────────────────────

/** @type {number} */
let startX;
/** @type {number} */
let startY;
/** @type {number} */
let startScrollX;
/** @type {number} */
let startScrollY;

/**
 * Start pointer capture and begin tracking drag offset.
 * @param {PointerEvent} e
 */
function onDown(e) {
  if (e.button !== 0) return;
  imagePaneEl.setPointerCapture(e.pointerId);
  startX       = e.clientX;
  startY       = e.clientY;
  startScrollX = imagePaneEl.scrollLeft;
  startScrollY = imagePaneEl.scrollTop;
  imagePaneEl.addEventListener('pointermove', onMove);
  e.preventDefault();
}

/**
 * Update scroll position based on pointer movement.
 * @param {PointerEvent} e
 */
function onMove(e) {
  var dx = e.clientX - startX;
  var dy = e.clientY - startY;
  imagePaneEl.scrollLeft = startScrollX - dx;
  imagePaneEl.scrollTop  = startScrollY - dy;
}

/**
 * End pointer tracking and remove move listener.
 */
function onUp() {
  imagePaneEl.removeEventListener('pointermove', onMove);
}

// ── ImagelikeContent ──────────────────────────────────────────────────────────

export class ImagelikeContent extends FileContent {
  /** @type {(() => void) | null} */
  _stateRestoredListener = null;
  /** @type {ResizeObserver | null} */
  _resizeObserver = null;

  /**
   * @type {Transform}
   */
  _transform;

  /**
   * Accept Transform instance in constructor.
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats
   * @param {Transform} transform
   */
  constructor(creator, stats, transform) {
    super(creator, stats);
    this._transform = transform;
  }

  /**
   * Load image content and set up event listeners.
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    await pane.request(this, ctx);

    imagePaneEl.addEventListener('pointerdown', onDown);
    imagePaneEl.addEventListener('pointerup',   onUp);

    // Reapply transform on pane resize (fit mode depends on pane size).
    // Keep the center pixel stable by scrolling when the pane is resized.
    let self = this;
    let prevWidth = imagePaneEl.clientWidth;
    let prevHeight = imagePaneEl.clientHeight;
    this._resizeObserver = new ResizeObserver(() => {
      const newWidth = imagePaneEl.clientWidth;
      const newHeight = imagePaneEl.clientHeight;
      const dW = prevWidth - newWidth;
      const dH = prevHeight - newHeight;
      scrollImage(imagePaneEl, dW / 2, dH / 2);
      prevWidth = newWidth;
      prevHeight = newHeight;
      self._transform.applyTransform();
    });
    this._resizeObserver.observe(imagePaneEl);

    // Listen for state restoration from history
    this._stateRestoredListener = function() {
      self._transform.applyTransform();
    };
    watcher.addEventListener('transformChanged', this._stateRestoredListener);

    // Subclasses will call applyTransform() at the appropriate time
  }

  /**
   * Clean up listeners when surrendering content.
   * @param {HTMLElement} _element
   */
  async surrender(_element) {
    this._detachListeners();
    this._transform.clearTransform();
  }

  cleanup() {
    this._detachListeners();
    this._transform.clearTransform();
  }

  _detachListeners() {
    imagePaneEl.removeEventListener('pointerdown', onDown);
    imagePaneEl.removeEventListener('pointermove', onMove);
    imagePaneEl.removeEventListener('pointerup',   onUp);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._stateRestoredListener) {
      watcher.removeEventListener('transformChanged', this._stateRestoredListener);
    }
  }

  /**
   * Handle keyboard navigation for image viewer.
   * @param {KeyboardEvent} e
   * @param {string} key
   * @param {boolean} ctrl
   * @param {boolean} plain
   */
  handleKey(e, key, ctrl, plain) {
    if (plain) {
      switch (key) {
        // Scrolling — 100 px steps
        case 'ArrowUp':    e.preventDefault(); scrollImage(imagePaneEl, 0, -100); return;
        case 'ArrowDown':  e.preventDefault(); scrollImage(imagePaneEl, 0, +100); return;
        case 'ArrowLeft':  e.preventDefault(); scrollImage(imagePaneEl, -100, 0); return;
        case 'ArrowRight': e.preventDefault(); scrollImage(imagePaneEl, +100, 0); return;
        // Large scrolling — ~90% of pane
        case 'PageUp':
          e.preventDefault();
          scrollImage(imagePaneEl, 0, -(imagePaneEl.clientHeight * 0.9));
          return;
        case 'PageDown':
          e.preventDefault();
          scrollImage(imagePaneEl, 0, +(imagePaneEl.clientHeight * 0.9));
          return;
        case '-':
          e.preventDefault();
          scrollImage(imagePaneEl, -(imagePaneEl.clientWidth * 0.9), 0);
          return;
        case '=':
          e.preventDefault();
          scrollImage(imagePaneEl, +(imagePaneEl.clientWidth * 0.9), 0);
          return;
        // Jump to corners
        case 'Home':
          e.preventDefault();
          imagePaneEl.scrollLeft = 0;
          imagePaneEl.scrollTop  = 0;
          return;
        case 'End':
          e.preventDefault();
          imagePaneEl.scrollLeft = imagePaneEl.scrollWidth;
          imagePaneEl.scrollTop  = imagePaneEl.scrollHeight;
          return;
        // Scale to 1:1 (shared with ImageContent's quick-zoom '1' alias)
        case 'n': e.preventDefault(); this._transform.scaleTo(1);   return;
        // Zoom-fit toggle
        case 'z': e.preventDefault(); this._transform.toggleZoom(); return;
        // Rotation (xzgv r/R/N)
        case 'r': e.preventDefault(); this._transform.rotateBy(90);        return;
        case 'R': e.preventDefault(); this._transform.rotateBy(-90);       return;
        case 'N': e.preventDefault(); this._transform.resetOrientation();  return;
        // Mirror / flip (M/F; F avoids fullscreen conflict)
        case 'M': e.preventDefault(); this._transform.toggleMirror(); return;
        case 'F': e.preventDefault(); this._transform.toggleFlip();   return;
        // Scale (xzgv d/D/s/S)
        case 'd': e.preventDefault(); this._transform.scaleDouble(); return;
        case 'D': e.preventDefault(); this._transform.scaleHalve();  return;
        case 's': e.preventDefault(); this._transform.scaleStep(+1); return;
        case 'S': e.preventDefault(); this._transform.scaleStep(-1); return;
        // Quick zoom levels (1 is also the scaleTo1 alias)
        case '1': e.preventDefault(); this._transform.scaleTo(1); return;
        case '2': e.preventDefault(); this._transform.scaleTo(2); return;
        case '3': e.preventDefault(); this._transform.scaleTo(3); return;
        case '4': e.preventDefault(); this._transform.scaleTo(4); return;
        // Reduce-only toggle (` — replaces xzgv Alt-r)
        case '`':
          e.preventDefault(); this._transform.toggleZoomReduceOnly(); return;
      }
    } else if (ctrl) {
      // Fine scrolling — 10 px steps
      switch (key) {
        case 'ArrowUp':    e.preventDefault(); scrollImage(imagePaneEl, 0, -10);  return;
        case 'ArrowDown':  e.preventDefault(); scrollImage(imagePaneEl, 0, +10);  return;
        case 'ArrowLeft':  e.preventDefault(); scrollImage(imagePaneEl, -10,  0); return;
        case 'ArrowRight': e.preventDefault(); scrollImage(imagePaneEl, +10,  0); return;
      }
    }
    super.handleKey(e, key, ctrl, plain);
  }
}

