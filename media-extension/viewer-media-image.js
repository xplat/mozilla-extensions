'use strict';
// ── viewer-media-image.js ─────────────────────────────────────────────────────
//
// Image display, preload, and full transform stack: zoom/fit, rotation,
// mirror/flip, scale stepping, scroll, and the ImageContent occupant class.
//
// Declares these globals used by other modules:
//   transformHostEl, mainImageEl, imgSpinnerEl,
//   _prevDisplayW, _prevDisplayH,
//   applyImageTransform,
//   toggleZoom, rotateBy, toggleMirror, toggleFlip, resetOrientation,
//   scaleDouble, scaleHalve, scaleStep, scaleTo1,
//   scrollImage,
//   ImageContent.
//
// Calls into globals defined in earlier / later modules:
//   imagePaneEl,                                          (viewer-ui.js)
//   toProxyFile,                                          (media-shared.js)
//   infoOverlayEl, updateInfoOverlay,                     (viewer.js)
//   ImagelikeContent.                                     (viewer-media-imagelike.js)

import { reserve, save, Hidden, Boolean, Float, Enum } from './state.js';

const _zoomFit        = reserve(Hidden, 'zoomFit', Boolean, true);
const _zoomReduceOnly = reserve(Hidden, 'zoomReduceOnly', Boolean, true);
const _rotation       = reserve(Hidden, 'rotation', Enum('0', '90', '180', '270'), '0');
const _scale          = reserve(Hidden, 'scale', Float, 1.0);
const _mirror         = reserve(Hidden, 'mirror', Boolean, false);
const _flip           = reserve(Hidden, 'flip', Boolean, false);

// ── DOM refs ──────────────────────────────────────────────────────────────────

var transformHostEl = document.getElementById('transform-host');
var mainImageEl     = document.getElementById('main-image');
var imgSpinnerEl    = document.getElementById('img-spinner');

// ── Scale steps ───────────────────────────────────────────────────────────────

// xzgv-style integer-ratio stepping for s/S keys
const SCALE_STEPS = [0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0];

// ── Transform snapshot ────────────────────────────────────────────────────────
//
// Display size and full transform state from the most recent applyImageTransform()
// call.  Used to recover the exact image pixel at the viewport centre before a
// transform change so it can be repositioned afterwards.  Reset on new image.

var _prevDisplayW = 0;
var _prevDisplayH = 0;
var _prevRot    = 0;
var _prevScale  = 1;
var _prevMirror = false;
var _prevFlip   = false;

// ── Image transform ───────────────────────────────────────────────────────────
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
  if (!_zoomFit.get() && _prevDisplayW > 0) {
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

  var rot = parseInt(_rotation.get());

  // Visual dimensions at scale=1 (W/H swap for 90°/270° rotation)
  var visW = (rot === 90 || rot === 270) ? nh : nw;
  var visH = (rot === 90 || rot === 270) ? nw : nh;

  // Compute display scale
  var scale;
  if (_zoomFit.get()) {
    var pW = pane.clientWidth;
    var pH = pane.clientHeight;
    if (!pW || !pH) return;
    scale = Math.min(pW / visW, pH / visH);
    if (_zoomReduceOnly.get()) scale = Math.min(scale, 1.0);
  } else {
    scale = _scale.get();
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
  if (_mirror.get()) parts.push('scaleX(-1)');  // horizontal mirror (M)
  if (_flip.get())   parts.push('scaleY(-1)');  // vertical flip    (F)
  if (scale !== 1) parts.push('scale(' + scale + ')');
  img.style.transform = parts.length ? parts.join(' ') : 'none';

  // Set pane display mode
  if (_zoomFit.get()) {
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
  if (!_zoomFit.get()) {
    var pW = pane.clientWidth;
    var pH = pane.clientHeight;
    var newOffX = Math.max(0, (pW - displayW) / 2);
    var newOffY = Math.max(0, (pH - displayH) / 2);
    var newVis  = _imageOffsetToVisual(_snapIPX, _snapIPY,
                                       rot, _mirror.get(), _flip.get(), scale);
    pane.scrollLeft = Math.max(0, displayW / 2 + newVis.x + newOffX - pW / 2);
    pane.scrollTop  = Math.max(0, displayH / 2 + newVis.y + newOffY - pH / 2);
  }

  _prevDisplayW = displayW;
  _prevDisplayH = displayH;
  _prevRot    = rot;
  _prevScale  = scale;
  _prevMirror = _mirror.get();
  _prevFlip   = _flip.get();
}

// Reapply transform on window resize (fit mode depends on pane size)
window.addEventListener('resize', function() {
  if (mainImageEl.naturalWidth) applyImageTransform();
});

// ── Zoom ──────────────────────────────────────────────────────────────────────

function toggleZoom() {
  _zoomFit.set(!_zoomFit.get());
  if (!_zoomFit.get() && _scale.get() <= 0) _scale.set(1.0);
  applyImageTransform();
  save();
}

// ── Rotation ─────────────────────────────────────────────────────────────────

function rotateBy(deg) {
  const newRotation = (parseInt(_rotation.get()) + deg + 360) % 360;
  _rotation.set(String(newRotation));
  applyImageTransform();
  save();
}

// ── Mirror / Flip ─────────────────────────────────────────────────────────────

// M — horizontal mirror (xzgv 'm')
function toggleMirror() {
  _mirror.set(!_mirror.get());
  applyImageTransform();
  save();
}

// F — vertical flip (xzgv 'f', uppercased to avoid conflict with fullscreen)
function toggleFlip() {
  _flip.set(!_flip.get());
  applyImageTransform();
  save();
}

// ── Orientation reset ─────────────────────────────────────────────────────────

function resetOrientation() {
  _rotation.set('0');
  _mirror.set(false);
  _flip.set(false);
  applyImageTransform();
  save();
}

// ── Scale ─────────────────────────────────────────────────────────────────────

function enterScaleMode() {
  // Switch from fit mode to explicit scale mode
  if (_zoomFit.get()) {
    _zoomFit.set(false);
    // Compute the current effective fit scale and use it as starting point
    if (mainImageEl.naturalWidth) {
      var nw  = mainImageEl.naturalWidth;
      var nh  = mainImageEl.naturalHeight;
      var rot = _rotation.get();
      var vw  = (rot === 90 || rot === 270) ? nh : nw;
      var vh  = (rot === 90 || rot === 270) ? nw : nh;
      var pW  = imagePaneEl.clientWidth;
      var pH  = imagePaneEl.clientHeight;
      var s   = Math.min(pW / vw, pH / vh);
      if (_zoomReduceOnly.get()) s = Math.min(s, 1.0);
      _scale.set(s);
    } else {
      _scale.set(1.0);
    }
  }
}

function scaleDouble() {
  enterScaleMode();
  _scale.set(Math.min(32, _scale.get() * 2));
  applyImageTransform();
  save();
}

function scaleHalve() {
  enterScaleMode();
  _scale.set(Math.max(0.05, _scale.get() / 2));
  applyImageTransform();
  save();
}

function scaleStep(dir) {
  enterScaleMode();
  var cur = _scale.get();
  if (dir > 0) {
    var next = null;
    for (var i = 0; i < SCALE_STEPS.length; i++) {
      if (SCALE_STEPS[i] > cur + 0.001) { next = SCALE_STEPS[i]; break; }
    }
    _scale.set((next !== null) ? next : Math.min(32, cur * 1.5));
  } else {
    var prev = null;
    for (var i = 0; i < SCALE_STEPS.length; i++) {
      if (SCALE_STEPS[i] < cur - 0.001) prev = SCALE_STEPS[i];
    }
    _scale.set((prev !== null) ? prev : Math.max(0.05, cur / 1.5));
  }
  applyImageTransform();
  save();
}

function scaleTo1() {
  _zoomFit.set(false);
  _scale.set(1.0);
  applyImageTransform();
  save();
}

// ── Image scrolling ───────────────────────────────────────────────────────────

function scrollImage(dx, dy) {
  imagePaneEl.scrollLeft += dx;
  imagePaneEl.scrollTop  += dy;
}

// ── ImageContent ──────────────────────────────────────────────────────────────

class ImageContent extends ImagelikeContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'image:' + fullPath;
  }

  // transformHostEl serves as both the exclusive resource (compared in request())
  // and the content-active display target.
  get element()   { return transformHostEl; }

  async load(pane, ctx) {
    const proxyUrl = toProxyFile(this.fullPath);

    if (!infoOverlayEl.classList.contains('hidden')) updateInfoOverlay(this.filename);

    // Phase 1: preload with a throwaway Image; old content stays visible.
    const pending = new Image();
    pending.src = proxyUrl;
    try {
      await ctx.waitFor(pending, 'load', [pending, 'error', () => new Error()]);
    } catch (e) {
      pending.removeAttribute('src');
      throw e;  // CancelledError → swallowed by ContentPane; other → backstop
    }

    // Phase 2: request the shared image element.
    // surrender() hides it with visibility:hidden, preserving the layout area.
    await pane.request(this, ctx);

    // Phase 3: feed URL into mainImageEl and wait for decode+paint.
    mainImageEl.style.visibility = 'hidden';
    mainImageEl.src = proxyUrl;
    try {
      await ctx.waitFor(mainImageEl, 'load', [mainImageEl, 'error', () => new Error]);
    } catch (e) {
      mainImageEl.style.visibility = '';
      mainImageEl.removeAttribute('src');
      throw e;
    }

    // Image decoded: set up transform before revealing.
    _prevDisplayW = 0;
    _prevDisplayH = 0;
    applyImageTransform();
    mainImageEl.style.visibility = '';
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }

  async surrender(element) {
    // Use visibility:hidden rather than the cover: preserves the layout area so
    // the incoming ImageContent can overwrite mainImageEl.src without a size flash.
    mainImageEl.style.visibility = 'hidden';
  }

  cleanup() {
    // Still showing — clear it so the incoming occupant starts from a clean slate.
    mainImageEl.removeAttribute('src');
  }

  clone() { return new ImageContent(this.fullPath); }

  handleKey(e, key, ctrl, plain) {
    if (plain) {
      switch (key) {
        // Rotation (xzgv r/R/N)
        case 'r': rotateBy(90);        return;
        case 'R': rotateBy(-90);       return;
        case 'N': resetOrientation();  return;
        // Mirror / flip (M/F; F avoids fullscreen conflict)
        case 'M': toggleMirror(); return;
        case 'F': toggleFlip();   return;
        // Scale (xzgv d/D/s/S)
        case 'd': scaleDouble(); return;
        case 'D': scaleHalve();  return;
        case 's': scaleStep(+1); return;
        case 'S': scaleStep(-1); return;
        // Quick zoom levels (1 is also the scaleTo1 alias)
        case '1': scaleTo1();                                                              return;
        case '2': _zoomFit.set(false); _scale.set(2); applyImageTransform(); save(); return;
        case '3': _zoomFit.set(false); _scale.set(3); applyImageTransform(); save(); return;
        case '4': _zoomFit.set(false); _scale.set(4); applyImageTransform(); save(); return;
        // Reduce-only toggle (` — replaces xzgv Alt-r)
        case '`':
          _zoomReduceOnly.set(!_zoomReduceOnly.get());
          if (_zoomFit.get()) applyImageTransform();
          save();
          return;
      }
    }
    super.handleKey(e, key, ctrl, plain);
  }
}
