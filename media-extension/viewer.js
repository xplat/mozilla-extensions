// viewer.js — Media Viewer UI  (no chrome.* / browser.* calls)
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const LOOPBACK          = '127.7.203.98';
const FILE_PROXY_PREFIX      = 'http://' + LOOPBACK + '/media-file/';
const DIR_PROXY_PREFIX       = 'http://' + LOOPBACK + '/media-dir/';
const THUMB_PROXY_PREFIX     = 'http://' + LOOPBACK + '/media-thumb/';
const QUEUE_DIR_PROXY_PREFIX = 'http://' + LOOPBACK + '/media-queue-dir/';

// Maps file extension (lowercase, no dot) → media category.
// Only extensions that should be selectable/viewable belong here;
// anything absent returns 'unknown'.
const MEDIA_TYPES = {
  // images (rendered natively by the browser)
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', tiff: 'image', tif: 'image', svg: 'image', ico: 'image',
  // video
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video',
  mov: 'video', avi: 'video', mkv: 'video', flv: 'video', wmv: 'video', '3gp': 'video',
  // audio
  mp3: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio',
  m4a: 'audio', aac: 'audio', opus: 'audio', wav: 'audio',
};

function mediaType(filename) {
  var dot = filename.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  return MEDIA_TYPES[filename.slice(dot + 1).toLowerCase()] || 'unknown';
}

// Scale steps for s/S keys (xzgv-style integer-ratio stepping)
const SCALE_STEPS = [0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0];

// ── Mutable state ──────────────────────────────────────────────────────────

var currentDir   = null;   // current directory as a file:// URL
var currentFile  = null;   // selected filename within currentDir (or null)
var listing      = [];     // sorted array of entry objects from latest dir load

// UI state — most persisted in history.state
var ui = {
  zoomFit:         true,
  zoomReduceOnly:  true,   // in fit mode: shrink large images but don't enlarge small ones
  recursive:       false,  // off by default (not an xzgv concept)
  selectorVisible: true,
  showHidden:      false,
  sortBy:          'name', // 'name' | 'mtime' | 'size'
  // Selector display
  thumbnails:      false,  // v — thumbnail grid vs filename list
  // Image transform
  rotation:        0,      // 0 | 90 | 180 | 270 (degrees)
  mirror:          false,  // horizontal mirror (m key) — xzgv 'm'
  flip:            false,  // vertical flip   (F key) — xzgv 'f'
  scale:           1.0,    // scale factor when zoomFit=false
};

// Focus mode — NOT persisted (resets to selector on page load)
var focusMode = 'selector'; // 'selector' | 'viewer'

// Selector pane width in pixels (adjusted with [ ] ~ and drag)
var selectorWidthPx = 260;
var SELECTOR_W_DEFAULT = 260;
var SELECTOR_W_MIN     = 80;
var SELECTOR_W_MAX     = 600;

// Drag state — shared across image-pan and divider-resize drags
var dragMode  = null;  // null | 'image' | 'divider'
var dragState = {};

// Fullscreen bookkeeping — NOT persisted
var selectorStateBeforeFS = true;

// ── DOM refs ───────────────────────────────────────────────────────────────

var pickScreenEl    = document.getElementById('pick-screen');
var loadingScreenEl = document.getElementById('loading-screen');
var errorScreenEl   = document.getElementById('error-screen');
var viewerScreenEl  = document.getElementById('viewer-screen');

var dirPathEl       = document.getElementById('dir-path');
var fileListEl      = document.getElementById('file-list');
var selectorPaneEl  = document.getElementById('selector-pane');
var imagePaneEl     = document.getElementById('image-pane');
var transformHostEl = document.getElementById('transform-host');
var mainImageEl     = document.getElementById('main-image');
var imgSpinnerEl    = document.getElementById('img-spinner');
var infoOverlayEl   = document.getElementById('info-overlay');
var infoContentEl   = document.getElementById('info-content');
var noImageHintEl   = document.getElementById('no-image-hint');

var paneDividerEl  = document.getElementById('pane-divider');

var btnRecursive = document.getElementById('btn-recursive');
var btnHidden    = document.getElementById('btn-hidden');
var btnSort      = document.getElementById('btn-sort');

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

function persistState(push, newDir, newFile) {
  var dir  = (newDir  !== undefined) ? newDir  : currentDir;
  var file = (newFile !== undefined) ? newFile : currentFile;
  var state = {
    zoomFit:         ui.zoomFit,
    zoomReduceOnly:  ui.zoomReduceOnly,
    recursive:       ui.recursive,
    selectorVisible: ui.selectorVisible,
    showHidden:      ui.showHidden,
    sortBy:          ui.sortBy,
    thumbnails:      ui.thumbnails,
    rotation:        ui.rotation,
    mirror:          ui.mirror,
    flip:            ui.flip,
    scale:           ui.scale,
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
  if (typeof state.zoomReduceOnly  === 'boolean') ui.zoomReduceOnly  = state.zoomReduceOnly;
  if (typeof state.recursive       === 'boolean') ui.recursive       = state.recursive;
  if (typeof state.selectorVisible === 'boolean') ui.selectorVisible = state.selectorVisible;
  if (typeof state.showHidden      === 'boolean') ui.showHidden      = state.showHidden;
  if (typeof state.thumbnails      === 'boolean') ui.thumbnails      = state.thumbnails;
  if (typeof state.mirror          === 'boolean') ui.mirror          = state.mirror;
  if (typeof state.flip            === 'boolean') ui.flip            = state.flip;
  if (['name','mtime','size'].indexOf(state.sortBy) !== -1) ui.sortBy = state.sortBy;
  if (state.rotation === 0 || state.rotation === 90 ||
      state.rotation === 180 || state.rotation === 270) ui.rotation = state.rotation;
  if (typeof state.scale === 'number' && state.scale > 0) ui.scale  = state.scale;
}

// ── Proxy URL helpers ──────────────────────────────────────────────────────

function toProxyFile(fileUrl) {
  var path    = fileUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return FILE_PROXY_PREFIX + encoded;
}

function toProxyThumb(fileUrl) {
  var path    = fileUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return THUMB_PROXY_PREFIX + encoded;
}

function toProxyDir(dirUrl, recursive) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  var url     = DIR_PROXY_PREFIX + encoded;
  if (recursive) url += '?recursive=1';
  return url;
}

function toProxyQueueDir(dirUrl) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return QUEUE_DIR_PROXY_PREFIX + encoded;
}

// ── Directory loading ──────────────────────────────────────────────────────

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
  listing    = sortItems(items);
  currentDir = dirUrl;

  if (currentFile && !listing.some(function(i) { return i.u === currentFile; })) {
    currentFile = null;
  }

  persistState(push, dirUrl, currentFile);
  renderSelector();
  if (ui.thumbnails) fetch(toProxyQueueDir(dirUrl)).catch(function() {});
  updateDirPath();
  applyUiState();
  showScreen('viewer');

  if (currentFile) {
    var selIdx = listing.findIndex(function(i) { return i.u === currentFile; });
    if (selIdx >= 0) selectItem(selIdx, false);
    showMediaFile(currentFile);
  } else {
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
  fileListEl.classList.toggle('thumbnails', ui.thumbnails);

  listing.forEach(function(item, idx) {
    var el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.idx = String(idx);

    var sel  = isSelectable(item);
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
      el.addEventListener('dblclick', function() {
        openItem(idx);
      });
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
    // Directory or unrecognised type: icon + name as a compact tile
    var iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = (item.t === 'd') ? '>' : ' ';
    var labelEl = document.createElement('span');
    labelEl.className = 'thumb-label';
    labelEl.textContent = item.u;
    el.appendChild(iconEl);
    el.appendChild(labelEl);
  } else {
    // Any known media type: attempt thumbnail; fall back to a text icon on error
    var fallback = type === 'video' ? '▶' : type === 'audio' ? '♪' : null;
    var fileUrl  = currentDir.replace(/\/$/, '') + '/' + item.u;
    var imgEl = document.createElement('img');
    imgEl.className = 'thumb-img thumb-loading';
    imgEl.src = toProxyThumb(fileUrl);
    imgEl.alt = '';
    imgEl.draggable = false;
    imgEl.loading = 'lazy';
    imgEl.addEventListener('load', function() { imgEl.classList.remove('thumb-loading'); });
    imgEl.addEventListener('error', function() {
      imgEl.classList.remove('thumb-loading');
      if (fallback) {
        // Replace broken img with a text icon for video/audio
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
    var sub    = item.u.replace(/\/$/, '');
    var newDir = currentDir.replace(/\/$/, '') + '/' + sub;
    currentFile = null;
    loadDir(newDir, true);
    setFocusMode('selector');
  } else {
    currentFile = item.u;
    persistState(false);
    showMediaFile(item.u);
    setFocusMode('viewer');
  }
}

// ── Image display ──────────────────────────────────────────────────────────

function showImage(filename) {
  if (!filename || !currentDir) return;
  var fileUrl  = currentDir.replace(/\/$/, '') + '/' + filename;
  var proxyUrl = toProxyFile(fileUrl);

  imgSpinnerEl.classList.remove('hidden');
  imagePaneEl.classList.remove('image-loaded');
  mainImageEl.src = proxyUrl;

  if (!infoOverlayEl.classList.contains('hidden')) {
    updateInfoOverlay(filename);
  }

  document.title = filename + ' — Media Viewer';
}

mainImageEl.addEventListener('load', function() {
  imgSpinnerEl.classList.add('hidden');
  imagePaneEl.classList.add('image-loaded');
  applyImageTransform();
});

mainImageEl.addEventListener('error', function() {
  imgSpinnerEl.classList.add('hidden');
});

// ── Image transform ────────────────────────────────────────────────────────
//
// The transform-host div is sized to the image's visual bounding box.
// The img element is absolutely positioned at the center of transform-host
// with CSS transforms for rotation, mirror, and scale.
//
// For 90°/270° rotation, visual W and H are swapped relative to natural dims.

function applyImageTransform() {
  var img  = mainImageEl;
  var host = transformHostEl;
  var pane = imagePaneEl;

  var nw = img.naturalWidth;
  var nh = img.naturalHeight;
  if (!nw || !nh) return;

  var rot = ui.rotation;

  // Visual dimensions at scale=1 (W/H swap for 90°/270° rotation)
  var visW = (rot === 90 || rot === 270) ? nh : nw;
  var visH = (rot === 90 || rot === 270) ? nw : nh;

  // Compute display scale
  var scale;
  if (ui.zoomFit) {
    var pW = pane.clientWidth;
    var pH = pane.clientHeight;
    if (!pW || !pH) return;
    scale = Math.min(pW / visW, pH / visH);
    if (ui.zoomReduceOnly) scale = Math.min(scale, 1.0);
  } else {
    scale = ui.scale;
  }

  var displayW = visW * scale;
  var displayH = visH * scale;

  // Size the transform-host to the image's visual bounding box
  host.style.width  = Math.ceil(displayW) + 'px';
  host.style.height = Math.ceil(displayH) + 'px';

  // Center the img within transform-host, then rotate+mirror+scale
  img.style.position      = 'absolute';
  img.style.width         = nw + 'px';
  img.style.height        = nh + 'px';
  img.style.left          = '50%';
  img.style.top           = '50%';
  img.style.marginLeft    = (-nw / 2) + 'px';
  img.style.marginTop     = (-nh / 2) + 'px';
  img.style.transformOrigin = 'center center';

  var parts = [];
  if (rot)       parts.push('rotate(' + rot + 'deg)');
  if (ui.mirror) parts.push('scaleX(-1)');  // horizontal mirror (m)
  if (ui.flip)   parts.push('scaleY(-1)');  // vertical flip    (F)
  if (scale !== 1) parts.push('scale(' + scale + ')');
  img.style.transform = parts.length ? parts.join(' ') : 'none';

  // Set pane display mode
  if (ui.zoomFit) {
    pane.style.overflow        = 'hidden';
    pane.style.display         = 'flex';
    pane.style.alignItems      = 'center';
    pane.style.justifyContent  = 'center';
    pane.classList.remove('mode-scroll');
  } else {
    pane.style.overflow        = 'auto';
    pane.style.display         = 'block';
    pane.classList.add('mode-scroll');
  }
}

// Reapply transform on window resize (fit mode depends on pane size)
window.addEventListener('resize', function() {
  if (mainImageEl.naturalWidth) applyImageTransform();
});

// ── Zoom ───────────────────────────────────────────────────────────────────

function toggleZoom() {
  ui.zoomFit = !ui.zoomFit;
  if (!ui.zoomFit && ui.scale <= 0) ui.scale = 1.0;
  applyImageTransform();
  persistState(false);
}

// ── Rotation ──────────────────────────────────────────────────────────────

function rotateBy(deg) {
  ui.rotation = (ui.rotation + deg + 360) % 360;
  applyImageTransform();
  persistState(false);
}

// ── Mirror / Flip ─────────────────────────────────────────────────────────

// m — horizontal mirror (xzgv 'm')
function toggleMirror() {
  ui.mirror = !ui.mirror;
  applyImageTransform();
  persistState(false);
}

// F — vertical flip (xzgv 'f', uppercased to avoid conflict with fullscreen)
function toggleFlip() {
  ui.flip = !ui.flip;
  applyImageTransform();
  persistState(false);
}

// ── Orientation reset ─────────────────────────────────────────────────────

function resetOrientation() {
  ui.rotation = 0;
  ui.mirror   = false;
  ui.flip     = false;
  applyImageTransform();
  persistState(false);
}

// ── Scale ─────────────────────────────────────────────────────────────────

function enterScaleMode() {
  // Switch from fit mode to explicit scale mode
  if (ui.zoomFit) {
    ui.zoomFit = false;
    // Compute the current effective fit scale and use it as starting point
    if (mainImageEl.naturalWidth) {
      var nw  = mainImageEl.naturalWidth;
      var nh  = mainImageEl.naturalHeight;
      var rot = ui.rotation;
      var vw  = (rot === 90 || rot === 270) ? nh : nw;
      var vh  = (rot === 90 || rot === 270) ? nw : nh;
      var pW  = imagePaneEl.clientWidth;
      var pH  = imagePaneEl.clientHeight;
      var s   = Math.min(pW / vw, pH / vh);
      if (ui.zoomReduceOnly) s = Math.min(s, 1.0);
      ui.scale = s;
    } else {
      ui.scale = 1.0;
    }
  }
}

function scaleDouble() {
  enterScaleMode();
  ui.scale = Math.min(32, ui.scale * 2);
  applyImageTransform();
  persistState(false);
}

function scaleHalve() {
  enterScaleMode();
  ui.scale = Math.max(0.05, ui.scale / 2);
  applyImageTransform();
  persistState(false);
}

function scaleStep(dir) {
  enterScaleMode();
  var cur = ui.scale;
  if (dir > 0) {
    var next = null;
    for (var i = 0; i < SCALE_STEPS.length; i++) {
      if (SCALE_STEPS[i] > cur + 0.001) { next = SCALE_STEPS[i]; break; }
    }
    ui.scale = (next !== null) ? next : Math.min(32, cur * 1.5);
  } else {
    var prev = null;
    for (var i = 0; i < SCALE_STEPS.length; i++) {
      if (SCALE_STEPS[i] < cur - 0.001) prev = SCALE_STEPS[i];
    }
    ui.scale = (prev !== null) ? prev : Math.max(0.05, cur / 1.5);
  }
  applyImageTransform();
  persistState(false);
}

function scaleTo1() {
  ui.zoomFit = false;
  ui.scale   = 1.0;
  applyImageTransform();
  persistState(false);
}

// ── Image scrolling ───────────────────────────────────────────────────────

function scrollImage(dx, dy) {
  imagePaneEl.scrollLeft += dx;
  imagePaneEl.scrollTop  += dy;
}

// ── Pane width ────────────────────────────────────────────────────────────
// Keyboard: [ narrows, ] widens, ~ resets.  Also set by divider drag.

function setSelectorWidth(w) {
  selectorWidthPx = Math.max(SELECTOR_W_MIN, Math.min(SELECTOR_W_MAX, Math.round(w)));
  document.documentElement.style.setProperty('--selector-w', selectorWidthPx + 'px');
}

function adjustSelectorWidth(delta) {
  setSelectorWidth(selectorWidthPx + delta);
}

// ── Selector visibility ───────────────────────────────────────────────────

function applySelector() {
  viewerScreenEl.classList.toggle('no-selector', !ui.selectorVisible);
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
}

function toggleSelector() {
  ui.selectorVisible = !ui.selectorVisible;
  applySelector();
  persistState(false);
}

// ── Browser fullscreen ─────────────────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    selectorStateBeforeFS = ui.selectorVisible;
    ui.selectorVisible = false;
    applySelector();
    document.documentElement.requestFullscreen().catch(function() {
      ui.selectorVisible = selectorStateBeforeFS;
      applySelector();
    });
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', function() {
  if (!document.fullscreenElement) {
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
  var idx  = files.findIndex(function(i) { return i.u === currentFile; });
  var next = files[(idx + 1) % files.length];
  var li   = listing.findIndex(function(i) { return i.u === next.u; });
  selectItem(li, true);
  currentFile = next.u;
  persistState(false);
  showMediaFile(next.u);
}

function prevImage() {
  var files = displayableFiles();
  if (files.length === 0) return;
  var idx  = files.findIndex(function(i) { return i.u === currentFile; });
  var prev = files[(idx - 1 + files.length) % files.length];
  var li   = listing.findIndex(function(i) { return i.u === prev.u; });
  selectItem(li, true);
  currentFile = prev.u;
  persistState(false);
  showMediaFile(prev.u);
}

function goToParent() {
  var path       = currentDir.replace(/^file:\/\//, '').replace(/\/$/, '');
  var parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
  currentFile    = null;
  loadDir('file://' + parentPath, true);
}

// ── Toggle helpers ─────────────────────────────────────────────────────────

function toggleThumbnails() {
  ui.thumbnails = !ui.thumbnails;
  persistState(false);
  renderSelector();
  if (ui.thumbnails && currentDir) fetch(toProxyQueueDir(currentDir)).catch(function() {});
  // Re-scroll to keep selected item visible after layout change.
  if (selectedIdx >= 0) {
    var el = fileListEl.children[selectedIdx];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

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
  var idx    = orders.indexOf(ui.sortBy);
  ui.sortBy  = orders[(idx + 1) % orders.length];
  persistState(false);
  listing    = sortItems(listing);
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
  if (!filename) { infoContentEl.textContent = ''; return; }
  var item  = listing.find(function(i) { return i.u === filename; });
  var lines = [filename];
  if (item) {
    if (item.s !== undefined) lines.push(fmtSize(item.s));
    if (item.m)               lines.push(fmtDate(item.m, true));
  }
  if (activeMediaEl && isFinite(activeMediaEl.duration)) {
    lines.push(fmtTime(activeMediaEl.duration));
    if (activeMediaEl === videoEl && videoEl.videoWidth) {
      lines.push(videoEl.videoWidth + '\u00d7' + videoEl.videoHeight + ' px');
    }
  } else if (mainImageEl.naturalWidth) {
    lines.push(mainImageEl.naturalWidth + '\u00d7' + mainImageEl.naturalHeight + ' px');
  }
  infoContentEl.textContent = lines.join('\n');
}

// ── Focus mode ─────────────────────────────────────────────────────────────

function setFocusMode(mode) {
  focusMode = mode;
  viewerScreenEl.dataset.focus = mode;
}

// ── Apply full UI state ────────────────────────────────────────────────────

function applyUiState() {
  applySelector();
  if (mainImageEl.naturalWidth) applyImageTransform();

  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
  if (btnHidden)    btnHidden.classList.toggle('active', ui.showHidden);
  var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
  if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
}

function updateDirPath() {
  if (!dirPathEl || !currentDir) return;
  var path = currentDir.replace(/^file:\/\//, '');
  dirPathEl.textContent = path;
  dirPathEl.title       = path;
  document.title        = path + ' — Media Viewer';
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  var key  = e.key;
  var ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  var plain = !e.ctrlKey && !e.altKey && !e.metaKey;

  if (plain) {
    // Global keys regardless of focus mode
    switch (key) {
      case 'Z':
        e.preventDefault(); toggleSelector(); return;
      case 'f':
        e.preventDefault(); toggleFullscreen(); return;
      case 'i':
        e.preventDefault(); toggleInfoOverlay(); return;
      case '.':
        e.preventDefault(); toggleHidden(); return;
      case 'v':
        e.preventDefault(); toggleThumbnails(); return;
      case 'Tab':
        e.preventDefault();
        setFocusMode(focusMode === 'selector' ? 'viewer' : 'selector');
        return;
      case 'Escape':
        if (focusMode === 'viewer') { e.preventDefault(); setFocusMode('selector'); }
        return;
      // Pane-width adjustment (xzgv [ ] ~)
      case '[': e.preventDefault(); adjustSelectorWidth(-16); return;
      case ']': e.preventDefault(); adjustSelectorWidth(+16); return;
      case '~': e.preventDefault(); setSelectorWidth(SELECTOR_W_DEFAULT); return;
    }
  }

  if (focusMode === 'selector') {
    handleSelectorKey(e, key, ctrl, plain);
  } else {
    handleViewerKey(e, key, ctrl, plain);
  }
});

function handleSelectorKey(e, key, ctrl, plain) {
  // R: rescan directory (xzgv Ctrl-r; Ctrl-r unavailable in browser)
  if (!ctrl && key === 'R') {
    if (currentDir) loadDir(currentDir, false);
    return;
  }
  if (ctrl) return; // don't intercept Ctrl shortcuts
  switch (key) {
    case 'ArrowDown':  e.preventDefault(); moveSelectionBy(1);   break;
    case 'ArrowUp':    e.preventDefault(); moveSelectionBy(-1);  break;
    case 'j':          moveSelectionBy(1);   break;
    case 'k':          moveSelectionBy(-1);  break;
    case 'PageDown':   e.preventDefault(); moveSelectionBy(10);  break;
    case 'PageUp':     e.preventDefault(); moveSelectionBy(-10); break;
    case 'Home':       e.preventDefault(); jumpToEdge(1);        break;
    case 'End':        e.preventDefault(); jumpToEdge(-1);       break;
    case 'Enter':
      e.preventDefault();
      if (selectedIdx >= 0) openItem(selectedIdx);
      break;
    case ' ':
      e.preventDefault();
      if (selectedIdx >= 0) openItem(selectedIdx);
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
      e.preventDefault(); goToParent(); break;
    case 'n': nextImage(); break;
    case 'b':
    case 'p': prevImage(); break;
    case 's': cycleSortBy(); break;
    case 'z': toggleZoom(); break;
  }
}

function handleViewerKey(e, key, ctrl, plain) {
  if (plain) {
    switch (key) {
      // Scrolling — 100 px steps
      case 'ArrowUp':    e.preventDefault(); scrollImage(0, -100); break;
      case 'ArrowDown':  e.preventDefault(); scrollImage(0, +100); break;
      case 'ArrowLeft':  e.preventDefault(); scrollImage(-100, 0); break;
      case 'ArrowRight': e.preventDefault(); scrollImage(+100, 0); break;
      // Large scrolling — ~90% of pane
      case 'PageUp':
        e.preventDefault();
        scrollImage(0, -(imagePaneEl.clientHeight * 0.9));
        break;
      case 'PageDown':
        e.preventDefault();
        scrollImage(0, +(imagePaneEl.clientHeight * 0.9));
        break;
      case '-':
        e.preventDefault();
        scrollImage(-(imagePaneEl.clientWidth * 0.9), 0);
        break;
      case '=':
        e.preventDefault();
        scrollImage(+(imagePaneEl.clientWidth * 0.9), 0);
        break;
      // Jump to corners
      case 'Home':
        e.preventDefault();
        imagePaneEl.scrollLeft = 0;
        imagePaneEl.scrollTop  = 0;
        break;
      case 'End':
        e.preventDefault();
        imagePaneEl.scrollLeft = imagePaneEl.scrollWidth;
        imagePaneEl.scrollTop  = imagePaneEl.scrollHeight;
        break;
      // Image navigation
      case ' ': e.preventDefault(); nextImage(); break;
      case 'b':
      case 'p': prevImage(); break;
      // Rotation (xzgv r/R/N)
      case 'r': rotateBy(90);        break;
      case 'R': rotateBy(-90);       break;
      case 'N': resetOrientation();  break;
      // Mirror / flip (M/F for consistency; F avoids fullscreen conflict)
      case 'M': toggleMirror(); break;  // horizontal mirror (xzgv m)
      case 'F': toggleFlip();   break;  // vertical flip    (xzgv f)
      // Scale (xzgv d/D/s/S/n)
      case 'd': scaleDouble(); break;
      case 'D': scaleHalve();  break;
      case 's': scaleStep(+1); break;
      case 'S': scaleStep(-1); break;
      case 'n': scaleTo1();    break;
      // Quick zoom levels
      case '1': scaleTo1();                                    break;
      case '2': ui.zoomFit=false; ui.scale=2; applyImageTransform(); persistState(false); break;
      case '3': ui.zoomFit=false; ui.scale=3; applyImageTransform(); persistState(false); break;
      case '4': ui.zoomFit=false; ui.scale=4; applyImageTransform(); persistState(false); break;
      // Zoom-fit toggle (z) and reduce-only toggle (` — replaces xzgv Alt-r)
      case 'z': toggleZoom(); break;
      case '`':
        ui.zoomReduceOnly = !ui.zoomReduceOnly;
        if (ui.zoomFit) applyImageTransform();
        persistState(false);
        break;
      // Info (xzgv : / ;)
      case ':':
      case ';': e.preventDefault(); toggleInfoOverlay(); break;
    }
  } else if (ctrl) {
    // Fine scrolling — 10 px steps
    switch (key) {
      case 'ArrowUp':    e.preventDefault(); scrollImage(0, -10);  break;
      case 'ArrowDown':  e.preventDefault(); scrollImage(0, +10);  break;
      case 'ArrowLeft':  e.preventDefault(); scrollImage(-10,  0); break;
      case 'ArrowRight': e.preventDefault(); scrollImage(+10,  0); break;
    }
  }
}

// ── Selector navigation helpers ────────────────────────────────────────────

function moveSelectionBy(delta) {
  if (listing.length === 0) return;
  var start = selectedIdx < 0 ? (delta > 0 ? -1 : listing.length) : selectedIdx;
  var step  = delta > 0 ? 1 : -1;
  var count = Math.abs(delta);
  var cur   = start;
  for (var moved = 0; moved < count; ) {
    var next = cur + step;
    if (next < 0 || next >= listing.length) break;
    cur = next;
    if (isSelectable(listing[cur])) moved++;
  }
  if (cur !== start && cur >= 0 && cur < listing.length) {
    selectItem(cur, true);
  }
}

function jumpToEdge(dir) {
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

// ── Mouse: image-pane drag-to-scroll and divider drag-to-resize ───────────

imagePaneEl.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  dragMode = 'image';
  dragState.wasDrag = false;
  dragState.startX  = e.clientX;
  dragState.startY  = e.clientY;
  dragState.scrollX = imagePaneEl.scrollLeft;
  dragState.scrollY = imagePaneEl.scrollTop;
  e.preventDefault();
});

if (paneDividerEl) {
  paneDividerEl.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    dragMode = 'divider';
    dragState.startX = e.clientX;
    dragState.startW = selectorWidthPx;
    paneDividerEl.classList.add('dragging');
    e.preventDefault();
  });
}

document.addEventListener('mousemove', function(e) {
  if (dragMode === 'image') {
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.wasDrag = true;
    imagePaneEl.scrollLeft = dragState.scrollX - dx;
    imagePaneEl.scrollTop  = dragState.scrollY - dy;
  } else if (dragMode === 'divider') {
    setSelectorWidth(dragState.startW + (e.clientX - dragState.startX));
  }
});

document.addEventListener('mouseup', function() {
  if (dragMode === 'image' && !dragState.wasDrag) {
    setFocusMode('viewer');
  }
  if (dragMode === 'divider' && paneDividerEl) {
    paneDividerEl.classList.remove('dragging');
  }
  dragMode = null;
});

// Clicking on the selector switches to selector focus
selectorPaneEl.addEventListener('mousedown', function() {
  setFocusMode('selector');
});

// ── Button listeners ───────────────────────────────────────────────────────

if (btnRecursive) btnRecursive.addEventListener('click', toggleRecursive);
if (btnHidden)    btnHidden.addEventListener('click', toggleHidden);
if (btnSort)      btnSort.addEventListener('click', cycleSortBy);

// ── History (back/forward) ─────────────────────────────────────────────────

window.addEventListener('popstate', function(e) {
  _stopActiveMedia();
  applyHistoryState(e.state);
  var params = getUrlParams();

  if (params.dir !== currentDir) {
    currentFile = params.file;
    loadDir(params.dir, false);
  } else {
    currentFile = params.file;
    applyUiState();
    if (currentFile) {
      var idx = listing.findIndex(function(i) { return i.u === currentFile; });
      if (idx >= 0) selectItem(idx, true);
      showMediaFile(currentFile);
    }
  }
});

// ── Utility functions ──────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)               return bytes + '\u00a0B';
  if (bytes < 1024 * 1024)        return (bytes / 1024).toFixed(1) + '\u00a0KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + '\u00a0MB';
  return (bytes / 1073741824).toFixed(1) + '\u00a0GB';
}

function fmtDate(unixSecs, full) {
  var d = new Date(unixSecs * 1000);
  return full ? d.toLocaleString() : d.toLocaleDateString();
}

// ── Media playback ─────────────────────────────────────────────────────────

var videoEl         = document.getElementById('main-video');
var audioEl         = document.getElementById('main-audio');
var videoProgressEl = document.getElementById('video-progress');
var videoSeekFillEl = document.getElementById('video-seek-fill');
var videoTimeEl     = document.getElementById('video-time');
var videoVolEl      = document.getElementById('video-vol');

var activeMediaEl       = null;  // currently active <video> or <audio>, or null
var _posCheckpointTimer = null;  // setTimeout handle for position-save throttle

// ── BroadcastChannel: pause other viewer tabs when we start playing audio ──

var _mediaChannel = new BroadcastChannel('media-viewer');
_mediaChannel.onmessage = function(e) {
  if (e.data && e.data.cmd === 'pause' && activeMediaEl) {
    activeMediaEl.pause();
  }
};

// ── Stop / tear-down ────────────────────────────────────────────────────────

function _stopActiveMedia() {
  _clearPosCheckpoint();
  if (!activeMediaEl) return;
  activeMediaEl.pause();
  activeMediaEl.src = '';
  activeMediaEl     = null;
  imagePaneEl.classList.remove('media-video', 'media-audio', 'media-gif');
}

function _clearPosCheckpoint() {
  if (_posCheckpointTimer !== null) {
    clearTimeout(_posCheckpointTimer);
    _posCheckpointTimer = null;
  }
}

// ── Position persistence ────────────────────────────────────────────────────

function _posKey(fileUrl) {
  return 'media-pos:' + fileUrl.replace(/^file:\/\//, '');
}

function _savePosition(mediaEl) {
  if (!currentFile || !currentDir || mediaEl.paused || mediaEl.ended) return;
  var fileUrl = currentDir.replace(/\/$/, '') + '/' + currentFile;
  localStorage.setItem(_posKey(fileUrl), String(mediaEl.currentTime));
}

function _getSavedPosition(fileUrl) {
  var raw = localStorage.getItem(_posKey(fileUrl));
  return raw ? parseFloat(raw) : 0;
}

function _clearSavedPosition(fileUrl) {
  localStorage.removeItem(_posKey(fileUrl));
}

// ── Controls HUD ────────────────────────────────────────────────────────────

function fmtTime(secs) {
  var s = Math.floor(secs);
  var m = Math.floor(s / 60);
  var h = Math.floor(m / 60);
  m = m % 60;
  s = s % 60;
  var pad = function(n) { return n < 10 ? '0' + n : String(n); };
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function _updateVideoControls() {
  if (!activeMediaEl) return;
  var cur = activeMediaEl.currentTime || 0;
  var dur = activeMediaEl.duration;
  if (videoTimeEl) {
    videoTimeEl.textContent = fmtTime(cur) + ' / ' + (isFinite(dur) ? fmtTime(dur) : '?');
  }
  if (videoSeekFillEl && isFinite(dur) && dur > 0) {
    videoSeekFillEl.style.width = (cur / dur * 100).toFixed(2) + '%';
  }
  if (videoVolEl) {
    var vol = Math.round(activeMediaEl.volume * 100);
    videoVolEl.textContent = activeMediaEl.muted ? 'MUTED' : ('VOL\u00a0' + vol);
  }
}

// ── Media element event listeners ───────────────────────────────────────────

function _onMediaLoadedMetadata() {
  imgSpinnerEl.classList.add('hidden');
  var mediaEl = this;
  var fileUrl = currentDir.replace(/\/$/, '') + '/' + currentFile;

  // Restore saved position before playback starts
  var saved = _getSavedPosition(fileUrl);
  if (saved > 0 && isFinite(mediaEl.duration) && saved < mediaEl.duration) {
    mediaEl.currentTime = saved;
  }

  // Detect gif-loop: short video with no audio → play silently in a loop
  if (mediaEl === videoEl) {
    if (isFinite(videoEl.duration) && videoEl.duration < 60 && !videoEl.mozHasAudio) {
      videoEl.loop  = true;
      videoEl.muted = true;
      imagePaneEl.classList.replace('media-video', 'media-gif');
    }
  }

  // Notify other tabs to pause before we start playing anything with audio
  var hasAudio = mediaEl === audioEl ||
                 (mediaEl === videoEl && videoEl.mozHasAudio &&
                  !imagePaneEl.classList.contains('media-gif'));
  if (hasAudio) {
    _mediaChannel.postMessage({ cmd: 'pause' });
  }

  _updateVideoControls();
  mediaEl.play().catch(function() {});
}

function _onTimeUpdate() {
  _updateVideoControls();
  if (_posCheckpointTimer !== null) return;
  var el = this;
  _posCheckpointTimer = setTimeout(function() {
    _posCheckpointTimer = null;
    _savePosition(el);
  }, 5000);
}

function _onMediaEnded() {
  if (currentFile && currentDir) {
    _clearSavedPosition(currentDir.replace(/\/$/, '') + '/' + currentFile);
  }
  _updateVideoControls();
}

function _onMediaError() {
  imgSpinnerEl.classList.add('hidden');
}

videoEl.addEventListener('loadedmetadata', _onMediaLoadedMetadata);
audioEl.addEventListener('loadedmetadata', _onMediaLoadedMetadata);
videoEl.addEventListener('timeupdate',     _onTimeUpdate);
audioEl.addEventListener('timeupdate',     _onTimeUpdate);
videoEl.addEventListener('ended',          _onMediaEnded);
audioEl.addEventListener('ended',          _onMediaEnded);
videoEl.addEventListener('error',          _onMediaError);
audioEl.addEventListener('error',          _onMediaError);

// Progress bar click-to-seek
if (videoProgressEl) {
  videoProgressEl.addEventListener('click', function(e) {
    if (!activeMediaEl || !isFinite(activeMediaEl.duration)) return;
    var rect = videoProgressEl.getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    activeMediaEl.currentTime = frac * activeMediaEl.duration;
    _updateVideoControls();
  });
}

// ── Show media file (dispatcher) ────────────────────────────────────────────

function showMediaFile(filename) {
  if (!filename || !currentDir) return;
  var type = mediaType(filename);
  _stopActiveMedia();
  mainImageEl.src = '';
  imagePaneEl.classList.remove('image-loaded');
  if (type === 'image') {
    showImage(filename);
  } else if (type === 'video' || type === 'audio') {
    showMedia(filename, type);
  }
  // 'unknown': leave pane empty — no-content hint will be visible
}

function showMedia(filename, type) {
  var fileUrl  = currentDir.replace(/\/$/, '') + '/' + filename;
  var proxyUrl = toProxyFile(fileUrl);

  activeMediaEl      = (type === 'video') ? videoEl : audioEl;
  activeMediaEl.loop  = false;
  activeMediaEl.muted = false;

  imgSpinnerEl.classList.remove('hidden');
  imagePaneEl.classList.add(type === 'video' ? 'media-video' : 'media-audio');

  activeMediaEl.src = proxyUrl;
  // loadedmetadata fires next → _onMediaLoadedMetadata()

  if (!infoOverlayEl.classList.contains('hidden')) {
    updateInfoOverlay(filename);
  }
  document.title = filename + ' — Media Viewer';
}

// ── Initialisation ─────────────────────────────────────────────────────────

function init() {
  applyHistoryState(history.state);

  var params = getUrlParams();
  if (!params.dir) {
    showScreen('pick');
    return;
  }

  currentDir  = params.dir;
  currentFile = params.file || null;
  loadDir(params.dir, false);
}

init();
