'use strict';
// ── viewer-queue-mgt.js ───────────────────────────────────────────────────────
//
// Queue state, BroadcastChannel queue listener, mode switching, queue pane
// FileList subclasses, video-queue navigation, and directory-collection helpers.
//
// Declares these globals used by other modules:
//   _qState,
//   audioQueueList, videoQueueList,
//   cycleQueueMode, setQueueMode,
//   updateQueueChannelWiring,
//   _vqLoad, _vqNext, _vqPrev,
//   _collectAndQueueDir.
//
// Calls into globals defined in earlier / later modules:
//   ui, focusMode, setFocusMode, applySelector,                (viewer-ui.js)
//   audioQueuePaneEl, audioQueueClearBtn,                      (viewer-ui.js)
//   videoQueuePaneEl, videoQueueClearBtn,                      (viewer-ui.js)
//   _bcPost, toProxyDir, mediaType, showMediaFile,             (viewer.js)
//   _pendingQueuePlay.                                         (viewer.js)

// ── Queue state (mirrored from background via BroadcastChannel) ───────────────
//
// Only volatile bits (index, time, playing, suppressed) come over the wire.
// Items live in localStorage and are read via _qAudioItems()/_qVideoItems()
// so large arrays are never pushed through the channel.

var _qState = {
  audio: { index: 0, time: 0, playing: false, suppressed: false },
  video: { index: 0, time: 0 }
};

function _qAudioItems() {
  try { return JSON.parse(localStorage.getItem('media-audio-queue') || '{}').items || []; }
  catch (e) { return []; }
}
function _qVideoItems() {
  try { return JSON.parse(localStorage.getItem('media-video-queue') || '{}').items || []; }
  catch (e) { return []; }
}

// ── Queue BroadcastChannel listener ──────────────────────────────────────────

var _queueListenCh = null;

function _onQueueMsg(e) {
  if (!e.data || e.data.cmd !== 'q-changed') return;
  var prev = _qState;
  _qState  = { audio: e.data.audio, video: e.data.video };
  _onQueueStateUpdate(prev);
}

// Open or close the queue listener channel based on visibility and queueMode.
// Called from _updateChannelWiring() in viewer.js whenever relevant state changes.
function updateQueueChannelWiring(visible) {
  var needQueue = visible && ui.queueMode !== null;
  if (needQueue && !_queueListenCh) {
    _queueListenCh = new BroadcastChannel('media-queue');
    _queueListenCh.onmessage = _onQueueMsg;
    _queueListenCh.postMessage({ cmd: 'q-sync' });  // catch up on missed updates
  } else if (!needQueue && _queueListenCh) {
    _queueListenCh.close();
    _queueListenCh = null;
  }
}

// ── Video-queue navigation ────────────────────────────────────────────────────
//
// Load a video queue item directly rather than waiting for the q-changed
// round-trip.  Sets _pendingQueuePlay so the new item autoplays.
// Deliberately do NOT touch selector.currentDir/currentFile — those are
// selector state.  fullPath is passed explicitly so persistState() never bakes
// the queue item's directory into the browser URL.

function _vqLoad(index) {
  var items = _qVideoItems();
  if (index < 0 || index >= items.length) return;
  _pendingQueuePlay = true;
  var item          = items[index];
  var fullPath      = item.p.replace(/\/$/, '') + '/' + item.u;
  var newItem       = (index !== _qState.video.index);
  if (newItem) _qState.video.time = 0;  // new item — start from beginning
  videoQueueList.markActive(index, true);  // optimistic cursor update
  showMediaFile(item.u, fullPath, /*isQueueItem=*/ true, /*queueIndex=*/ index);
  if (newItem) _bcPost('media-queue', { cmd: 'q-jump', type: 'video', index: index });
}
function _vqNext() { _vqLoad(_qState.video.index + 1); }
function _vqPrev() { _vqLoad(_qState.video.index - 1); }

// ── Queue mode switching ──────────────────────────────────────────────────────

// Cycle: null → 'audio' → 'video' → null
function cycleQueueMode() {
  var modes = [null, 'audio', 'video'];
  setQueueMode(modes[(modes.indexOf(ui.queueMode) + 1) % modes.length]);
}

function setQueueMode(mode) {
  ui.queueMode = mode;

  setFocusMode('list'); // XXX Focus should return to where it was if it goes
                        //     a full cycle without a manual switch, probably.

  applySelector();
  _updateChannelWiring();

  // Populate the newly-visible queue pane.  block:'start' so the active item
  // and the next few items after it are visible, giving context for what plays.
  if (mode === 'audio') {
    audioQueueList.listing = _qAudioItems();
    audioQueueList.markActive(_qState.audio.index, true, 'start');
    audioQueueList.selectItem(_qState.audio.index, false);
  } else if (mode === 'video') {
    videoQueueList.listing = _qVideoItems();
    videoQueueList.markActive(_qState.video.index, true, 'start');
    videoQueueList.selectItem(_qState.video.index, false);
  }
}

// ── Queue state sync ──────────────────────────────────────────────────────────

// Called when background broadcasts new queue state.  Refreshes the visible
// queue pane listing and syncs the active-item cursor.
function _onQueueStateUpdate(prev) {
  if (ui.queueMode === 'audio') {
    // Re-read items in case q-add or q-clear changed the list.
    audioQueueList.listing = _qAudioItems();
    audioQueueList.markActive(_qState.audio.index, true);
  } else if (ui.queueMode === 'video') {
    videoQueueList.listing = _qVideoItems();
    // Sync cursor only.  Actual loading is done by _vqLoad() — not here —
    // so that _pendingQueuePlay is only set when playback is truly intended.
    videoQueueList.markActive(_qState.video.index, true);
  }
}

// ── Directory collection ──────────────────────────────────────────────────────
//
// Called by selector.handleQueueKey() — _bcPost and toProxyDir are page-scope
// globals defined in viewer.js (future: viewer-audio.js / viewer-shared.js).

async function _collectAndQueueDir(dirUrl) {
  var audioItems = [], videoItems = [];
  await _collectQueueables(dirUrl, audioItems, videoItems);
  if (audioItems.length) {
    _bcPost('media-queue', { cmd: 'q-add', type: 'audio', items: audioItems });
  }
  if (videoItems.length) {
    _bcPost('media-queue', { cmd: 'q-add', type: 'video', items: videoItems });
  }
}

async function _collectQueueables(dirUrl, audioItems, videoItems) {
  var resp = await fetch(toProxyDir(dirUrl, false));
  if (!resp.ok) return;
  var data  = await resp.json();
  var items = data.files || [];

  var dirs  = items.filter(function(i) { return i.t === 'd'; });
  var files = items.filter(function(i) { return i.t !== 'd'; });

  files.sort(function(a, b) {
    return a.u.toLowerCase().localeCompare(b.u.toLowerCase());
  });
  files.forEach(function(f) {
    var mt = mediaType(f.u);
    if (mt === 'audio') audioItems.push(Object.assign({}, f, { p: dirUrl }));
    else if (mt === 'video') videoItems.push(Object.assign({}, f, { p: dirUrl }));
  });

  // Recurse only into subdirectories named like "CD 1", "Disc 2", etc.
  var cdDirs = dirs.filter(function(d) { return /^(CD|Disc)\s*\d+$/i.test(d.u); });
  cdDirs.sort(function(a, b) {
    return parseInt(a.u.match(/\d+/)[0]) - parseInt(b.u.match(/\d+/)[0]);
  });
  for (var i = 0; i < cdDirs.length; i++) {
    await _collectQueueables(
      dirUrl.replace(/\/$/, '') + '/' + cdDirs[i].u, audioItems, videoItems
    );
  }
}

// ── Clear-queue buttons ───────────────────────────────────────────────────────

if (audioQueueClearBtn) {
  audioQueueClearBtn.addEventListener('click', function() {
    _bcPost('media-queue', { cmd: 'q-clear', type: 'audio' });
  });
}
if (videoQueueClearBtn) {
  videoQueueClearBtn.addEventListener('click', function() {
    _bcPost('media-queue', { cmd: 'q-clear', type: 'video' });
  });
}

// ── Queue pane FileList subclasses ────────────────────────────────────────────

class AudioQueueList extends FileList {
  constructor(ui, el) { super(ui, el); }

  fullPathOf(item) { return item.p.replace(/\/$/, '') + '/' + item.u; }

  // Open an audio queue item: mark active optimistically, then broadcast
  // q-jump.  Audio plays in the background script, so we stay in list focus.
  openItem(idx, passive = false) {
    const items = _qAudioItems();
    if (idx < 0 || idx >= items.length) return;
    this.markActive(idx, true);
    _bcPost('media-queue', { cmd: 'q-jump', type: 'audio', index: idx });
  }

  goToParent() { setQueueMode(null); }
}

class VideoQueueList extends FileList {
  constructor(ui, el) { super(ui, el); }

  fullPathOf(item) { return item.p.replace(/\/$/, '') + '/' + item.u; }

  // Open a video queue item: load directly (don't wait for q-changed round-trip)
  // so it works even when the queue index doesn't change (first Enter after
  // entering video-queue mode).  Switch to viewer focus so the user can control
  // the video immediately.
  openItem(idx, passive = false) {
    _vqLoad(idx);
    if (!passive) setFocusMode('viewer');
  }

  goToParent() { setQueueMode(null); }
}

var audioQueueList = new AudioQueueList(ui, audioQueuePaneEl);
var videoQueueList = new VideoQueueList(ui, videoQueuePaneEl);
