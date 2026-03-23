// viewer.js — Media Viewer UI  (no chrome.* / browser.* calls)
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const LOOPBACK          = '127.7.203.98';
const FILE_PROXY_PREFIX = 'http://' + LOOPBACK + '/media-file/';
const DIR_PROXY_PREFIX  = 'http://' + LOOPBACK + '/media-dir/';

const IMAGE_EXTS = new Set([
  'jpg','jpeg','png','gif','webp','avif','bmp','tiff','tif','svg','ico'
]);

// ── Mutable state ──────────────────────────────────────────────────────────

var currentDir   = null;   // current directory as a file:// URL
var currentFile  = null;   // selected filename within currentDir (or null)
var listing      = [];     // sorted array of entry objects from latest dir load

// UI state — persisted in history.state
var ui = {
  zoomFit:         true,
  recursive:       true,
  selectorVisible: true,
  showHidden:      false,
  sortBy:          'name',  // 'name' | 'mtime' | 'size'
  flip:            false,
};

// Fullscreen bookkeeping — NOT persisted (ephemeral)
var selectorStateBeforeFS = true;   // ui.selectorVisible before entering browser FS

// ── DOM refs ───────────────────────────────────────────────────────────────

var pickScreenEl    = document.getElementById('pick-screen');
var loadingScreenEl = document.getElementById('loading-screen');
var errorScreenEl   = document.getElementById('error-screen');
var viewerScreenEl  = document.getElementById('viewer-screen');

var dirPathEl       = document.getElementById('dir-path');
var fileListEl      = document.getElementById('file-list');
var selectorPaneEl  = document.getElementById('selector-pane');
var imagePaneEl     = document.getElementById('image-pane');
var mainImageEl     = document.getElementById('main-image');
var imgSpinnerEl    = document.getElementById('img-spinner');
var infoOverlayEl   = document.getElementById('info-overlay');
var infoContentEl   = document.getElementById('info-content');
var noImageHintEl   = document.getElementById('no-image-hint');

var btnRecursive = document.getElementById('btn-recursive');
var btnHidden    = document.getElementById('btn-hidden');
var btnSort      = document.getElementById('btn-sort');
var btnZoom      = document.getElementById('btn-zoom');
var btnSelector  = document.getElementById('btn-selector');

// ── Screen helpers ─────────────────────────────────────────────────────────

function showScreen(name) {
  pickScreenEl.classList.add('hidden');
  loadingScreenEl.classList.add('hidden');
  errorScreenEl.classList.add('hidden');
  viewerScreenEl.classList.add('hidden');
  document.getElementById(name + '-screen').classList.remove('hidden');
}

// ── URL & history state ────────────────────────────────────────────────────

function getUrlParams() {
  var p = new URLSearchParams(window.location.search);
  return { dir: p.get('dir'), file: p.get('file') };
}

function buildPageUrl(dir, file) {
  var url = '?dir=' + encodeURIComponent(dir);
  if (file) url += '&file=' + encodeURIComponent(file);
  return url;
}

// Persist ui state + (optionally updated) dir/file into history.
function persistState(push, newDir, newFile) {
  var dir  = (newDir  !== undefined) ? newDir  : currentDir;
  var file = (newFile !== undefined) ? newFile : currentFile;
  var state = {
    zoomFit:         ui.zoomFit,
    recursive:       ui.recursive,
    selectorVisible: ui.selectorVisible,
    showHidden:      ui.showHidden,
    sortBy:          ui.sortBy,
    flip:            ui.flip,
  };
  var url = buildPageUrl(dir, file);
  if (push) {
    history.pushState(state, '', url);
  } else {
    history.replaceState(state, '', url);
  }
}

function applyHistoryState(state) {
  if (!state || typeof state !== 'object') return;
  if (typeof state.zoomFit         === 'boolean') ui.zoomFit         = state.zoomFit;
  if (typeof state.recursive       === 'boolean') ui.recursive       = state.recursive;
  if (typeof state.selectorVisible === 'boolean') ui.selectorVisible = state.selectorVisible;
  if (typeof state.showHidden      === 'boolean') ui.showHidden      = state.showHidden;
  if (typeof state.flip            === 'boolean') ui.flip            = state.flip;
  if (['name','mtime','size'].indexOf(state.sortBy) !== -1) ui.sortBy = state.sortBy;
}

// ── Proxy URL helpers ──────────────────────────────────────────────────────

// Convert a file:// URL → proxy URL for fetching via the background.
// e.g. "file:///home/user/pic.jpg" → "http://127.7.203.98/media-file//home/user/pic.jpg"
// The double-slash after the prefix is intentional: the server strips the
// token prefix via split('/', 3) which yields the leading '/' back.
function toProxyFile(fileUrl) {
  var path    = fileUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return FILE_PROXY_PREFIX + encoded;
}

function toProxyDir(dirUrl, recursive) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  var url     = DIR_PROXY_PREFIX + encoded;
  if (recursive) url += '?recursive=1';
  return url;
}

// ── Directory loading ──────────────────────────────────────────────────────

function isDisplayable(filename) {
  var dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTS.has(filename.slice(dot + 1).toLowerCase());
}

function isSelectable(item) {
  if (item.t === 'd') return true;
  if (item.r === 0)   return false;
  return isDisplayable(item.u);
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
    // Show hidden files only when the path segment itself is hidden,
    // not when a parent in a recursive path is hidden.
    var base = i.u.replace(/\/$/, '').split('/').pop();
    return base.charAt(0) !== '.';
  });
}

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
  listing     = sortItems(items);
  currentDir  = dirUrl;

  // If the previously selected file is still present, keep it; otherwise clear.
  if (currentFile && !listing.some(function(i) { return i.u === currentFile; })) {
    currentFile = null;
  }

  persistState(push, dirUrl, currentFile);
  renderSelector();
  updateDirPath();
  applyUiState();
  showScreen('viewer');

  // Re-select / display current file if set.
  if (currentFile) {
    var selIdx = listing.findIndex(function(i) { return i.u === currentFile; });
    if (selIdx >= 0) selectItem(selIdx, /*scroll=*/false);
    showImage(currentFile);
  } else {
    // Highlight first selectable file (but don't auto-open).
    var firstFile = listing.findIndex(function(i) { return isSelectable(i) && i.t !== 'd'; });
    if (firstFile >= 0) selectItem(firstFile, false);
    else if (listing.length > 0) selectItem(0, false);
  }
}

// ── Selector rendering ─────────────────────────────────────────────────────

var selectedIdx = -1;

function renderSelector() {
  fileListEl.innerHTML = '';
  selectedIdx = -1;

  listing.forEach(function(item, idx) {
    var el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.idx = String(idx);

    var sel = isSelectable(item);
    if (!sel)        el.classList.add('dimmed');
    if (item.t==='d') el.classList.add('is-dir');

    var iconEl  = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = (item.t === 'd') ? '▸' : '·';

    var nameEl  = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = item.u;

    var metaEl  = document.createElement('span');
    metaEl.className = 'file-meta';
    if (item.s !== undefined) {
      metaEl.textContent = fmtSize(item.s);
    }

    el.appendChild(iconEl);
    el.appendChild(nameEl);
    el.appendChild(metaEl);

    if (sel) {
      el.addEventListener('click', function() {
        selectItem(idx, false);
      });
      el.addEventListener('dblclick', function() {
        openItem(idx);
      });
    }

    fileListEl.appendChild(el);
  });
}

function selectItem(idx, scroll) {
  if (idx < 0 || idx >= listing.length) return;

  var prev = fileListEl.querySelector('.file-item.selected');
  if (prev) prev.classList.remove('selected');

  selectedIdx = idx;
  var el = fileListEl.children[idx];
  if (!el) return;
  el.classList.add('selected');
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

function openItem(idx) {
  if (idx < 0 || idx >= listing.length) return;
  var item = listing[idx];
  if (!isSelectable(item)) return;

  if (item.t === 'd') {
    var sub = item.u.replace(/\/$/, '');
    var newDir = currentDir.replace(/\/$/, '') + '/' + sub;
    currentFile = null;
    loadDir(newDir, /*push=*/true);
  } else {
    currentFile = item.u;
    persistState(false);
    showImage(item.u);
  }
}

// ── Image display ──────────────────────────────────────────────────────────

function showImage(filename) {
  if (!filename || !currentDir) return;
  var fileUrl  = currentDir.replace(/\/$/, '') + '/' + filename;
  var proxyUrl = toProxyFile(fileUrl);

  imgSpinnerEl.classList.remove('hidden');
  mainImageEl.classList.add('loading');
  noImageHintEl.style.display = 'none';
  mainImageEl.src = proxyUrl;

  if (!infoOverlayEl.classList.contains('hidden')) {
    updateInfoOverlay(filename);
  }
}

mainImageEl.addEventListener('load', function() {
  imgSpinnerEl.classList.add('hidden');
  mainImageEl.classList.remove('loading');
  imagePaneEl.classList.add('image-loaded');
  applyFlip();
});

mainImageEl.addEventListener('error', function() {
  imgSpinnerEl.classList.add('hidden');
  mainImageEl.classList.remove('loading');
});

// ── Zoom ───────────────────────────────────────────────────────────────────

function applyZoom() {
  if (ui.zoomFit) {
    imagePaneEl.classList.remove('zoom-full');
  } else {
    imagePaneEl.classList.add('zoom-full');
  }
  if (btnZoom) {
    btnZoom.textContent = ui.zoomFit ? 'FIT' : '1:1';
    btnZoom.classList.toggle('active', !ui.zoomFit);
  }
}

function toggleZoom() {
  ui.zoomFit = !ui.zoomFit;
  applyZoom();
  persistState(false);
}

// ── Flip ───────────────────────────────────────────────────────────────────

function applyFlip() {
  mainImageEl.classList.toggle('flipped', ui.flip);
}

function toggleFlip() {
  ui.flip = !ui.flip;
  applyFlip();
  persistState(false);
}

// ── Selector visibility (Z) ────────────────────────────────────────────────

function applySelector() {
  viewerScreenEl.classList.toggle('no-selector', !ui.selectorVisible);
  if (btnSelector) btnSelector.classList.toggle('active', !ui.selectorVisible);
}

function toggleSelector() {
  ui.selectorVisible = !ui.selectorVisible;
  applySelector();
  persistState(false);
}

// ── Browser fullscreen (f) ─────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    selectorStateBeforeFS = ui.selectorVisible;
    // Hide selector on entry regardless of Z state.
    ui.selectorVisible = false;
    applySelector();
    document.documentElement.requestFullscreen().catch(function(err) {
      // Restore if the API call fails.
      ui.selectorVisible = selectorStateBeforeFS;
      applySelector();
    });
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', function() {
  if (!document.fullscreenElement) {
    // Restore selector to whatever Z had set it to.
    ui.selectorVisible = selectorStateBeforeFS;
    applySelector();
  }
});

// ── Image navigation ───────────────────────────────────────────────────────

function displayableFiles() {
  return listing.filter(function(i) { return i.t !== 'd' && isSelectable(i); });
}

function nextImage() {
  var files = displayableFiles();
  if (files.length === 0) return;
  var idx = files.findIndex(function(i) { return i.u === currentFile; });
  var next = files[(idx + 1) % files.length];
  var listIdx = listing.findIndex(function(i) { return i.u === next.u; });
  selectItem(listIdx, /*scroll=*/true);
  currentFile = next.u;
  persistState(false);
  showImage(next.u);
}

function prevImage() {
  var files = displayableFiles();
  if (files.length === 0) return;
  var idx = files.findIndex(function(i) { return i.u === currentFile; });
  var prev = files[(idx - 1 + files.length) % files.length];
  var listIdx = listing.findIndex(function(i) { return i.u === prev.u; });
  selectItem(listIdx, /*scroll=*/true);
  currentFile = prev.u;
  persistState(false);
  showImage(prev.u);
}

function goToParent() {
  var path = currentDir.replace(/^file:\/\//, '').replace(/\/$/, '');
  var parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
  var parentUrl  = 'file://' + parentPath;
  currentFile = null;
  loadDir(parentUrl, /*push=*/true);
}

// ── Toggle helpers ─────────────────────────────────────────────────────────

function toggleRecursive() {
  ui.recursive = !ui.recursive;
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
  persistState(false);
  if (currentDir) loadDir(currentDir, false);
}

function toggleHidden() {
  ui.showHidden = !ui.showHidden;
  if (btnHidden) btnHidden.classList.toggle('active', ui.showHidden);
  persistState(false);
  if (currentDir) loadDir(currentDir, false);
}

function cycleSortBy() {
  var orders = ['name', 'mtime', 'size'];
  var idx = orders.indexOf(ui.sortBy);
  ui.sortBy = orders[(idx + 1) % orders.length];
  persistState(false);
  listing = sortItems(listing);
  renderSelector();
  var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
  if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
  if (currentFile) {
    var i = listing.findIndex(function(x) { return x.u === currentFile; });
    if (i >= 0) selectItem(i, true);
  }
}

// ── Info overlay ───────────────────────────────────────────────────────────

function toggleInfoOverlay() {
  var hidden = infoOverlayEl.classList.contains('hidden');
  if (hidden) {
    updateInfoOverlay(currentFile);
    infoOverlayEl.classList.remove('hidden');
  } else {
    infoOverlayEl.classList.add('hidden');
  }
}

function updateInfoOverlay(filename) {
  if (!filename) { infoContentEl.innerHTML = ''; return; }
  var item = listing.find(function(i) { return i.u === filename; });
  var lines = [filename];
  if (item) {
    if (item.s !== undefined) lines.push(fmtSize(item.s));
    if (item.m) lines.push(fmtDate(item.m, /*full=*/true));
  }
  if (mainImageEl.naturalWidth) {
    lines.push(mainImageEl.naturalWidth + '\u00d7' + mainImageEl.naturalHeight + ' px');
  }
  infoContentEl.innerHTML = lines.map(function(l) {
    return '<div>' + escHtml(l) + '</div>';
  }).join('');
}

// ── Apply full UI state ────────────────────────────────────────────────────

function applyUiState() {
  applyZoom();
  applyFlip();
  applySelector();

  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
  if (btnHidden)    btnHidden.classList.toggle('active', ui.showHidden);
  var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
  if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
}

function updateDirPath() {
  if (!dirPathEl || !currentDir) return;
  var path = currentDir.replace(/^file:\/\//, '');
  dirPathEl.textContent = path;
  dirPathEl.title = path;
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      moveSelectionBy(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveSelectionBy(-1);
      break;
    case 'j':
      moveSelectionBy(1);
      break;
    case 'k':
      moveSelectionBy(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (selectedIdx >= 0 && listing[selectedIdx] && listing[selectedIdx].t === 'd') {
        openItem(selectedIdx);
      } else {
        nextImage();
      }
      break;
    case 'ArrowLeft':
    case 'Backspace':
    case 'u':
      e.preventDefault();
      goToParent();
      break;
    case 'Enter':
      e.preventDefault();
      if (selectedIdx >= 0) openItem(selectedIdx);
      break;
    case ' ':
      e.preventDefault();
      if (selectedIdx >= 0 && listing[selectedIdx] && listing[selectedIdx].t !== 'd') {
        openItem(selectedIdx);
      } else {
        nextImage();
      }
      break;
    case 'n':
      nextImage();
      break;
    case 'p':
      prevImage();
      break;
    case 'Home':
      e.preventDefault();
      jumpToEdge(1);
      break;
    case 'End':
      e.preventDefault();
      jumpToEdge(-1);
      break;
    case 'PageDown':
      e.preventDefault();
      moveSelectionBy(10);
      break;
    case 'PageUp':
      e.preventDefault();
      moveSelectionBy(-10);
      break;
    case 'z':
      toggleZoom();
      break;
    case 'Z':
      toggleSelector();
      break;
    case 'f':
      toggleFullscreen();
      break;
    case 'F':
      toggleFlip();
      break;
    case 'r':
      toggleRecursive();
      break;
    case '.':
      toggleHidden();
      break;
    case 's':
      cycleSortBy();
      break;
    case 'i':
      toggleInfoOverlay();
      break;
    case 'q':
      window.close();
      break;
  }
});

function moveSelectionBy(delta) {
  if (listing.length === 0) return;
  var start = selectedIdx < 0 ? (delta > 0 ? -1 : listing.length) : selectedIdx;
  var step  = delta > 0 ? 1 : -1;
  var count = Math.abs(delta);

  var cur = start;
  for (var moved = 0; moved < count; ) {
    var next = cur + step;
    if (next < 0 || next >= listing.length) break;
    cur = next;
    if (isSelectable(listing[cur])) moved++;
  }
  if (cur !== start && cur >= 0 && cur < listing.length) {
    selectItem(cur, /*scroll=*/true);
  }
}

function jumpToEdge(dir) {
  // dir=1: first; dir=-1: last
  if (dir > 0) {
    for (var i = 0; i < listing.length; i++) {
      if (isSelectable(listing[i])) { selectItem(i, true); return; }
    }
  } else {
    for (var i = listing.length - 1; i >= 0; i--) {
      if (isSelectable(listing[i])) { selectItem(i, true); return; }
    }
  }
}

// ── Button listeners ───────────────────────────────────────────────────────

if (btnRecursive) btnRecursive.addEventListener('click', toggleRecursive);
if (btnHidden)    btnHidden.addEventListener('click', toggleHidden);
if (btnSort)      btnSort.addEventListener('click', cycleSortBy);
if (btnZoom)      btnZoom.addEventListener('click', toggleZoom);
if (btnSelector)  btnSelector.addEventListener('click', toggleSelector);

// ── History (back/forward) ─────────────────────────────────────────────────

window.addEventListener('popstate', function(e) {
  applyHistoryState(e.state);
  var params = getUrlParams();

  if (params.dir !== currentDir) {
    currentFile = params.file;
    loadDir(params.dir, /*push=*/false);
  } else {
    currentFile = params.file;
    applyUiState();
    if (currentFile) {
      var idx = listing.findIndex(function(i) { return i.u === currentFile; });
      if (idx >= 0) selectItem(idx, true);
      showImage(currentFile);
    }
  }
});

// ── Utility functions ──────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)                return bytes + '\u00a0B';
  if (bytes < 1024 * 1024)         return (bytes / 1024).toFixed(1) + '\u00a0KB';
  if (bytes < 1024 * 1024 * 1024)  return (bytes / 1048576).toFixed(1) + '\u00a0MB';
  return (bytes / 1073741824).toFixed(1) + '\u00a0GB';
}

function fmtDate(unixSecs, full) {
  var d = new Date(unixSecs * 1000);
  return full ? d.toLocaleString() : d.toLocaleDateString();
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Initialisation ─────────────────────────────────────────────────────────

function init() {
  // Restore UI state from current history entry (exists if page was refreshed
  // mid-session, or on back/forward navigation).
  applyHistoryState(history.state);

  var params = getUrlParams();
  if (!params.dir) {
    showScreen('pick');
    return;
  }

  currentDir  = params.dir;
  currentFile = params.file || null;
  loadDir(params.dir, /*push=*/false);
}

init();
