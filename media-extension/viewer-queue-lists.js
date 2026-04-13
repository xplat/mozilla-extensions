// ── viewer-queue-lists.js ───────────────────────────────────────────────────────
//
// AudioQueueList and VideoQueueList: ItemList subclasses for rendering the
// audio and video queues, with lifecycle hooks for visibility and focus.
//
// Declares these globals used by other modules:
//   audioQueueList, videoQueueList
//   (DOM refs) audioQueuePaneEl, videoQueuePaneEl,
//             audioQueueClearBtn, videoQueueClearBtn.
//
import { ItemList } from './viewer-list.js';
import {
  _qState, _qAudioItems, _qVideoItems, queueWatcher,
  jumpAudioQueue, jumpVideoQueue, clearAudioQueue, clearVideoQueue
} from './viewer-queue-mgt.js';
import { content } from './viewer-content.js';
import { QueuedVideoContent } from './viewer-media-queued-video.js';
import { requireElement } from './viewer-util.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const audioQueuePaneEl   = requireElement('audio-queue-pane');
const audioQueueClearBtn = requireElement('audio-queue-clear-btn');
const videoQueuePaneEl   = requireElement('video-queue-pane');
const videoQueueClearBtn = requireElement('video-queue-clear-btn');

// ── Queue pane ItemList subclasses ────────────────────────────────────────────

class AudioQueueList extends ItemList {
  /**
   * @param {import('./viewer-ui.js').UIState} ui
   * @param {HTMLElement} el
   */
  constructor(ui, el) {
    super(ui, el);
    this._onQueueChanged = this._onQueueChanged.bind(this);
  }

  /**
   * Show the audio queue list and sync with queue state.
   * @returns {void}
   */
  show() {
    this.listing = _qAudioItems();
    this.markActive(_qState.audio.index, false);
    this.selectItem(_qState.audio.index, false);
    this._items[_qState.audio.index]?.scrollIntoView({block: 'start'});
    queueWatcher.addEventListener('changed', this._onQueueChanged);
  }

  /**
   * Hide the audio queue list and stop listening for queue changes.
   * @returns {void}
   */
  hide() {
    queueWatcher.removeEventListener('changed', this._onQueueChanged);
  }

  /**
   * Handle queue change event by updating the listing and active item.
   * @returns {void}
   */
  _onQueueChanged() {
    this.listing = _qAudioItems();
    this.markActive(_qState.audio.index, false);
  }

  /**
   * Get the full path for an audio queue item.
   * @param {FileListItem & {p: string}} item
   * @returns {string}
   */
  fullPathOf(item) { return item.p.replace(/\/$/, '') + '/' + item.u; }

  /**
   * Open an audio queue item: mark active optimistically, then broadcast
   * q-jump. Audio plays in the background script, so we stay in list focus.
   * @param {number} idx
   * @param {boolean} [passive=false]
   * @returns {void}
   */
  openItem(idx, passive = false) {
    const items = _qAudioItems();
    if (idx < 0 || idx >= items.length) return;
    this.markActive(idx, !passive);
    jumpAudioQueue(idx);
  }

  /**
   * Navigate back to parent UI mode.
   * @returns {void}
   */
  goToParent() { this.ui.setQueueMode(null); }

  /**
   * Get the title fragment for this queue list.
   * @returns {string}
   */
  titleFragment() {
    return 'Audio Queue';
  }
}

class VideoQueueList extends ItemList {
  /**
   * @param {import('./viewer-ui.js').UIState} ui
   * @param {HTMLElement} el
   */
  constructor(ui, el) {
    super(ui, el);
    this._onQueueChanged = this._onQueueChanged.bind(this);
  }

  /**
   * Show the video queue list and sync with queue state.
   * @returns {void}
   */
  show() {
    this.listing = _qVideoItems();
    this.markActive(_qState.video.index, false);
    this.selectItem(_qState.video.index, false);
    this._items[_qState.video.index]?.scrollIntoView({block: 'start'});
    queueWatcher.addEventListener('changed', this._onQueueChanged);
  }

  /**
   * Hide the video queue list and stop listening for queue changes.
   * @returns {void}
   */
  hide() {
    queueWatcher.removeEventListener('changed', this._onQueueChanged);
  }

  /**
   * Handle queue change event by updating the listing and active item.
   * Sync cursor only — actual loading is done by _vqLoad(), not here,
   * so that autoplay only happens when playback is truly intended.
   * @returns {void}
   */
  _onQueueChanged() {
    this.listing = _qVideoItems();
    this.markActive(_qState.video.index, false);
  }

  /**
   * Get the full path for a video queue item.
   * @param {FileListItem & {p: string}} item
   * @returns {string}
   */
  fullPathOf(item) { return item.p.replace(/\/$/, '') + '/' + item.u; }

  /**
   * Open a video queue item: load directly (don't wait for q-changed round-trip)
   * so it works even when the queue index doesn't change (first Enter after
   * entering video-queue mode). Switch to viewer focus so the user can control
   * the video immediately.
   * @param {number} idx
   * @param {boolean} [passive=false]
   * @returns {void}
   */
  openItem(idx, passive = false) {
    var items = _qVideoItems();
    if (idx < 0 || idx >= items.length) return;
    var item = items[idx];
    var newItem = (idx !== _qState.video.index);
    if (newItem) _qState.video.time = 0;  // new item — start from beginning
    this.markActive(idx, true);  // optimistic cursor update
    content.load(new QueuedVideoContent(this, item, idx));
    if (newItem) jumpVideoQueue(idx);
    if (!passive) this.ui.setFocusMode('viewer');
  }

  /**
   * Navigate back to parent UI mode.
   * @returns {void}
   */
  goToParent() { this.ui.setQueueMode(null); }

  /**
   * Get the title fragment for this queue list.
   * @returns {string}
   */
  titleFragment() {
    return 'Video Queue';
  }
}

// ── Instances and initialization ───────────────────────────────────────────────

/** @type {AudioQueueList} */
var audioQueueList;

/** @type {VideoQueueList} */
var videoQueueList;

/**
 * Initialize the audio and video queue lists with UI state and attach event listeners.
 * @param {import('./viewer-ui.js').UIState} ui
 * @returns {void}
 */
export function init(ui) {
  audioQueueList = new AudioQueueList(ui, audioQueuePaneEl);
  videoQueueList = new VideoQueueList(ui, videoQueuePaneEl);

  // Clear-queue buttons
  audioQueueClearBtn.addEventListener('click', clearAudioQueue);
  videoQueueClearBtn.addEventListener('click', clearVideoQueue);
}

export { audioQueueList, videoQueueList };
