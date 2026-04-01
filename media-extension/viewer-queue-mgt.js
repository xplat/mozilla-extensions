'use strict';
// ── viewer-queue-mgt.js ───────────────────────────────────────────────────────
//
// Queue state, BroadcastChannel queue listener, mode switching, queue pane
// rendering, video-queue navigation, directory-collection helpers, and the
// queue-pane keyboard handler.
//
// Declares these globals used by other modules:
//   _qState, _queueSelIdx,
//   cycleQueueMode, renderQueuePane, handleQueueFocusKey,
//   updateQueueChannelWiring,
//   _vqLoad, _vqNext, _vqPrev,
//   _collectAndQueueDir.
//
// Calls into globals defined in earlier / later modules:
//   ui, focusMode, setFocusMode, applySelector,     (viewer-ui.js)
//   queueListEl, queueClearBtn,                      (viewer-ui.js)
//   _bcPost, toProxyDir, mediaType, showMediaFile,   (viewer.js)
//   _pendingQueuePlay.                               (viewer.js)

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

// ── Queue pane cursor ─────────────────────────────────────────────────────────

var _queueSelIdx = 0;

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
  _queueSelIdx      = index;
  var item          = items[index];
  var fullPath      = item.dir.replace(/\/$/, '') + '/' + item.file;
  var newItem       = (index !== _qState.video.index);
  if (newItem) _qState.video.time = 0;  // new item — start from beginning
  showMediaFile(item.file, fullPath, /*isQueueItem=*/ true);
  if (newItem) _bcPost('media-queue', { cmd: 'q-jump', type: 'video', index: index });
}
function _vqNext() { _vqLoad(_qState.video.index + 1); }
function _vqPrev() { _vqLoad(_qState.video.index - 1); }

// ── Queue mode switching ──────────────────────────────────────────────────────

// Cycle: null → 'audio' → 'video' → null
function cycleQueueMode() {
  var modes = [null, 'audio', 'video'];
  _setQueueMode(modes[(modes.indexOf(ui.queueMode) + 1) % modes.length]);
}

function setQueueMode(mode) {
  var old = ui.queueMode;
  ui.queueMode = mode;

  setFocusMode('list'); // XXX Focus should return to where it was if it goes
                        //     a full cycle without a manual switch, probably.

  if (mode === 'video' && old !== 'video') {
    // Entering video queue mode: show queue pane with cursor at current index.
    // The item is NOT loaded here — user must press Enter/Space in the queue
    // pane.  This prevents a video starting every time the user passes through
    // video-queue mode cycling toward audio-queue mode.
    _queueSelIdx  = _qState.video.index;
  } else if (mode === 'audio' && old !== 'audio') {
    _queueSelIdx = _qState.audio.index;
  }

  applySelector();
  renderQueuePane();
  _updateChannelWiring();
  return;
}

// ── Queue pane rendering ──────────────────────────────────────────────────────

// Render the queue playlist into #queue-list based on current _qState.
function renderQueuePane() {
  if (!queueListEl) return;
  if (!ui.queueMode) { queueListEl.innerHTML = ''; return; }

  var isAudio = (ui.queueMode === 'audio');
  var q       = isAudio ? _qState.audio : _qState.video;
  var items   = isAudio ? _qAudioItems() : _qVideoItems();
  queueListEl.innerHTML = '';

  items.forEach(function(item, idx) {
    var el   = document.createElement('div');
    el.className = 'file-item' +
                   (idx === q.index ? ' active' : '') +
                   (idx === _queueSelIdx ? ' selected' : '');
    el.dataset.idx = String(idx);

    var icon = document.createElement('span');
    icon.className   = 'file-icon';
    icon.textContent = isAudio ? '♪' : '▶';

    var name = document.createElement('span');
    name.className   = 'file-name';
    name.textContent = item.file;
    name.title       = item.file;

    el.appendChild(icon);
    el.appendChild(name);

    el.addEventListener('click', function() {
      _bcPost('media-queue', {
        cmd: 'q-jump', type: isAudio ? 'audio' : 'video', index: idx
      });
    });

    queueListEl.appendChild(el);
  });

  // Scroll keyboard-selected (or playing) item into view.
  var sel = queueListEl.querySelector('.selected') ||
            queueListEl.querySelector('.active');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// ── Queue state sync ──────────────────────────────────────────────────────────

// Called when background broadcasts new queue state.
function _onQueueStateUpdate(prev) {
  if (ui.queueMode === 'video') {
    var newIdx = _qState.video.index;
    if (newIdx !== prev.video.index) {
      // Sync cursor only.  Actual loading is done by _vqLoad(), handleQueueFocusKey(),
      // and _onMediaEnded() — not here — so that _pendingQueuePlay is only set when
      // a human action or auto-advance intends playback.
      _queueSelIdx = newIdx;
    }
  } else if (ui.queueMode === 'audio' && _qState.audio.index !== prev.audio.index) {
    // Keep cursor in sync with auto-advances (end-of-track, skip) but not
    // user-initiated jumps (those set _queueSelIdx before posting q-jump).
    _queueSelIdx = _qState.audio.index;
  }
  renderQueuePane();
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
    if (mt === 'audio') audioItems.push({ dir: dirUrl, file: f.u });
    else if (mt === 'video') videoItems.push({ dir: dirUrl, file: f.u });
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

// ── Clear-queue button ────────────────────────────────────────────────────────

if (queueClearBtn) {
  queueClearBtn.addEventListener('click', function() {
    if (!ui.queueMode) return;
    _bcPost('media-queue', {
      cmd: 'q-clear',
      type: ui.queueMode === 'video' ? 'video' : 'audio'
    });
  });
}

// ── Queue-pane keyboard handler ───────────────────────────────────────────────

function handleQueueFocusKey(e, key) {
  var isAudio = (ui.queueMode === 'audio');
  var items   = isAudio ? _qAudioItems() : _qVideoItems();
  if (!items.length) return;
  switch (key) {
    case 'ArrowDown': case 'j':
      e.preventDefault();
      _queueSelIdx = Math.min(items.length - 1, _queueSelIdx + 1);
      renderQueuePane();
      break;
    case 'ArrowUp': case 'k':
      e.preventDefault();
      _queueSelIdx = Math.max(0, _queueSelIdx - 1);
      renderQueuePane();
      break;
    case 'Enter': case ' ':
      e.preventDefault();
      if (isAudio) {
        _bcPost('media-queue', { cmd: 'q-jump', type: 'audio', index: _queueSelIdx });
      } else {
        // Load directly (don't wait for q-changed round-trip) so it works even
        // when the queue index doesn't change (first Enter after entering queue mode).
        _vqLoad(_queueSelIdx);
        setFocusMode('viewer');
      }
      break;
    case 'Escape': case 'ArrowLeft':
      e.preventDefault();
      setQueueMode(null);
      break;
  }
}
