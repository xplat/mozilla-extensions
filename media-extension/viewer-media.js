'use strict';
// ── viewer-media.js ───────────────────────────────────────────────────────────
//
// ContentOccupant base class, terminal occupants (Empty, Error), and the
// makeContentOccupant factory.  Specific media types live in their own files.
//

import { LoadContext } from './viewer-load-context.js';
import { fmtSize, fmtDate, requireElement } from './viewer-util.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-list.js').ItemList} ItemList */
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */

// ── Base class ────────────────────────────────────────────────────────────────

/**
 * @abstract
 */
export class ContentOccupant {
  /**
   * @param {ItemList | null} creator
   */
  constructor(creator) {
    this._creator = creator;
  }

  /**
   * @abstract
   * @type {string}
   * Subclasses must initialize this in their constructor.
   * Used to identify whether two occupants describe the same content.
   */
  // @ts-expect-error: abstract, not initialized in base class.
  _name;

  get name()      { return this._name; }
  /**
   * @type {string | null}
   * Filename of the content, if available.
   */
  get filename()  { return null; }
  /**
   * @type {string | null}
   * Full path of the content, if available.
   */
  get fullPath()  { return null; }

  /**
   * @type {HTMLElement}
   * @abstract
   * Which DOM element does this occupant exclusively own?
   * Must be an element with an id attribute set.
   * ContentPane.request() compares elements to decide if surrender is needed.
   * commitFuture() sets this element as the one that is shown.
   */
  get element()   { throw new Error('Abstract property'); }

  // Mode to put the video-controls HUD in.  Currently, "audio", "video", and
  // "other" are defined.
  get controlsMode() { return 'other'; }

  /**
   * Return a title fragment for this occupant, or null if none available.
   * @returns {string | null}
   */
  titleFragment() { return null; }

  /**
   * Subclasses can implement this to display info in the overlay.
   * @returns {string[]}
   */
  getInfoLines()  { return []; }

  /**
   * Async: start loading content.  ctx is a LoadContext for event-waits;
   * if ctx.cancel() is called (load superseded), all awaited events reject
   * with CancelledError and load() should return silently.
   * The spinner is started by ContentPane.load() before this is called;
   * commitFuture() is called by ContentPane.load()'s .then() chain.
   * @param {ContentPane} _pane
   * @param {LoadContext} _ctx
   */
  async load(_pane, _ctx) {}

  /**
   * Async: give up this.element to an incoming occupant that requested it.
   * Called only when the new occupant needs the SAME element as this one.
   * Must resolve only when the element is unused and safe for the caller.
   * Implementations using the transition cover call _startTransitionCover() here;
   * ImageContent uses visibility:hidden instead.
   * @param {HTMLElement} _element
   */
  async surrender(_element) {}

  // Sync: fast cleanup called at commitFuture() time when this occupant's
  // element was NOT surrendered (was already hidden under CSS classes).
  cleanup() {}

  /**
   * Return a pristine (unloaded) copy of this occupant, suitable for a reload
   * attempt.  Returns null if the occupant cannot be reloaded (e.g. EmptyContent).
   * @returns {ContentOccupant | null}
   */
  clone() { return null; }

  // Navigate to the next / previous item in the current list.
  nextItem() { this._creator?.nextFile(); }
  prevItem() { this._creator?.prevFile(); }

  /**
   * Handle a keydown event routed from the global dispatcher when this occupant
   * has viewer focus.  Subclasses override.
   * @param {KeyboardEvent} e
   * @param {string} key
   * @param {boolean} _ctrl
   * @param {boolean} plain
   */
  handleKey(e, key, _ctrl, plain) {
    if (plain) {
      switch(key) {
        // Navigation
        case 'Enter':
        case ' ':
          e.preventDefault();
          this.nextItem();
          return;
        case 'b':
          e.preventDefault();
          this.prevItem();
          return;
      }
    }
  }
}

// ── File ──────────────────────────────────────────────────────────────────────

export class FileContent extends ContentOccupant {
  /**
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats - FileListItem with guaranteed p (parent path)
   */
  constructor(creator, stats) {
    super(creator);
    /** @type {FileListItem & {p: string}} */
    this._stats   = stats;
    this._name    = stats.u;
  }

  /**
   * @type {string}
   */
  get filename()  { return this._stats.u; }

  /**
   * @type {string}
   */
  get fullPath()  { return this._stats.p.replace(/\/$/, '') + '/' + this._stats.u; }

  /**
   * @returns {string | null}
   */
  titleFragment() {
    return this.filename || null;
  }

  // Return array of info lines for the info overlay
  getInfoLines() {
    var lines = [this.filename];
    if (this._stats.s !== undefined) lines.push(fmtSize(this._stats.s));
    if (this._stats.m) lines.push(fmtDate(this._stats.m, true));
    return lines;
  }
}

// ── Empty ─────────────────────────────────────────────────────────────────────
//
// Singleton representing an unoccupied content pane.  content.current starts as
// EMPTY_CONTENT.  noImageHintEl is its exclusive element, so the invariant that
// exactly one element always has 'content-active' is maintained uniformly.

var noImageHintEl     = requireElement('no-image-hint');

class EmptyContent extends ContentOccupant {
  constructor() {
    super(null);
    this._name = 'empty';
  }

  /**
   * @type {HTMLElement}
   */
  get element()  { return noImageHintEl; }

  /**
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    // Secures noImageHintEl (no surrender ever needed since no other occupant
    // uses it; the call provides a cancellation-check point).
    await pane.request(this, ctx);
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }
}

export const EMPTY_CONTENT = new EmptyContent();

// ── Error ─────────────────────────────────────────────────────────────────────
//
// Wraps a failed occupant to display an error message with a retry button.
// Use pane.redirect(new ErrorContent(original, msg), ctx) from inside a load()
// method to handle errors during loading, or content.load(new ErrorContent(...))
// for errors during committed playback.

var errorContentEl    = requireElement('error-content');

export class ErrorContent extends ContentOccupant {
  /**
   * @param {ContentOccupant} wrappedOccupant
   * @param {string} message
   */
  constructor(wrappedOccupant, message) {
    super(wrappedOccupant ? wrappedOccupant._creator : null);
    this._wrapped = wrappedOccupant;
    this._message = message || 'An error occurred.';
    this._name    = 'error:' + (wrappedOccupant ? wrappedOccupant.name : 'unknown');
  }

  /**
   * @type {HTMLElement}
   */
  get element() { return errorContentEl; }

  /**
   * @returns {string}
   */
  titleFragment() {
    const wrappedFragment = this._wrapped?.titleFragment?.();
    return wrappedFragment ? `Error — ${wrappedFragment}` : 'Error';
  }

  /**
   * @param {HTMLElement} _element
   */
  async surrender(_element) {
    // Clear the DOM so the incoming ErrorContent starts from a blank slate.
    errorContentEl.innerHTML = '';
  }

  /**
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    // Secure errorContentEl, potentially surrendering an earlier ErrorContent.
    await pane.request(this, ctx);

    // Clear any stale content left by a cancelled prior ErrorContent load.
    errorContentEl.innerHTML = '';

    // Populate the error display element before commitFuture() reveals it.
    const msgEl = document.createElement('p');
    msgEl.className = 'error-content-msg';
    msgEl.textContent = this._message;
    errorContentEl.appendChild(msgEl);

    const retryTarget = this._wrapped ? this._wrapped.clone() : null;
    if (retryTarget) {
      const btn = document.createElement('button');
      btn.className = 'error-content-retry';
      btn.textContent = 'Try again';
      btn.addEventListener('click', function() { pane.load(retryTarget); });
      errorContentEl.appendChild(btn);
    }
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }

  cleanup() {
    // Clear dynamically-inserted message and retry button when replaced.
    errorContentEl.innerHTML = '';
  }

  // clone() returns the wrapped occupant's clone so a retry re-attempts the
  // original load rather than producing a nested ErrorContent.
  clone() { return this._wrapped ? this._wrapped.clone() : null; }
}
