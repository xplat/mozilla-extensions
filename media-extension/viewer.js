// viewer.js — Media Viewer UI  (no chrome.* / browser.* calls)
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
// LOOPBACK, FILE_PROXY_PREFIX, DIR_PROXY_PREFIX, THUMB_PROXY_PREFIX,
// QUEUE_DIR_PROXY_PREFIX, LS_*, toProxyFile(), applyAvSettings(),
// initMediaElVolume() — all defined in media-shared.js (loaded first).

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

// Known standard video dimensions (width × height as "WxH" strings) that
// should trigger auto-fullscreen when played from the beginning.
// Covers HD/4K/8K broadcast, DVD (NTSC + PAL, fullscreen + widescreen output),
// and the VGA/SVGA/XGA fullscreen formats common on old computers.
const FULLSCREEN_DIMS = new Set([
  // HD / broadcast
  '1920x1080', '1280x720',
  // 480p — widescreen (anamorphic output) and 4:3
  '854x480', '852x480', '640x480',
  // 4K UHD / DCI 4K / 8K
  '3840x2160', '4096x2160', '7680x4320',
  // 1440p (QHD) and 2K DCI
  '2560x1440', '2048x1080',
  // DVD fullscreen: NTSC 720×480, PAL 720×576
  '720x480', '720x576',
  // DVD widescreen PAL output
  '1024x576',
  // Old computer fullscreen: VGA, SVGA, XGA
  '800x600', '1024x768',
]);

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
  // Queue mode — NOT persisted (resets on page load)
  queueMode:       null,   // null | 'audio' | 'video'
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

// In-flight preload image — used to avoid blanking/squishing on image navigation
var _imgPendingLoad = null;

// Display size and full transform state from the most recent applyImageTransform()
// call.  Used to recover the exact image pixel at the viewport centre before a
// transform change so it can be repositioned afterwards.  Reset on new image.
var _prevDisplayW = 0;
var _prevDisplayH = 0;
var _prevRot    = 0;
var _prevScale  = 1;
var _prevMirror = false;
var _prevFlip   = false;

// ── Queue state (mirrored from background via BroadcastChannel) ───────────
//
// Only volatile bits (index, time, playing, suppressed) come over the wire.
// Items live in localStorage and are read via _qAudioItems()/_qVideoItems()
// so large arrays are never pushed through the channel.

var _qState = {
  audio: { index: 0, time: 0, playing: false, suppressed: false },
  video: { index: 0 }
};

function _qAudioItems() {
  try { return JSON.parse(localStorage.getItem('media-audio-queue') || '{}').items || []; }
  catch (e) { return []; }
}
function _qVideoItems() {
  try { return JSON.parse(localStorage.getItem('media-video-queue') || '{}').items || []; }
  catch (e) { return []; }
}

// Saved dir/file to restore when exiting video queue mode.
var _preQueueDir  = null;
var _preQueueFile = null;

var _queueChannel = new BroadcastChannel('media-queue');
_queueChannel.onmessage = function(e) {
  if (!e.data || e.data.cmd !== 'q-changed') return;
  var prev = _qState;
  _qState  = { audio: e.data.audio, video: e.data.video };
  _onQueueStateUpdate(prev);
};

// Deferred image↔media transition state:
//   _deferredMediaType ('video'|'audio'|'gif'|null): set when starting an
//     image→media load without adding the CSS class yet (the old image stays
//     visible until loadedmetadata fires, then we do the swap).
//   _pendingMediaStop (bool): set when starting a media→image preload without
//     stopping the current media yet (the old media keeps playing until the
//     image's load event fires, then we do the swap).
var _deferredMediaType = null;
var _pendingMediaStop  = false;

// ── DOM refs ───────────────────────────────────────────────────────────────

var pickScreenEl    = document.getElementById('pick-screen');
var loadingScreenEl = document.getElementById('loading-screen');
var errorScreenEl   = document.getElementById('error-screen');
var viewerScreenEl  = document.getElementById('viewer-screen');

var dirPathEl       = document.getElementById('dir-path');
var fileListEl      = document.getElementById('file-list');
var selectorPaneEl  = document.getElementById('selector-pane');
var imagePaneEl       = document.getElementById('image-pane');
var transformHostEl   = document.getElementById('transform-host');
var mainImageEl       = document.getElementById('main-image');
var imgSpinnerEl      = document.getElementById('img-spinner');
var transitionCoverEl = document.getElementById('transition-cover');
var infoOverlayEl   = document.getElementById('info-overlay');
var infoContentEl   = document.getElementById('info-content');
var noImageHintEl   = document.getElementById('no-image-hint');

var paneDividerEl  = document.getElementById('pane-divider');

var btnRecursive = document.getElementById('btn-recursive');
var btnHidden    = document.getElementById('btn-hidden');
var btnSort      = document.getElementById('btn-sort');

var queuePaneEl      = document.getElementById('queue-pane');
var queuePaneTitleEl = document.getElementById('queue-pane-title');
var queueListEl      = document.getElementById('queue-list');
var queueClearBtn    = document.getElementById('queue-clear-btn');

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
// toProxyFile() is defined in media-shared.js.

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
  if (scroll) el.scrollIntoView({ block: 'center' });
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
//
// We preload the new image in a scratch element before swapping mainImageEl.src
// so the old image stays visible during loading (no blank flash).  Clearing the
// old inline width/height/transform on mainImageEl before the swap prevents the
// new image from briefly inheriting the previous image's dimensions (squishing).

function showImage(filename) {
  if (!filename || !currentDir) return;
  var fileUrl  = currentDir.replace(/\/$/, '') + '/' + filename;
  var proxyUrl = toProxyFile(fileUrl);

  // Cancel any previous in-flight preload.
  if (_imgPendingLoad) {
    _imgPendingLoad.onload = _imgPendingLoad.onerror = null;
    _imgPendingLoad.src    = '';
    _imgPendingLoad        = null;
  }

  imgSpinnerEl.classList.remove('hidden');

  if (!infoOverlayEl.classList.contains('hidden')) {
    updateInfoOverlay(filename);
  }
  document.title = filename + ' — Media Viewer';

  // Load new image off-screen; swap only when decoded (no blank during load).
  var pending = new Image();
  _imgPendingLoad = pending;
  pending.onload = function() {
    if (_imgPendingLoad !== pending) return;  // superseded
    _imgPendingLoad = null;
    // Hide while swapping: prevents both the old-image-position flash (stale
    // absolute margins land off-screen while transformHostEl is unsized) and
    // squishing.  The load handler reveals the image after applyImageTransform()
    // has set correct geometry.  One-frame blank is imperceptible.
    mainImageEl.style.visibility = 'hidden';
    mainImageEl.src = proxyUrl;
  };
  pending.onerror = function() {
    if (_imgPendingLoad !== pending) return;
    _imgPendingLoad = null;
    imgSpinnerEl.classList.add('hidden');
  };
  pending.src = proxyUrl;
}

mainImageEl.addEventListener('load', function() {
  imgSpinnerEl.classList.add('hidden');
  imagePaneEl.classList.add('image-loaded');
  _prevDisplayW = 0;  // new image — don't inherit previous scroll centre
  _prevDisplayH = 0;
  applyImageTransform();
  mainImageEl.style.visibility = '';
  if (_pendingMediaStop) {
    // media→image deferred swap: image is ready, now atomically stop media.
    // transform-host was hidden (media class present); _stopActiveMedia()
    // removes the class, making the already-transformed image visible.
    _pendingMediaStop = false;
    _startTransitionCover();
    _stopActiveMedia();
    // Cover fades out revealing the image.
  }
  _endTransitionCover();
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

// Forward: image-centre offset → visual-centre offset under the given transform.
// CSS transform order is "rotate scaleX scaleY scale", which means transforms
// apply right-to-left to a point: scale → flip (scaleY−1) → mirror (scaleX−1)
// → rotate.
function _imageOffsetToVisual(ox, oy, rot, mirror, flip, scale) {
  ox *= scale;  oy *= scale;
  if (flip)   oy = -oy;
  if (mirror) ox = -ox;
  var rx, ry;
  switch (rot) {
    case  90: rx = -oy; ry =  ox; break;
    case 180: rx = -ox; ry = -oy; break;
    case 270: rx =  oy; ry = -ox; break;
    default:  rx =  ox; ry =  oy;
  }
  return { x: rx, y: ry };
}

// Inverse: visual-centre offset → image-centre offset (exact inverse of above).
function _visualOffsetToImage(ox, oy, rot, mirror, flip, scale) {
  var rx, ry;
  switch (rot) {
    case  90: rx =  oy; ry = -ox; break;
    case 180: rx = -ox; ry = -oy; break;
    case 270: rx = -oy; ry =  ox; break;
    default:  rx =  ox; ry =  oy;
  }
  if (mirror) rx = -rx;
  if (flip)   ry = -ry;
  rx /= scale;  ry /= scale;
  return { x: rx, y: ry };
}

function applyImageTransform() {
  var img  = mainImageEl;
  var host = transformHostEl;
  var pane = imagePaneEl;

  var nw = img.naturalWidth;
  var nh = img.naturalHeight;
  if (!nw || !nh) return;

  // Capture the exact image pixel at the viewport centre before any changes.
  // Defaults to (0, 0) = image centre for new images (_prevDisplayW == 0).
  var _snapIPX = 0, _snapIPY = 0;
  if (!ui.zoomFit && _prevDisplayW > 0) {
    var _snapPW = pane.clientWidth;
    var _snapPH = pane.clientHeight;
    var _snapOX = Math.max(0, (_snapPW - _prevDisplayW) / 2);
    var _snapOY = Math.max(0, (_snapPH - _prevDisplayH) / 2);
    // Viewport centre → transform-host-centre offset
    var _vcOX = pane.scrollLeft + _snapPW / 2 - _snapOX - _prevDisplayW / 2;
    var _vcOY = pane.scrollTop  + _snapPH / 2 - _snapOY - _prevDisplayH / 2;
    var _snap = _visualOffsetToImage(_vcOX, _vcOY,
                                     _prevRot, _prevMirror, _prevFlip, _prevScale);
    _snapIPX = _snap.x;
    _snapIPY = _snap.y;
  }

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
    pane.style.overflow       = 'auto';
    pane.style.display        = '';           // use base-rule flex
    pane.style.alignItems     = 'flex-start'; // margin:auto on host overrides
    pane.style.justifyContent = 'flex-start'; //   when image fits; 0 when not
    pane.classList.add('mode-scroll');
  }

  // Centre-preservation in scroll mode.  After any transform change (scale,
  // rotation, mirror, flip) we restore the scroll so the image pixel that was
  // at the viewport centre before the change is still at the centre after it.
  //
  // We recover the image pixel via the exact inverse transform, then re-apply
  // the new forward transform to find where it lands.  Exact for all cases.
  // When _prevDisplayW == 0 (new image) _snapIPX/Y default to (0,0) = image
  // centre, which centres the image in the viewport.
  if (!ui.zoomFit) {
    var pW = pane.clientWidth;
    var pH = pane.clientHeight;
    var newOffX = Math.max(0, (pW - displayW) / 2);
    var newOffY = Math.max(0, (pH - displayH) / 2);
    var newVis  = _imageOffsetToVisual(_snapIPX, _snapIPY,
                                       rot, ui.mirror, ui.flip, scale);
    pane.scrollLeft = Math.max(0, displayW / 2 + newVis.x + newOffX - pW / 2);
    pane.scrollTop  = Math.max(0, displayH / 2 + newVis.y + newOffY - pH / 2);
  }

  _prevDisplayW = displayW;
  _prevDisplayH = displayH;
  _prevRot    = rot;
  _prevScale  = scale;
  _prevMirror = ui.mirror;
  _prevFlip   = ui.flip;
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
  viewerScreenEl.classList.toggle('queue-mode',  !!ui.queueMode);
  if (ui.queueMode && queuePaneTitleEl) {
    queuePaneTitleEl.textContent = (ui.queueMode === 'video') ? 'VIDEO QUEUE' : 'AUDIO QUEUE';
  }
  if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
}

function toggleSelector() {
  ui.selectorVisible = !ui.selectorVisible;
  applySelector();
  persistState(false);
}

// ── Queue mode ─────────────────────────────────────────────────────────────

// Cycle: null → 'audio' → 'video' → null
function cycleQueueMode() {
  var modes = [null, 'audio', 'video'];
  _setQueueMode(modes[(modes.indexOf(ui.queueMode) + 1) % modes.length]);
}

function _setQueueMode(mode) {
  var old = ui.queueMode;
  ui.queueMode = mode;

  if (mode === 'video' && old !== 'video') {
    // Entering video queue mode: save current position, load first queue item.
    _preQueueDir  = currentDir;
    _preQueueFile = currentFile;
    var item = _qVideoItems()[_qState.video.index];
    if (item) {
      currentDir  = item.dir;
      currentFile = item.file;
      showMediaFile(item.file);
    }
    applySelector();
    renderQueuePane();
    _queueChannel.postMessage({ cmd: 'q-sync' });
    return;
  }

  if (old === 'video' && mode !== 'video') {
    // Leaving video queue mode: stop queue video, restore saved position.
    _stopActiveMedia();
    var savedDir  = _preQueueDir;
    var savedFile = _preQueueFile;
    _preQueueDir  = null;
    _preQueueFile = null;
    if (savedDir) {
      currentDir  = savedDir;
      currentFile = savedFile;
      loadDir(savedDir, false);  // reloads listing and shows savedFile
      return;  // loadDir calls applySelector / applyUiState
    }
  }

  applySelector();
  renderQueuePane();
  if (mode && !old) {
    _queueChannel.postMessage({ cmd: 'q-sync' });
  }
}

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
    el.className = 'file-item queue-item' +
                   (idx === q.index ? ' playing' : '');
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
      _queueChannel.postMessage({
        cmd: 'q-jump', type: isAudio ? 'audio' : 'video', index: idx
      });
    });

    queueListEl.appendChild(el);
  });

  // Scroll current item into view.
  var cur = queueListEl.querySelector('.playing');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

// Called when background broadcasts new queue state.
function _onQueueStateUpdate(prev) {
  if (ui.queueMode === 'video') {
    var newIdx = _qState.video.index;
    if (newIdx !== prev.video.index) {
      var item = _qVideoItems()[newIdx];
      if (item) {
        currentDir  = item.dir;
        currentFile = item.file;
        showMediaFile(item.file);
      }
    }
  }
  renderQueuePane();
}

// Queue the currently highlighted selector item (or a directory's contents).
// On a file: add to queue and advance to next item.
// On a directory: collect all audio/video files (and CD/Disc subdirs) and
//   add them in sorted order; don't advance the cursor.
function _handleQueueKey() {
  if (selectedIdx < 0 || !listing[selectedIdx]) return;
  var item = listing[selectedIdx];
  if (item.t === 'd') {
    var dirUrl = currentDir.replace(/\/$/, '') + '/' + item.u;
    _collectAndQueueDir(dirUrl).catch(function() {});
  } else {
    var mt = mediaType(item.u);
    if (mt !== 'audio' && mt !== 'video') return;
    _queueChannel.postMessage({
      cmd: 'q-add', type: mt,
      items: [{ dir: currentDir, file: item.u }]
    });
    nextImage();
  }
}

async function _collectAndQueueDir(dirUrl) {
  var audioItems = [], videoItems = [];
  await _collectQueueables(dirUrl, audioItems, videoItems);
  if (audioItems.length) {
    _queueChannel.postMessage({ cmd: 'q-add', type: 'audio', items: audioItems });
  }
  if (videoItems.length) {
    _queueChannel.postMessage({ cmd: 'q-add', type: 'video', items: videoItems });
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

// Wire up clear button.
if (queueClearBtn) {
  queueClearBtn.addEventListener('click', function() {
    if (!ui.queueMode) return;
    _queueChannel.postMessage({
      cmd: 'q-clear',
      type: ui.queueMode === 'video' ? 'video' : 'audio'
    });
  });
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
        e.preventDefault();
        // In video/audio viewer focus: step forward one frame; elsewhere: toggle hidden files
        if (focusMode === 'viewer' && activeMediaEl) {
          activeMediaEl.currentTime =
            Math.min(activeMediaEl.duration, activeMediaEl.currentTime + 1 / 30);
          _updateVideoControls();
        } else {
          toggleHidden();
        }
        return;
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
      // Global A/V keys — always active; adjust shared settings and broadcast.
      case 'm': e.preventDefault(); toggleMute();        return;
      case 'p':
        e.preventDefault();
        if (activeMediaEl) {
          togglePlayPause();
        } else {
          // No local media — ask whichever other tab is playing audio to toggle.
          _mediaChannel.postMessage({ cmd: 'pause-toggle' });
        }
        return;
      case '9': e.preventDefault(); adjustVolume(-1.5);  return;
      case '0': e.preventDefault(); adjustVolume(+1.5);  return;
      case '(': e.preventDefault(); adjustBalance(-0.1); return;
      case ')': e.preventDefault(); adjustBalance(+0.1); return;
      case 'A': e.preventDefault(); toggleAutoplay(); return;
      // Queue
      case 'q': e.preventDefault(); _handleQueueKey();    return;
      case 'Q': e.preventDefault(); cycleQueueMode();     return;
      case '\\':
        e.preventDefault();
        _queueChannel.postMessage({ cmd: 'q-toggle' });
        return;
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
    case 'b': prevImage(); break;
    case 's': cycleSortBy(); break;
    case 'z': toggleZoom(); break;
  }
}

function handleViewerKey(e, key, ctrl, plain) {
  // Media-mode overrides: applied when a controllable video or audio file is
  // active (gif-loop videos are excluded — they behave like static images).
  if (plain && activeMediaEl && !imagePaneEl.classList.contains('media-gif')) {
    switch (key) {
      // Seek (mplayer defaults: ←/→ ±10 s, ↑/↓ ±1 min, PgUp/PgDn ±10 min)
      case 'ArrowLeft':  e.preventDefault(); seekRelative(-10);  return;
      case 'ArrowRight': e.preventDefault(); seekRelative(+10);  return;
      case 'ArrowUp':    e.preventDefault(); seekRelative(+60);  return;
      case 'ArrowDown':  e.preventDefault(); seekRelative(-60);  return;
      case 'PageUp':     e.preventDefault(); seekRelative(+600); return;
      case 'PageDown':   e.preventDefault(); seekRelative(-600); return;
      case 'Home':       e.preventDefault();
        activeMediaEl.currentTime = 0; _updateVideoControls(); return;
      case 'Backspace':  e.preventDefault();
        activeMediaEl.playbackRate = 1; return;
      // Navigation
      case 'Enter': e.preventDefault(); nextImage(); return;
      case 'b':     e.preventDefault(); prevImage(); return;
      // Play / pause
      case ' ':
        e.preventDefault();
        activeMediaEl.ended ? nextImage() : togglePlayPause();
        return;
      // Playback rate  (</>: ±0.1 step, matching mplayer's [/] moved to angle brackets)
      //                ({/}: halve/double, as in mplayer)
      case '<': e.preventDefault();
        activeMediaEl.playbackRate = Math.max(0.25, +(activeMediaEl.playbackRate - 0.1).toFixed(2));
        return;
      case '>': e.preventDefault();
        activeMediaEl.playbackRate = Math.min(4.0,  +(activeMediaEl.playbackRate + 0.1).toFixed(2));
        return;
      case '{': e.preventDefault();
        activeMediaEl.playbackRate = Math.max(0.25, activeMediaEl.playbackRate / 2);
        return;
      case '}': e.preventDefault();
        activeMediaEl.playbackRate = Math.min(4.0,  activeMediaEl.playbackRate * 2);
        return;
      // Audio / video track cycling
      case 'a':
      case '#': e.preventDefault(); cycleAudioTrack(); return;
      case '_': e.preventDefault(); cycleVideoTrack(); return;
      // OSD / info
      case 'o': e.preventDefault(); toggleInfoOverlay(); return;
      // Color/quality (video only; overrides image quick-zoom keys 1-4)
      // mplayer layout: 1/2 contrast, 3/4 brightness, 5/6 hue, 7/8 saturation
      case '1': case '2': case '3': case '4':
      case '5': case '6': case '7': case '8':
        if (imagePaneEl.classList.contains('media-video')) {
          e.preventDefault();
          if      (key === '1') adjustVideoFilter('contrast',   -0.1);
          else if (key === '2') adjustVideoFilter('contrast',   +0.1);
          else if (key === '3') adjustVideoFilter('brightness', -0.1);
          else if (key === '4') adjustVideoFilter('brightness', +0.1);
          else if (key === '5') adjustVideoFilter('hue',        -10);
          else if (key === '6') adjustVideoFilter('hue',        +10);
          else if (key === '7') adjustVideoFilter('saturation', -0.1);
          else if (key === '8') adjustVideoFilter('saturation', +0.1);
          return;
        }
        break;
    }
  }

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
      case 'Enter':
      case ' ':  e.preventDefault(); nextImage(); break;
      case 'b':  prevImage(); break;
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
  // Clicks inside the controls overlay (progress bar, HUD) are handled there;
  // don't treat them as image-pane drag or play/pause clicks.
  if (videoProgressEl && videoProgressEl.contains(e.target)) return;
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
    if (activeMediaEl) {
      if (activeMediaEl.ended) {
        activeMediaEl.currentTime = 0;
        activeMediaEl.play().catch(function() {});
      } else if (activeMediaEl.paused) {
        activeMediaEl.play().catch(function() {});
      } else {
        activeMediaEl.pause();
      }
      _updateVideoControls();
    }
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
var mediaErrorEl    = document.getElementById('media-error');
var mediaErrorMsgEl = document.getElementById('media-error-msg');

var activeMediaEl       = null;  // currently active <video> or <audio>, or null
var _posCheckpointTimer = null;  // setTimeout handle for position-save throttle
var _autoplay           = true;  // if false, media loads but does not start playing
var _shouldAnnounce     = false; // true when audio-bearing media loaded; cleared after first 'playing' event
var _hasAnnounced       = false; // true after we've broadcast 'pause' to other tabs; cleared on stop/end

// Video color/quality filter state (reset on each new file; applied via CSS filter on videoEl)
var _vContrast   = 1.0;  // CSS contrast()   — mplayer keys 1/2
var _vBrightness = 1.0;  // CSS brightness() — mplayer keys 3/4
var _vHue        = 0;    // CSS hue-rotate() degrees — mplayer keys 5/6
var _vSaturation = 1.0;  // CSS saturate()   — mplayer keys 7/8

// Stereo balance (Web Audio API): _panValue, _audioCtx, _panNode defined in
// media-shared.js; source wiring tracked per element here.
var _videoGraphed  = false;  // whether videoEl has been wired into _audioCtx
var _audioGraphed  = false;  // whether audioEl has been wired into _audioCtx

// ── BroadcastChannel: pause other viewer tabs when we start playing audio ──

var _mediaChannel = new BroadcastChannel('media-viewer');
_mediaChannel.onmessage = function(e) {
  if (!e.data) return;
  if (e.data.cmd === 'pause' && activeMediaEl) {
    activeMediaEl.pause();
  } else if (e.data.cmd === 'pause-toggle' && activeMediaEl) {
    togglePlayPause();
  } else if (e.data.cmd === 'av-settings') {
    // Persist and immediately apply volume/mute/balance from another tab.
    var d = e.data;
    if (d.volume  !== undefined) localStorage.setItem('media-volume',  String(d.volume));
    if (d.muted   !== undefined) localStorage.setItem('media-muted',   String(d.muted));
    if (d.balance !== undefined) localStorage.setItem('media-balance', String(d.balance));
    if (activeMediaEl) {
      applyAvSettings(activeMediaEl, d);
      _updateVideoControls();
    }
  }
};

// ── Transition cover ────────────────────────────────────────────────────────
//
// Used for image↔media mode switches.  Snaps opaque (transition:none) to hide
// any intermediate layout state, then fades out (0.15s) when new content is
// ready.  Calling _endTransitionCover() when no cover was started is harmless.

function _startTransitionCover() {
  transitionCoverEl.classList.add('covering');
}

function _endTransitionCover() {
  // One rAF defers the fade until after the browser has painted the newly
  // ready content at least once, so the fade reveals a stable frame.
  requestAnimationFrame(function() {
    transitionCoverEl.classList.remove('covering');
  });
}

// ── Stop / tear-down ────────────────────────────────────────────────────────

function _stopActiveMedia() {
  _clearPosCheckpoint();
  _shouldAnnounce = false;
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _mediaChannel.postMessage({ cmd: 'media-stopped' });
  }
  if (mediaErrorEl) mediaErrorEl.classList.add('hidden');
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
  if (imagePaneEl.classList.contains('media-gif')) return;
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
    var rawVol = activeMediaEl.volume;
    var volStr = (rawVol <= 0)
      ? '-\u221edB'
      : (Math.round(20 * Math.log10(rawVol)) + 'dB');
    var text = activeMediaEl.muted ? 'MUTED' : ('VOL\u00a0' + volStr);
    if (_panValue !== 0) {
      var side = _panValue > 0 ? 'R' : 'L';
      text += '\u2002' + side + Math.abs(_panValue).toFixed(1);
    }
    if (!_autoplay) text += '\u2002MANUAL';
    videoVolEl.textContent = text;
  }
}

// ── Media element event listeners ───────────────────────────────────────────

function _onMediaLoadedMetadata() {
  imgSpinnerEl.classList.add('hidden');
  var mediaEl = this;
  var fileUrl = currentDir.replace(/\/$/, '') + '/' + currentFile;

  // Detect gif-loop first: short video with no audio → play silently in a loop.
  // Must run before the position-restore below so we can skip restoring for gifs.
  var isGif = false;
  if (mediaEl === videoEl) {
    if (isFinite(videoEl.duration) && videoEl.duration < 60 && !videoEl.mozHasAudio) {
      isGif = true;
      videoEl.loop  = true;
      videoEl.muted = true;
      if (_deferredMediaType) {
        _deferredMediaType = 'gif';  // class added below at swap time
      } else {
        imagePaneEl.classList.replace('media-video', 'media-gif');
      }
    }
  }

  // Restore saved position before playback starts (gif-loops are excluded:
  // they have no meaningful temporal position to resume).
  var saved = 0;
  if (!isGif) {
    saved = _getSavedPosition(fileUrl);
    if (saved > 0 && isFinite(mediaEl.duration) && saved < mediaEl.duration) {
      mediaEl.currentTime = saved;
    }
  }

  // image→media deferred swap: media is ready, now atomically replace the image.
  if (_deferredMediaType) {
    var dType = _deferredMediaType;
    _deferredMediaType = null;
    _startTransitionCover();
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    imagePaneEl.classList.add(dType === 'gif'   ? 'media-gif'   :
                              dType === 'video' ? 'media-video' : 'media-audio');
    // Cover fades out below, after _updateVideoControls().
  }

  // Notify other tabs to pause before we start playing anything with audio
  // Schedule cross-tab pause for the moment playback actually starts,
  // not here — otherwise loading without autoplay still pauses other tabs.
  var hasAudio = mediaEl === audioEl ||
                 (mediaEl === videoEl && videoEl.mozHasAudio &&
                  !imagePaneEl.classList.contains('media-gif'));
  _shouldAnnounce = hasAudio;

  // Auto-fullscreen: widescreen video (≥ 3:2 aspect) played from the beginning.
  // Skipped when restoring a saved position (the user already watched part of it)
  // or when already fullscreen or when gif-loop mode.
  if (mediaEl === videoEl &&
      !imagePaneEl.classList.contains('media-gif') &&
      !document.fullscreenElement &&
      !(saved > 0) &&
      FULLSCREEN_DIMS.has(videoEl.videoWidth + 'x' + videoEl.videoHeight)) {
    selectorStateBeforeFS = ui.selectorVisible;
    ui.selectorVisible = false;
    applySelector();
    document.documentElement.requestFullscreen().catch(function() {
      // Fullscreen denied (gesture expired or policy); restore selector state.
      ui.selectorVisible = selectorStateBeforeFS;
      applySelector();
    });
  }

  _updateVideoControls();
  _endTransitionCover();
  // Gif-loops always play (they're treated as looping images, not video).
  // For real video/audio, respect the autoplay toggle.
  if (_autoplay || imagePaneEl.classList.contains('media-gif')) {
    mediaEl.play().catch(function() {});
  }
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
  if (_hasAnnounced) {
    _hasAnnounced = false;
    _mediaChannel.postMessage({ cmd: 'media-stopped' });
  }
  // In video queue mode, auto-advance to the next queue item.
  if (ui.queueMode === 'video') {
    var next = _qState.video.index + 1;
    if (next < _qVideoItems().length) {
      _queueChannel.postMessage({ cmd: 'q-jump', type: 'video', index: next });
      // _onQueueStateUpdate fires when the broadcast comes back and loads it.
    }
    return;
  }
  if (currentFile && currentDir) {
    _clearSavedPosition(currentDir.replace(/\/$/, '') + '/' + currentFile);
  }
  _updateVideoControls();
}

function _onMediaPlaying() {
  if (_shouldAnnounce) {
    _shouldAnnounce = false;
    _hasAnnounced   = true;
    _mediaChannel.postMessage({ cmd: 'pause' });
  }
}

function _onMediaError() {
  imgSpinnerEl.classList.add('hidden');
  // Guard: if src was cleared during navigation activeMediaEl is already null.
  if (!activeMediaEl || !currentFile) return;
  var ext = currentFile.slice(currentFile.lastIndexOf('.') + 1).toLowerCase();
  var code = activeMediaEl.error ? activeMediaEl.error.code : 0;
  var msg;
  if (ext === 'mkv' && code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    msg = 'MKV playback is not supported in this version of Firefox.\n' +
          'Try enabling media.mkv.enabled in about:config, or upgrade to a newer Firefox.';
  } else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
             code === MediaError.MEDIA_ERR_DECODE) {
    msg = 'This file format is not supported by your browser (' + ext.toUpperCase() + ').';
  } else {
    msg = 'Error loading media.';
  }
  if (mediaErrorMsgEl) mediaErrorMsgEl.textContent = msg;
  if (mediaErrorEl)    mediaErrorEl.classList.remove('hidden');
}

videoEl.addEventListener('loadedmetadata', _onMediaLoadedMetadata);
audioEl.addEventListener('loadedmetadata', _onMediaLoadedMetadata);
videoEl.addEventListener('playing',        _onMediaPlaying);
audioEl.addEventListener('playing',        _onMediaPlaying);
videoEl.addEventListener('timeupdate',     _onTimeUpdate);
audioEl.addEventListener('timeupdate',     _onTimeUpdate);
videoEl.addEventListener('ended',          _onMediaEnded);
audioEl.addEventListener('ended',          _onMediaEnded);
videoEl.addEventListener('error',          _onMediaError);
audioEl.addEventListener('error',          _onMediaError);

// ── Media control helpers ────────────────────────────────────────────────────

function togglePlayPause() {
  if (!activeMediaEl) return;
  if (activeMediaEl.ended) {
    activeMediaEl.currentTime = 0;
    activeMediaEl.play().catch(function() {});
  } else if (activeMediaEl.paused) {
    activeMediaEl.play().catch(function() {});
  } else {
    activeMediaEl.pause();
  }
  _updateVideoControls();
}

function toggleMute() {
  var muted;
  if (activeMediaEl) {
    activeMediaEl.muted = !activeMediaEl.muted;
    muted = activeMediaEl.muted;
  } else {
    muted = !(localStorage.getItem('media-muted') === 'true');
  }
  localStorage.setItem('media-muted', String(muted));
  _mediaChannel.postMessage({ cmd: 'av-settings', muted: muted });
  _updateVideoControls();
}

function toggleAutoplay() {
  _autoplay = !_autoplay;
  _updateVideoControls();
}

// Adjust volume by dBDelta decibels.  Using dB steps gives perceptually uniform
// increments (~1.5 dB ≈ a just-noticeable loudness change; ~20 steps full→silence).
function adjustVolume(dBDelta) {
  var current = activeMediaEl
    ? activeMediaEl.volume
    : parseFloat(localStorage.getItem('media-volume') || '1');
  var vol;
  if (current <= 0) {
    // At zero, stepping up goes to a minimal audible level (~-40 dB).
    vol = (dBDelta > 0) ? Math.pow(10, -40 / 20) : 0;
  } else {
    var newdB = 20 * Math.log10(current) + dBDelta;
    vol = (newdB <= -40) ? 0 : Math.min(1, Math.pow(10, newdB / 20));
  }
  vol = +vol.toFixed(4);
  if (activeMediaEl) {
    activeMediaEl.volume = vol;
    activeMediaEl.muted  = false;
  }
  localStorage.setItem('media-volume', String(vol));
  localStorage.setItem('media-muted',  'false');
  _mediaChannel.postMessage({ cmd: 'av-settings', volume: vol, muted: false });
  _updateVideoControls();
}

// secs may be negative (seek back) or positive (seek forward)
function seekRelative(secs) {
  if (!activeMediaEl || !isFinite(activeMediaEl.duration)) return;
  activeMediaEl.currentTime =
    Math.max(0, Math.min(activeMediaEl.duration, activeMediaEl.currentTime + secs));
  _updateVideoControls();
}

// ── Stereo balance (Web Audio API) ──────────────────────────────────────────
//
// _ensureAudioContext() (media-shared.js) owns the AudioContext + PannerNode.
// createMediaElementSource() permanently reroutes a media element's audio
// through the AudioContext; calling it a second time on the same element
// throws, so we track which elements have been connected here.

function _ensureAudioGraph(mediaEl) {
  _ensureAudioContext();
  var already = (mediaEl === videoEl) ? _videoGraphed : _audioGraphed;
  if (!already) {
    // Mark as graphed first so a CORS-taint failure doesn't cause infinite retries.
    if (mediaEl === videoEl) _videoGraphed = true;
    else                     _audioGraphed = true;
    try {
      _audioCtx.createMediaElementSource(mediaEl).connect(_panNode);
    } catch (err) {
      console.warn('createMediaElementSource failed (CORS?):', err);
    }
  }
}

function adjustBalance(delta) {
  _panValue = +Math.max(-1, Math.min(1, _panValue + delta)).toFixed(1);
  localStorage.setItem('media-balance', String(_panValue));
  _mediaChannel.postMessage({ cmd: 'av-settings', balance: _panValue });
  if (activeMediaEl) {
    _ensureAudioGraph(activeMediaEl);
    _panNode.pan.value = _panValue;
  }
  _updateVideoControls();
}

// ── Video color/quality filter ───────────────────────────────────────────────
//
// Applies CSS filter to the video element.  mplayer key layout:
//   1/2 contrast, 3/4 brightness, 5/6 hue-rotate, 7/8 saturate
// Filter is reset to defaults when a new file is opened (showMedia).

function _applyVideoFilter() {
  var parts = [];
  if (_vContrast   !== 1.0) parts.push('contrast('   + _vContrast.toFixed(2)   + ')');
  if (_vBrightness !== 1.0) parts.push('brightness(' + _vBrightness.toFixed(2) + ')');
  if (_vHue        !== 0)   parts.push('hue-rotate(' + _vHue                   + 'deg)');
  if (_vSaturation !== 1.0) parts.push('saturate('   + _vSaturation.toFixed(2) + ')');
  videoEl.style.filter = parts.join(' ');
}

function adjustVideoFilter(prop, delta) {
  if (prop === 'contrast') {
    _vContrast   = +Math.max(0, Math.min(3, _vContrast   + delta)).toFixed(2);
  } else if (prop === 'brightness') {
    _vBrightness = +Math.max(0, Math.min(3, _vBrightness + delta)).toFixed(2);
  } else if (prop === 'hue') {
    _vHue = ((_vHue + delta) % 360 + 360) % 360;
    if (_vHue > 180) _vHue -= 360;
  } else if (prop === 'saturation') {
    _vSaturation = +Math.max(0, Math.min(3, _vSaturation + delta)).toFixed(2);
  }
  _applyVideoFilter();
}

// ── Track switching ──────────────────────────────────────────────────────────

function cycleAudioTrack() {
  if (!activeMediaEl) return;
  var tracks = activeMediaEl.audioTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].enabled) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].enabled = (i === next); }
}

function cycleVideoTrack() {
  var tracks = videoEl.videoTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].selected) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].selected = (i === next); }
}

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

  // Cancel any in-flight image preload.
  if (_imgPendingLoad) {
    _imgPendingLoad.onload = _imgPendingLoad.onerror = null;
    _imgPendingLoad.src    = '';
    _imgPendingLoad        = null;
  }

  // Cancel any in-progress deferred transition, restoring a clean slate.
  if (_deferredMediaType) {
    // Media was loading invisibly behind the old image; just stop it.
    _deferredMediaType = null;
    _stopActiveMedia();
    // Old image state (src, image-loaded) is intact — no further cleanup.
  } else if (_pendingMediaStop) {
    // Image was preloading behind the old media; stop media now.
    _pendingMediaStop = false;
    _stopActiveMedia();
    mainImageEl.style.visibility = '';
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
  }

  var wasMedia = imagePaneEl.classList.contains('media-video') ||
                 imagePaneEl.classList.contains('media-audio') ||
                 imagePaneEl.classList.contains('media-gif');

  if (type === 'image') {
    if (wasMedia) {
      // media→image: keep media playing while image preloads; stop it only
      // once the image's load event fires (see mainImageEl 'load' handler).
      _pendingMediaStop = true;
      showImage(filename);
    } else {
      // image→image: preload+visibility:hidden is already seamless, no cover.
      showImage(filename);
    }
  } else if (type === 'video' || type === 'audio') {
    if (!wasMedia) {
      // image→media: load media invisibly (no CSS class yet); old image stays
      // visible until loadedmetadata fires (see _onMediaLoadedMetadata).
      _deferredMediaType = type;
      showMedia(filename, type, /*deferred=*/ true);
    } else {
      // media→media: a brief blank with cover is acceptable.
      _startTransitionCover();
      _stopActiveMedia();
      mainImageEl.src = '';
      imagePaneEl.classList.remove('image-loaded');
      showMedia(filename, type, /*deferred=*/ false);
    }
  } else {
    // Unknown type: show empty pane / no-content hint.
    _startTransitionCover();
    _stopActiveMedia();
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    requestAnimationFrame(function() {
      transitionCoverEl.classList.remove('covering');
    });
  }
}

// deferred=true: called from image→media path; don't add the CSS display class
// yet — the old image stays visible.  _onMediaLoadedMetadata() will do the swap.
function showMedia(filename, type, deferred) {
  var fileUrl  = currentDir.replace(/\/$/, '') + '/' + filename;
  var proxyUrl = toProxyFile(fileUrl);

  activeMediaEl      = (type === 'video') ? videoEl : audioEl;
  activeMediaEl.loop   = false;
  activeMediaEl.volume = parseFloat(localStorage.getItem('media-volume') || '1');
  activeMediaEl.muted  = localStorage.getItem('media-muted') === 'true';
  // Balance is applied via _panNode (shared, initialised from localStorage in
  // media-shared.js) and kept in sync on every adjustBalance() / av-settings
  // message, so no per-file re-sync is needed here.

  // Reset per-file video filter to defaults.
  _vContrast = _vBrightness = 1.0;
  _vHue = 0;
  _vSaturation = 1.0;
  videoEl.style.filter = '';

  if (!deferred) {
    // Immediate mode: show spinner and media class right away.
    imgSpinnerEl.classList.remove('hidden');
    imagePaneEl.classList.add(type === 'video' ? 'media-video' : 'media-audio');
  }
  // Deferred: old image stays visible; no spinner, no class until ready.

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

  // Fetch current queue state from background so the pane can reflect it
  // immediately if the user enters queue mode.
  _queueChannel.postMessage({ cmd: 'q-sync' });

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
