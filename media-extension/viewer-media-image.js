// ── viewer-media-image.js ─────────────────────────────────────────────────────
//
// Image display, preload, and full transform stack: zoom/fit, rotation,
// mirror/flip, scale stepping, scroll, and the ImageContent occupant class.
//
// Calls into globals defined in earlier / later modules:
//   toProxyFile,                                          (media-shared.js)

// ── DOM refs ──────────────────────────────────────────────────────────────────

import { requireElement } from './viewer-util.js';
import { Transform } from './viewer-transform.js';
import { ImagelikeContent } from './viewer-media-imagelike.js';
import { imagePaneEl, infoOverlayEl, updateInfoOverlay } from './viewer-content.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-list.js').ItemList} ItemList */
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */
/** @typedef {import('./viewer-load-context.js').LoadContext} LoadContext */

var mainImageEl     = requireElement('main-image', HTMLImageElement);

// Create Transform instance for images
const imageTransform = new Transform(mainImageEl, imagePaneEl);

export class ImageContent extends ImagelikeContent {
  /**
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats
   */
  constructor(creator, stats) {
    super(creator, stats, imageTransform);
    this._name = 'image:' + this.fullPath;
  }

  /**
   * @type {HTMLImageElement}
   */
  get element()   { return mainImageEl; }

  /**
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    const proxyUrl = toProxyFile(this.fullPath);

    if (!infoOverlayEl.classList.contains('hidden')) updateInfoOverlay(this);

    // Phase 1: preload with a throwaway Image; old content stays visible.
    const pending = new Image();
    pending.src = proxyUrl;
    try {
      await ctx.waitFor(pending, 'load', [pending, 'error', () => new Error()]);
    } catch (e) {
      pending.removeAttribute('src');
      throw e;  // CancelledError → swallowed by ContentPane; other → backstop
    }

    await super.load(pane, ctx);

    // Phase 3: feed URL into mainImageEl and wait for decode+paint.
    const el = this.element;
    el.style.visibility = 'hidden';
    el.src = proxyUrl;
    try {
      await ctx.waitFor(el, 'load', [el, 'error', () => new Error]);
    } catch (e) {
      el.style.visibility = '';
      el.removeAttribute('src');
      throw e;
    }

    // Image decoded: set up transform before revealing.
    this._transform.resetSnapshot();
    this._transform.applyTransform();
    // may have been cleared by applyTransform but let's do it anyway.
    el.style.visibility = '';
  }

  /**
   * @param {HTMLElement} element
   */
  async surrender(element) {
    // Use visibility:hidden rather than the cover: preserves the layout area so
    // the incoming ImageContent can overwrite mainImageEl.src without a size flash.
    mainImageEl.style.visibility = 'hidden';
    await super.surrender(element);
  }

  cleanup() {
    // Still showing — clear it so the incoming occupant starts from a clean slate.
    mainImageEl.removeAttribute('src');
    super.cleanup();
  }

  /**
   * @returns {ImageContent}
   */
  clone() { return new ImageContent(/** @type {ItemList} */ (this._creator), this._stats); }
  // This always works because of the constructor signature.
}
