// ── viewer-media-queued-video.js ──────────────────────────────────────────────
//
// QueuedVideoContent: a VideoContent variant that reads its saved position from
// the video-queue state rather than the per-file localStorage entry, so that
// queue watching doesn't affect normal resume behaviour.  Also suppresses
// gif-loop detection (queue videos are always played as plain video).
//
// Declares these globals used by other modules:
//   QueuedVideoContent.
//
// Calls into globals defined in earlier / later modules:
//   _qState, _vqNext, _vqPrev.                             (viewer-queue-mgt.js)

import { VideoContentBase } from './viewer-media-video.js';
import { saveVideoTime, _qState } from './viewer-queue-mgt.js';

/** @typedef {import('./viewer-list.js').ItemList} ItemList */
/** @typedef {import('./viewer-list.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */
/** @typedef {import('./viewer-load-context.js').LoadContext} LoadContext */

export class QueuedVideoContent extends VideoContentBase {
  /**
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats
   * @param {number} queueIndex
   */
  constructor(creator, stats, queueIndex) {
    super(creator, stats);
    this.queueIndex = queueIndex;
    this._name = 'qvideo:' + queueIndex + ':' + this.fullPath;
  }

  _makeEventListeners() {
    super._makeEventListeners();
    const self = this;
    function _onMediaEnded2() {
      self.nextItem();
    }
    self._onMediaEnded2 = _onMediaEnded2;
  }

  /**
   * Load the video and attach queue-specific ended handler for queue advance.
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    await super.load(pane, ctx);
    // For queued videos, also attach the queue-specific ended handler
    // so both parent cleanup and queue advance happen.
    const el = this.mediaEl;
    el.addEventListener('ended', /** @type {EventListener} */(this._onMediaEnded2));
  }

  _stopActiveMedia() {
    this.mediaEl.removeEventListener('ended', /** @type {EventListener} */(this._onMediaEnded2));
    super._stopActiveMedia();
  }

  /**
   * Queued videos never mutate into other content types.
   * @returns {null}
   */
  mutate() { return null; }

  get savedPosition() { return _qState.video.time || 0; }
  set savedPosition(time) { saveVideoTime(time); }

  /**
   * @returns {QueuedVideoContent}
   */
  clone() {
    // _creator is enforced to be non-null by the constructor type signature
    return new QueuedVideoContent(/** @type {ItemList} */(this._creator), this._stats, this.queueIndex);
  }
}
