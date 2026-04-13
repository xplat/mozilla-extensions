'use strict';
// ── viewer-content.js ─────────────────────────────────────────────────────────
//
// ContentPane: manages current and future content-pane occupants, drives
// transitions, and exposes state queries used by event handlers.
//
// Declares these globals:
//   content                                               (ContentPane instance)
//
// Calls into globals defined in earlier / later modules:
//   CancelledError, LoadContext,                         (viewer-load-context.js)

import { LoadContext, CancelledError } from './viewer-load-context.js';
//   ImageContent, GifContent, PlayableContent,
//   VideoContent, QueuedVideoContent,
//   EmptyContent, EMPTY_CONTENT, ErrorContent,           (viewer-media.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   transitionCoverEl,                                   (viewer-media-playable.js)
//   selector,                                            (viewer-selector.js)

import { ContentOccupant, ErrorContent, EMPTY_CONTENT } from './viewer-media.js';
import { requireElement } from './viewer-util.js';

/** @type {HTMLElement} */
export const imagePaneEl    = requireElement('image-pane');
/** @type {HTMLElement} */
const imgSpinnerEl        = requireElement('img-spinner');

// ── Info overlay ───────────────────────────────────────────────────────────────

/** @type {HTMLElement} */
export const infoOverlayEl       = requireElement('info-overlay');
/** @type {HTMLElement} */
const infoContentEl       = requireElement('info-content');

/**
 * Toggle the visibility of the info overlay.
 */
export function toggleInfoOverlay() {
  var hidden = infoOverlayEl.classList.contains('hidden');
  if (hidden) {
    updateInfoOverlay(content.current);
    infoOverlayEl.classList.remove('hidden');
  } else {
    infoOverlayEl.classList.add('hidden');
  }
}

/**
 * Update the info overlay content for the given occupant.
 * @param {ContentOccupant | null} occupant
 */
export function updateInfoOverlay(occupant) {
  if (!occupant) {
    infoContentEl.textContent = '';
    return;
  }
  var lines = occupant.getInfoLines();
  infoContentEl.textContent = lines.join('\n');
}

// ── Transition cover ──────────────────────────────────────────────────────────
//
// Used for content transitions.  Snaps opaque (transition:none) to hide any
// intermediate layout state, then fades out (0.15s) when new content is ready.
// Callers may write DOM into transitionCoverEl before calling _startTransitionCover()
// (e.g. a screenshot of the outgoing content); innerHTML is cleared automatically
// when the fade ends so covers remain composable.
// Calling _endTransitionCover() when no cover was started is harmless.

/** @type {HTMLElement} */
const transitionCoverEl = requireElement('transition-cover');

/**
 * Start the transition cover by adding the 'covering' class.
 */
export function _startTransitionCover() {
  transitionCoverEl.classList.add('covering');
}

/**
 * End the transition cover by removing the 'covering' class after animation.
 */
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

// ── Content pane ──────────────────────────────────────────────────────────────

export class ContentPane {
  /** @type {ContentOccupant} */
  current;
  /** @type {ContentOccupant | null} */
  future;
  /** @type {LoadContext | null} */
  _futureCtx;
  /** @type {boolean} */
  _surrendered;

  constructor() {
    this.current      = EMPTY_CONTENT;  // committed occupant (currently displayed)
    this.future       = null;           // occupant being loaded, or null
    this._futureCtx   = null;           // LoadContext for the current future, or null
    this._surrendered = false;          // true once current has surrendered its element
  }

  // ── State queries ───────────────────────────────────────────────────────────

  /**
   * Get the full path of the active occupant, or null if empty.
   * @returns {string | null}
   */
  get fullPath() {
    var active = this.future || this.current;
    return (active && active.name !== 'empty') ? active.fullPath : null;
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  // Kick off an async content load.  Returns false if already loaded (no-op).
  // The actual loading runs asynchronously; this method returns immediately
  // after starting it so the caller can proceed (e.g. set focus).
  /**
   * @param {ContentOccupant} occupant
   * @returns {boolean}
   */
  load(occupant) {
    if (this.current.name === occupant.name && !this.future) {
      return false;  // already loaded, nothing to do
    }

    // Cancel any in-progress load.  _surrendered is NOT reset here: if the
    // outgoing current already surrendered its element, that state stands and
    // guards against calling surrender again on the next request().
    if (this._futureCtx) {
      this._futureCtx.cancel();
      this._futureCtx = null;
    }
    this.future = null;

    const ctx = new LoadContext();
    this._futureCtx = ctx;
    this.future     = occupant;

    // Spinner on: stopped by commitFuture() on success.
    imgSpinnerEl.classList.remove('hidden');

    const self = this;
    occupant.load(this, ctx)
      .then(function() { self.commitFuture(ctx); })
      .catch(function(e) {
        if (e instanceof CancelledError) return;
        console.error('content load failed:', e);
        content.load(new ErrorContent(occupant, 'Failed to load content.'));
      });

    return true;
  }

  // ── Request ─────────────────────────────────────────────────────────────────

  // Called by occupant.load() when it needs its element.
  // If the current occupant uses the same element, ask it to surrender first.
  // After this resolves, the element is unused.
  // Double-surrender is guarded by the central _surrendered flag.
  /**
   * @param {ContentOccupant} occupant
   * @param {LoadContext} ctx
   */
  async request(occupant, ctx) {
    if (!this._surrendered && this.current.element === occupant.element) {
      this._surrendered = true;
      await this.current.surrender(occupant.element);
    }
    if (ctx.isCancelled()) throw new CancelledError();
  }

  // ── Commit ──────────────────────────────────────────────────────────────────

  /**
   * Commit the future occupant as the current occupant after loading completes.
   * Called by the .then() chain in load() after occupant.load() resolves.
   * Stops the spinner, cleans up the old occupant, switches the content-active
   * class, applies the imagePaneEl mode class, and ends any transition cover.
   * @param {LoadContext} ctx
   */
  commitFuture(ctx) {
    if (ctx !== this._futureCtx) return;
    const occupant = this.future;
    if (!occupant) return;
    const prev     = this.current;

    imgSpinnerEl.classList.add('hidden');

    // Clean up old occupant.  No-op if it was surrendered (already torn down).
    if (!this._surrendered) prev.cleanup();

    imagePaneEl.dataset.show = occupant.element.id;
    imagePaneEl.dataset.mode = occupant.controlsMode || 'other';

    this.current      = occupant;
    this.future       = null;
    this._futureCtx   = null;
    this._surrendered = false;

    _endTransitionCover();

    dispatchEvent(new CustomEvent('contentReady', { detail: { occupant } }));
  }

  // ── Key dispatch ────────────────────────────────────────────────────────────

  // Route a keydown event to the current occupant, but swallow it silently
  // while a new occupant is loading (future !== null).
  /**
   * @param {KeyboardEvent} e
   * @param {string} key
   * @param {boolean} ctrl
   * @param {boolean} plain
   */
  handleKey(e, key, ctrl, plain) {
    if (this.future) return;
    this.current.handleKey(e, key, ctrl, plain);
  }

  // ── Redirect ────────────────────────────────────────────────────────────────

  // Swap the future occupant mid-load without cancelling the load.  The context
  // is checked for staleness; a mismatched ctx is silently ignored.  By
  // convention the caller should immediately hand off via pane.future.load().
  /**
   * @param {ContentOccupant} newOccupant
   * @param {LoadContext} ctx
   */
  redirect(newOccupant, ctx) {
    if (ctx !== this._futureCtx) return;
    this.future = newOccupant;
  }
}

export const content = new ContentPane();
