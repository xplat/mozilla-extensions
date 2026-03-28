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

  var _dir     = null;  // current directory (file:// URL)
  var _file    = null;  // selected filename within _dir (or null)
  var _listing = [];    // sorted/filtered entry objects from latest fetch
  var _selIdx  = -1;    // DOM index of highlighted item (-1 = none)

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
      if (selIdx >= 0) selectItem(selIdx, false);
      showMediaFile(_file);
    } else {
      var firstFile = _listing.findIndex(function(i) { return isSelectable(i) && i.t !== 'd'; });
      if (firstFile >= 0) selectItem(firstFile, false);
      else if (_listing.length > 0) selectItem(0, false);
    }
  }

  // ── Selector rendering ──────────────────────────────────────────────────────

  function renderSelector() {
    fileListEl.innerHTML = '';
    _selIdx = -1;
    fileListEl.classList.toggle('thumbnails', ui.thumbnails);

    _listing.forEach(function(item, idx) {
      var el = document.createElement('div');
      el.className = 'file-item';
      el.dataset.idx = String(idx);

      var sel   = isSelectable(item);
      var mtype = mediaType(item.u);
      if (!sel)              el.classList.add('dimmed');
      if (item.t === 'd')    el.classList.add('is-dir');
      if (mtype === 'video') el.classList.add('is-video');
      if (mtype === 'audio') el.classList.add('is-audio');

      if (ui.thumbnails) {
        _renderThumbItem(el, item);
      } else {
        _renderListItem(el, item);
      }

      if (sel) {
        el.addEventListener('click', function() {
          setFocusMode('selector');
          selectItem(idx, false);
        });
        el.addEventListener('dblclick', function() { openItem(idx); });
      }

      fileListEl.appendChild(el);
    });
  }

  function _renderListItem(el, item) {
    var type   = mediaType(item.u);
    var iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = item.t === 'd' ? '>' : type === 'video' ? '▶' : type === 'audio' ? '♪' : ' ';

    var nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = item.u;

    var metaEl = document.createElement('span');
    metaEl.className = 'file-meta';
    if (item.s !== undefined) metaEl.textContent = fmtSize(item.s);

    el.appendChild(iconEl);
    el.appendChild(nameEl);
    el.appendChild(metaEl);
  }

  function _renderThumbItem(el, item) {
    var type = mediaType(item.u);
    if (item.t === 'd' || type === 'unknown') {
      var iconEl = document.createElement('span');
      iconEl.className = 'file-icon';
      iconEl.textContent = (item.t === 'd') ? '>' : ' ';
      var labelEl = document.createElement('span');
      labelEl.className = 'thumb-label';
      labelEl.textContent = item.u;
      el.appendChild(iconEl);
      el.appendChild(labelEl);
    } else {
      var fallback = type === 'video' ? '▶' : type === 'audio' ? '♪' : null;
      var fileUrl  = _dir.replace(/\/$/, '') + '/' + item.u;
      var imgEl    = document.createElement('img');
      imgEl.className = 'thumb-img thumb-loading';
      imgEl.src       = toProxyThumb(fileUrl);
      imgEl.alt       = '';
      imgEl.draggable = false;
      imgEl.loading   = 'lazy';
      imgEl.addEventListener('load',  function() { imgEl.classList.remove('thumb-loading'); });
      imgEl.addEventListener('error', function() {
        imgEl.classList.remove('thumb-loading');
        if (fallback) {
          var fbEl = document.createElement('span');
          fbEl.className = 'thumb-img-fallback';
          fbEl.textContent = fallback;
          el.replaceChild(fbEl, imgEl);
        } else {
          imgEl.classList.add('thumb-missing');
        }
      });
      var labelEl = document.createElement('span');
      labelEl.className = 'thumb-label';
      labelEl.textContent = item.u;
      el.appendChild(imgEl);
      el.appendChild(labelEl);
    }
  }

  // ── Item selection ──────────────────────────────────────────────────────────

  function selectItem(idx, scroll) {
    if (idx < 0 || idx >= _listing.length) return;
    var prev = fileListEl.querySelector('.file-item.selected');
    if (prev) prev.classList.remove('selected');
    _selIdx = idx;
    var el = fileListEl.children[idx];
    if (!el) return;
    el.classList.add('selected');
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
      setFocusMode('selector');
    } else {
      _file = item.u;
      persistState(false);
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
    selectItem(li, true);
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
    selectItem(li, true);
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
    var start = _selIdx < 0 ? (delta > 0 ? -1 : _listing.length) : _selIdx;
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
    renderSelector();
    if (ui.thumbnails && _dir) fetch(toProxyQueueDir(_dir)).catch(function() {});
    if (_selIdx >= 0) {
      var el = fileListEl.children[_selIdx];
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
      if (i >= 0) selectItem(i, true);
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
        if (_selIdx >= 0) openItem(_selIdx);
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
    get currentDir()  { return _dir;     },
    get currentFile() { return _file;    },
    get listing()     { return _listing; },
    get selectedIdx() { return _selIdx;  },

    loadDir:          loadDir,
    openItem:         openItem,
    nextFile:         nextFile,
    prevFile:         prevFile,
    goToParent:       goToParent,
    moveSelectionBy:  moveSelectionBy,
    jumpToEdge:       jumpToEdge,
    selectItem:       selectItem,
    renderSelector:   renderSelector,
    updateDirPath:    updateDirPath,
    displayableFiles: displayableFiles,
    handleKey:           handleKey,
    handleQueueKey:   handleQueueKey,
    toggleThumbnails: toggleThumbnails,
    toggleRecursive:  toggleRecursive,
    toggleHidden:     toggleHidden,
    cycleSortBy:      cycleSortBy,
    setFromHistory:   setFromHistory,
  };

})();
