'use strict';
// ── viewer-queue-mgt.js ───────────────────────────────────────────────────────
//
// Queue state, BroadcastChannel queue listener, video-queue navigation,
// and directory-collection helpers.
//
// Declares these globals used by other modules:
//   _qState, _qAudioItems, _qVideoItems,
//   queueWatcher,
//   updateQueueChannelWiring,
//   _vqLoad, _vqNext, _vqPrev,
//   _collectAndQueueDir,
//   (DOM refs) audioQueuePaneEl, audioQueueClearBtn,
//             videoQueuePaneEl, videoQueueClearBtn.
//
// Calls into globals defined in earlier / later modules:
//   _bcPost, toProxyDir, mediaType,                            (viewer.js)

import { WatchableEventTarget } from './viewer-util.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */

// ── BroadcastChannel infrastructure ────────────────────────────────────────────

/**
 * Private helper to send ephemeral messages on the media-queue channel.
 * @param {Object} msg
 */
function _bcPost(msg) {
  var ch = new BroadcastChannel('media-queue');
  ch.postMessage(msg);
  ch.close();
}

// Public API: send q-toggle message (used by viewer-ui.js)
export function toggleQueueMode() {
  _bcPost({ cmd: 'q-toggle' });
}

/**
 * Public API: send q-vtime message (used by QueuedVideoContent)
 * @param {number | null} time
 */
export function saveVideoTime(time) {
  if (time !== null) {
    _bcPost({ cmd: 'q-vtime', time: time });
  }
}

// Public API: send q-jump message for audio queue (used by AudioQueueList)
/**
 * @param {number} index
 */
export function jumpAudioQueue(index) {
  _bcPost({ cmd: 'q-jump', type: 'audio', index: index });
}

// Public API: send q-jump message for video queue (used by VideoQueueList)
/**
 * @param {number} index
 */
export function jumpVideoQueue(index) {
  _bcPost({ cmd: 'q-jump', type: 'video', index: index });
}

// Public API: send q-clear message for audio queue (used by viewer-queue-lists.js)
export function clearAudioQueue() {
  _bcPost({ cmd: 'q-clear', type: 'audio' });
}

// Public API: send q-clear message for video queue (used by viewer-queue-lists.js)
export function clearVideoQueue() {
  _bcPost({ cmd: 'q-clear', type: 'video' });
}

// Public API: add audio items to queue
/**
 * @param {Array<*>} items
 */
export function queueAddAudio(items) {
  if (items.length) {
    _bcPost({ cmd: 'q-add', type: 'audio', items: items });
  }
}

// Public API: add video items to queue
/**
 * @param {Array<*>} items
 */
export function queueAddVideo(items) {
  if (items.length) {
    _bcPost({ cmd: 'q-add', type: 'video', items: items });
  }
}

// ── Queue state (mirrored from background via BroadcastChannel) ───────────────
//
// Only volatile bits (index, time, playing, suppressed) come over the wire.
// Items live in localStorage and are read via _qAudioItems()/_qVideoItems()
// so large arrays are never pushed through the channel.

export var _qState = {
  audio: { index: 0, time: 0, playing: false, suppressed: false },
  video: { index: 0, time: 0 }
};

export function _qAudioItems() {
  try { return JSON.parse(localStorage.getItem('media-audio-queue') || '{}').items || []; }
  catch (e) { return []; }
}
export function _qVideoItems() {
  try { return JSON.parse(localStorage.getItem('media-video-queue') || '{}').items || []; }
  catch (e) { return []; }
}

// ── Queue BroadcastChannel listener ──────────────────────────────────────────

export var queueWatcher = new WatchableEventTarget();

/** @type {BroadcastChannel | null} */
var _queueListenCh = null;

/**
 * @param {MessageEvent} e
 */
function _onQueueMsg(e) {
  if (!e.data || e.data.cmd !== 'q-changed') return;
  _qState = { audio: e.data.audio, video: e.data.video };
  queueWatcher.dispatchEvent(new Event('changed'));
}

/**
 * Open or close the queue listener channel based on visibility and whether
 * anyone is watching queueWatcher. Called whenever visibility or pane
 * visibility changes; manages _queueListenCh only.
 * @param {boolean} visible
 */
export function updateQueueChannelWiring(visible) {
  var needQueue = visible && queueWatcher.watched();
  if (needQueue && !_queueListenCh) {
    _queueListenCh = new BroadcastChannel('media-queue');
    _queueListenCh.onmessage = _onQueueMsg;
    // Fire 'changed' so watchers re-render with current state (covers
    // updates missed while the channel was closed, e.g. on tab refocus).
    queueWatcher.dispatchEvent(new Event('changed'));
  } else if (!needQueue && _queueListenCh) {
    _queueListenCh.close();
    _queueListenCh = null;
  }
}




