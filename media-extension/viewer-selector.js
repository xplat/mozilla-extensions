'use strict';
// ── Selector module ──────────────────────────────────────────────────────────
//
// Owns all selector-pane state: the current directory, the selected file, the
// directory listing, and the UI index of the highlighted item.  Nothing outside
// this module should write to these — callers read via the getter properties and
// drive changes through the public methods.
//
// Calls into globals that remain in viewer.js for now (will migrate in later
// refactor passes): showMediaFile, persistState, applyUiState, setFocusMode,
// toggleZoom, showScreen, mediaType, toProxyDir, toProxyQueueDir, toProxyThumb,
// fmtSize, _bcPost, _collectAndQueueDir,
// ui, fileListEl, dirPathEl, btnRecursive, btnHidden, btnSort.

var selector = (function() {

  // ── Private state ───────────────────────────────────────────────────────────

  var _dir     = null;     // current directory (file:// URL)
  var _file    = null;     // selected filename within _dir (or null)
  var _listing = [];       // sorted/filtered entry objects from latest fetch
  var _selIdx  = -1;       // DOM index of selected item (-1 = none)
  var _activeIdx  = -1;    // DOM index of active item (-1 = none)
  var _items   = [];       // flat array of .file-item elements, parallel to _listing
  var _listenersWired = false;

  // ── Listing utilities ───────────────────────────────────────────────────────

  function isSelectable(item) {
    if (item.t === 'd') return true;
    if (item.r === 0)   return false;
    return mediaType(item.u) !== 'unknown';
  }

  function sortItems(items) {
    var dirs  = items.filter(function(i) { return i.t === 'd'; });
    var files = items.filter(function(i) { return i.t !== 'd'; });
    function cmp(a, b) {
      if (ui.sortBy === 'mtime') return (b.m || 0) - (a.m || 0);
      if (ui.sortBy === 'size')  return (b.s || 0) - (a.s || 0);
      return a.u.toLowerCase().localeCompare(b.u.toLowerCase());
    }
    dirs.sort(cmp);
    files.sort(cmp);
    return dirs.concat(files);
  }

  function filterItems(items) {
    if (ui.showHidden) return items;
    return items.filter(function(i) {
      var base = i.u.replace(/\/$/, '').split('/').pop();
      return base.charAt(0) !== '.';
    });
  }

  function displayableFiles() {
    return _listing.filter(function(i) { return isSelectable(i) && i.t !== 'd'; });
  }

  // ── Directory loading ───────────────────────────────────────────────────────

  async function loadDir(dirUrl, push) {
    showScreen('loading');

    var proxyUrl = toProxyDir(dirUrl, ui.recursive);
    var data;
    try {
      var resp = await fetch(proxyUrl);
      if (!resp.ok) throw new Error('Server returned HTTP ' + resp.status);
      data = await resp.json();
    } catch (err) {
      document.getElementById('error-message').textContent = String(err);
      showScreen('error');
      return;
    }

    var items = filterItems(data.files || []);
    _listing  = sortItems(items);
    _dir      = dirUrl;

    if (_file && !_listing.some(function(i) { return i.u === _file; })) {
      _file = null;
    }

    persistState(push, dirUrl, _file);
    renderSelector();
    if (ui.thumbnails) fetch(toProxyQueueDir(dirUrl)).catch(function() {});
    updateDirPath();
    applyUiState();
    showScreen('viewer');

    if (_file) {
      var selIdx = _listing.findIndex(function(i) { return i.u === _file; });
      if (selIdx >= 0) markActive(selIdx, false);
      showMediaFile(_file);
    } else {
      var firstFile = _listing.findIndex(function(i) { return isSelectable(i) && i.t !== 'd'; });
      if (firstFile >= 0) selectItem(firstFile, false);
      else if (_listing.length > 0) selectItem(0, false);
    }
  }

  // ── Selector rendering ──────────────────────────────────────────────────────

  // Items are grouped into fixed-height .item-chunk containers so that
  // content-visibility: auto on each chunk lets Gecko skip building frame trees
  // for the ~900 off-screen chunks in a large directory.
  var CHUNK_SIZE = 100;

  // Wire delegated event listeners on fileListEl once.  click/dblclick bubble
  // naturally; load/error on <img> do not, so those use capture.
  function _wireListeners() {
    if (_listenersWired) return;
    _listenersWired = true;

    fileListEl.addEventListener('click', function(e) {
      var el = e.target.closest('.file-item');
      if (!el || el.classList.contains('dimmed')) return;
      setFocusMode('list');
      selectItem(parseInt(el.dataset.idx, 10), false);
    });

    fileListEl.addEventListener('dblclick', function(e) {
      var el = e.target.closest('.file-item');
      if (!el || el.classList.contains('dimmed')) return;
      openItem(parseInt(el.dataset.idx, 10));
    });

    fileListEl.addEventListener('load', function(e) {
      var t = e.target;
      if (t.tagName !== 'IMG' || !t.classList.contains('thumb-img')) return;
      t.classList.remove('thumb-loading');
    }, true);

    fileListEl.addEventListener('error', function(e) {
      var t = e.target;
      if (t.tagName !== 'IMG' || !t.classList.contains('thumb-img')) return;
      t.classList.remove('thumb-loading');
      var item = t.closest('.file-item');
      if (item) item.classList.add('thumb-error');
    }, true);
  }

  function renderSelector() {
    _wireListeners();
    fileListEl.innerHTML = '';
    _items  = [];
    _selIdx = -1;
    fileListEl.classList.toggle('thumbnails', ui.thumbnails);

    var chunk = null;
    _listing.forEach(function(item, idx) {
      if (idx % CHUNK_SIZE === 0) {
        chunk = document.createElement('div');
        chunk.className = 'item-chunk';
        fileListEl.appendChild(chunk);
      }

      var el = document.createElement('div');
      el.className = 'file-item';
      el.dataset.idx = String(idx);

      var sel   = isSelectable(item);
      var mtype = mediaType(item.u);
      if (!sel)              el.classList.add('dimmed');
      if (item.t === 'd')    el.classList.add('is-dir');
      if (mtype === 'video') el.classList.add('is-video');
      if (mtype === 'audio') el.classList.add('is-audio');

      _renderItem(el, item);
      _items.push(el);
      chunk.appendChild(el);
    });

    // Last chunk may be smaller than CHUNK_SIZE; tell CSS so its height is exact.
    var tail = _listing.length % CHUNK_SIZE;
    if (tail !== 0 && chunk) chunk.style.setProperty('--chunk-size', tail);
  }

  // Renders all child elements for a file-item in a single pass.  The same DOM
  // serves both list and thumbnail modes; viewer.css toggles visibility via the
  // .thumbnails class on the parent list.  load/error events are handled by
  // delegated capture listeners on fileListEl rather than per-element.
  function _renderItem(el, item) {
    var type = mediaType(item.u);

    var iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = item.t === 'd' ? '>' : type === 'video' ? '▶' : type === 'audio' ? '♪' : ' ';
    el.appendChild(iconEl);

    // Thumbnail image — created for every non-directory, non-unknown item so
    // that switching to thumbnail mode needs only a class toggle on the list.
    // loading="lazy" keeps the image unfetched while display:none in list mode.
    // has-thumb marks items that carry a thumbnail slot (avoids :has() in CSS).
    if (item.t !== 'd' && type !== 'unknown') {
      el.classList.add('has-thumb');
      var fileUrl = _dir.replace(/\/$/, '') + '/' + item.u;
      var imgEl   = document.createElement('img');
      imgEl.className = 'thumb-img thumb-loading';
      imgEl.src       = toProxyThumb(fileUrl);
      imgEl.alt       = '';
      imgEl.draggable = false;
      imgEl.loading   = 'lazy';
      el.appendChild(imgEl);
    }

    var nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = item.u;
    el.appendChild(nameEl);

    var metaEl = document.createElement('span');
    metaEl.className = 'file-meta';
    if (item.s !== undefined) metaEl.textContent = fmtSize(item.s);
    el.appendChild(metaEl);
  }

  // ── Item selection ──────────────────────────────────────────────────────────

  function selectItem(idx, scroll) {
    if (idx >= _listing.length) return;
    var prev = fileListEl.querySelector('.file-item.selected');
    if (prev) prev.classList.remove('selected');
    _selIdx = idx;
    if (idx < 0) return;
    var el = _items[idx];
    if (!el) return;
    el.classList.add('selected');
    if (scroll) el.scrollIntoView({ block: 'center' });
  }

  function markActive(idx, scroll) {
    if (idx < 0 || idx >= _listing.length) return;
    var prev = fileListEl.querySelector('.file-item.active');
    if (prev) prev.classList.remove('active');
    _activeIdx = idx;
    var el = _items[idx];
    if (!el) return;
    el.classList.add('active');
    if (scroll) el.scrollIntoView({ block: 'center' });
  }

  // ── Item opening / file navigation ─────────────────────────────────────────

  function openItem(idx) {
    if (idx < 0 || idx >= _listing.length) return;
    var item = _listing[idx];
    if (!isSelectable(item)) return;

    if (item.t === 'd') {
      var newDir = _dir.replace(/\/$/, '') + '/' + item.u.replace(/\/$/, '');
      _file = null;
      loadDir(newDir, true);
      setFocusMode('list');
    } else {
      _file = item.u;
      persistState(false);
      markActive(idx);
      selectItem(-1);
      showMediaFile(item.u);
      setFocusMode('viewer');
    }
  }

  function nextFile() {
    var files = displayableFiles();
    if (files.length === 0) return;
    var idx  = files.findIndex(function(i) { return i.u === _file; });
    var next = files[(idx + 1) % files.length];
    var li   = _listing.findIndex(function(i) { return i.u === next.u; });
    markActive(li, true);
    _file = next.u;
    persistState(false);
    showMediaFile(next.u);
  }

  function prevFile() {
    var files = displayableFiles();
    if (files.length === 0) return;
    var idx  = files.findIndex(function(i) { return i.u === _file; });
    var prev = files[(idx - 1 + files.length) % files.length];
    var li   = _listing.findIndex(function(i) { return i.u === prev.u; });
    markActive(li, true);
    _file = prev.u;
    persistState(false);
    showMediaFile(prev.u);
  }

  function goToParent() {
    var path       = _dir.replace(/^file:\/\//, '').replace(/\/$/, '');
    var parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    _file = null;
    loadDir('file://' + parentPath, true);
  }

  // ── Keyboard navigation helpers ─────────────────────────────────────────────

  function moveSelectionBy(delta) {
    if (_listing.length === 0) return;
    var start = _selIdx < 0 ? (_activeIdx < 0 ? (delta > 0 ? -1 : _listing.length) : _activeIdx) : _selIdx;
    var step  = delta > 0 ? 1 : -1;
    var count = Math.abs(delta);
    var cur   = start;
    for (var moved = 0; moved < count; ) {
      var next = cur + step;
      if (next < 0 || next >= _listing.length) break;
      cur = next;
      if (isSelectable(_listing[cur])) moved++;
    }
    if (cur !== start && cur >= 0 && cur < _listing.length) selectItem(cur, true);
  }

  function jumpToEdge(dir) {
    if (dir > 0) {
      for (var i = 0; i < _listing.length; i++) {
        if (isSelectable(_listing[i])) { selectItem(i, true); return; }
      }
    } else {
      for (var i = _listing.length - 1; i >= 0; i--) {
        if (isSelectable(_listing[i])) { selectItem(i, true); return; }
      }
    }
  }

  // ── Toggle operations ───────────────────────────────────────────────────────

  function toggleThumbnails() {
    ui.thumbnails = !ui.thumbnails;
    persistState(false);
    fileListEl.classList.toggle('thumbnails', ui.thumbnails);
    if (ui.thumbnails && _dir) fetch(toProxyQueueDir(_dir)).catch(function() {});
    if (_selIdx >= 0) {
      var el = _items[_selIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function toggleRecursive() {
    ui.recursive = !ui.recursive;
    if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
    persistState(false);
    if (_dir) loadDir(_dir, false);
  }

  function toggleHidden() {
    ui.showHidden = !ui.showHidden;
    if (btnHidden) btnHidden.classList.toggle('active', ui.showHidden);
    persistState(false);
    if (_dir) loadDir(_dir, false);
  }

  function cycleSortBy() {
    var orders = ['name', 'mtime', 'size'];
    var idx    = orders.indexOf(ui.sortBy);
    ui.sortBy  = orders[(idx + 1) % orders.length];
    persistState(false);
    _listing = sortItems(_listing);
    renderSelector();
    var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
    if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
    if (_file) {
      var i = _listing.findIndex(function(x) { return x.u === _file; });
      if (i >= 0) markActive(i, true);
    }
  }

  // ── Info / path display ─────────────────────────────────────────────────────

  function updateDirPath() {
    if (!dirPathEl || !_dir) return;
    var path = _dir.replace(/^file:\/\//, '');
    dirPathEl.textContent = path;
    dirPathEl.title       = path;
    document.title        = path + ' — Media Viewer';
  }

  // ── Key handler ─────────────────────────────────────────────────────────────

  function handleKey(e, key, ctrl, plain) {
    if (!ctrl && key === 'R') {
      if (_dir) loadDir(_dir, false);
      return;
    }
    if (ctrl) return;
    switch (key) {
      case 'ArrowDown':  e.preventDefault(); moveSelectionBy(1);   break;
      case 'ArrowUp':    e.preventDefault(); moveSelectionBy(-1);  break;
      case 'j':                              moveSelectionBy(1);   break;
      case 'k':                              moveSelectionBy(-1);  break;
      case 'PageDown':   e.preventDefault(); moveSelectionBy(10);  break;
      case 'PageUp':     e.preventDefault(); moveSelectionBy(-10); break;
      case 'Home':       e.preventDefault(); jumpToEdge(1);        break;
      case 'End':        e.preventDefault(); jumpToEdge(-1);       break;
      case 'Enter':      e.preventDefault();
        if (_selIdx >= 0) openItem(_selIdx); else setFocusMode('viewer');
        break;
      case ' ':          e.preventDefault();
        if (_selIdx >= 0) openItem(_selIdx);
        break;
      case 'ArrowRight': e.preventDefault();
        if (_selIdx >= 0 && _listing[_selIdx] && _listing[_selIdx].t === 'd') {
          openItem(_selIdx);
        } else {
          nextFile();
        }
        break;
      case 'ArrowLeft':
      case 'Backspace':
      case 'u':          e.preventDefault(); goToParent(); break;
      case 'n':          nextFile(); break;
      case 'b':          prevFile(); break;
      case 'q':          handleQueueKey(); break;
      case 's':          cycleSortBy(); break;
      case 'z':          toggleZoom(); break;
    }
  }

  // ── Queue key handling ──────────────────────────────────────────────────────

  // Called when the user presses 'q' with selector focus.
  // On a file: add it to the appropriate queue and advance to the next item.
  // On a directory: collect all queueable files (respecting CD/Disc subdirs)
  // and add them without advancing the cursor.
  function handleQueueKey() {
    if (_selIdx < 0 || !_listing[_selIdx]) return;
    var item = _listing[_selIdx];
    if (item.t === 'd') {
      var dirUrl = _dir.replace(/\/$/, '') + '/' + item.u;
      _collectAndQueueDir(dirUrl).catch(function() {});
    } else {
      var mt = mediaType(item.u);
      if (mt !== 'audio' && mt !== 'video') return;
      _bcPost('media-queue', {
        cmd: 'q-add', type: mt,
        items: [{ dir: _dir, file: item.u }]
      });
      nextFile();
    }
  }

  // ── Initialisation helpers ──────────────────────────────────────────────────

  // Set dir + file from URL params / history state without triggering a load.
  // Call before loadDir() when restoring history state.
  function setFromHistory(dir, file) {
    _dir  = dir  || null;
    _file = file || null;
  }

  // ── Public interface ────────────────────────────────────────────────────────

  return {
    get currentDir()  { return _dir;        },
    get currentFile() { return _file;       },
    get listing()     { return _listing;    },
    get activeIdx()   { return _activeIdx;  },
    get selectedIdx() { return _selIdx;     },


    loadDir:          loadDir,
    openItem:         openItem,
    nextFile:         nextFile,
    prevFile:         prevFile,
    goToParent:       goToParent,
    moveSelectionBy:  moveSelectionBy,
    jumpToEdge:       jumpToEdge,
    selectItem:       selectItem,
    markActive:       markActive,
    renderSelector:   renderSelector,
    updateDirPath:    updateDirPath,
    displayableFiles: displayableFiles,
    handleKey:        handleKey,
    handleQueueKey:   handleQueueKey,
    toggleThumbnails: toggleThumbnails,
    toggleRecursive:  toggleRecursive,
    toggleHidden:     toggleHidden,
    cycleSortBy:      cycleSortBy,
    setFromHistory:   setFromHistory,
  };

})();
