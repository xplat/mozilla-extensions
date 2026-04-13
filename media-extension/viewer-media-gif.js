// ── viewer-media-gif.js ───────────────────────────────────────────────────────
//
// GifContent: a short looping video with no audio track, treated as a static
// image.  Shares the 'video:' name prefix with VideoContent so that
// gif↔video reclassification via ContentPane.redirect() is transparent.
//
// Calls into globals defined in earlier / later modules:
//   _startTransitionCover.               (viewer-content.js)

import { Transform } from './viewer-transform.js';
import { ImagelikeContent } from './viewer-media-imagelike.js';
import { videoEl } from './viewer-media-video.js';
import { imagePaneEl, _startTransitionCover } from './viewer-content.js';

/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-list.js').ItemList} ItemList */
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */
/** @typedef {import('./viewer-load-context.js').LoadContext} LoadContext */

const gifTransform = new Transform(videoEl, imagePaneEl);

export class GifContent extends ImagelikeContent {
  /**
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats
   */
  constructor(creator, stats) {
    super(creator, stats, gifTransform);
    this._name = 'video:' + this.fullPath;
  }

  /** @type {HTMLVideoElement} */
  get element()   { return videoEl; }

  /**
   * GifContent is reached via redirect() from VideoContent.load(), which
   * has already set el.src and secured the element.  This load() sets up the
   * gif-specific playback state and starts playback.
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    const el = videoEl;
    el.loop  = true;
    el.muted = true;
    el.classList.add("imagelike");
    // Attach various event listeners (base class).
    await super.load(pane, ctx);
    this._transform.resetSnapshot();
    this._transform.applyTransform();
    el.play().catch(function() {});
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }

  /**
   * @param {HTMLElement} element
   */
  async surrender(element) {
    _startTransitionCover();
    await super.surrender(element);
    videoEl.classList.remove('imagelike');
  }

  cleanup() {
    videoEl.pause();
    super.cleanup();
    videoEl.classList.remove('imagelike');
  }

  /**
   * @returns {GifContent}
   */
  clone() { return new GifContent(/** @type {ItemList} */ (this._creator), this._stats); }
  // this always works because of the constructor signature
}
