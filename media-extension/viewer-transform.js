'use strict';
// ── viewer-transform.js ───────────────────────────────────────────────────────
//
// Full content transform stack: zoom/fit, rotation,
// mirror/flip, scale stepping, scroll.
//

import * as state from './state.js';

const st = {
  zoomFit       : state.reserve(state.Hidden, 'zoomFit', state.Boolean, true),
  zoomReduceOnly: state.reserve(state.Hidden, 'zoomReduceOnly', state.Boolean, true),
  scale         : state.reserve(state.Hidden, 'scale', state.Float, 1.0),
  rotation      : state.reserve(state.Hidden, 'rotation', state.Enum('0', '90', '180', '270'), '0'),
  mirror        : state.reserve(state.Hidden, 'mirror', state.Boolean, false),
  flip          : state.reserve(state.Hidden, 'flip', state.Boolean, false),
};

export const watcher = new EventTarget();

function emitTransformChanged() {
  const event = new CustomEvent('transformChanged', {});
  watcher.dispatchEvent(event);
}

// When state is restored from history (popstate), notify any active transform instance
state.onLoad(() => {
  emitTransformChanged();
});

// ── Scale steps ───────────────────────────────────────────────────────────────

// xzgv-style integer-ratio stepping for s/S keys
const SCALE_STEPS = [0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0];

// ── Helper functions ──────────────────────────────────────────────────────────
//
// Pure math functions for coordinate transformation. Used by Transform instances.

/**
 * Forward: image-centre offset → visual-centre offset under the given transform.
 * CSS transform order is "rotate scaleX scaleY scale", which means transforms
 * apply right-to-left to a point: scale → flip (scaleY−1) → mirror (scaleX−1)
 * → rotate.
 * @param {number} ox
 * @param {number} oy
 * @param {number} rot
 * @param {boolean} mirror
 * @param {boolean} flip
 * @param {number} scale
 * @returns {{ x: number, y: number }}
 */
function imageOffsetToVisual(ox, oy, rot, mirror, flip, scale) {
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

/**
 * Inverse: visual-centre offset → image-centre offset (exact inverse of above).
 * @param {number} ox
 * @param {number} oy
 * @param {number} rot
 * @param {boolean} mirror
 * @param {boolean} flip
 * @param {number} scale
 * @returns {{ x: number, y: number }}
 */
function visualOffsetToImage(ox, oy, rot, mirror, flip, scale) {
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

// ── Transform class ───────────────────────────────────────────────────────────
//
// Manages the full content transform stack: zoom/fit, rotation, mirror/flip,
// scale stepping, and scroll for a single guest element (img or video).
// Caches the host wrapper and snapshot state (display size and prior transform)
// used to recover the exact image pixel at the viewport centre before a transform
// change so it can be repositioned afterwards. Snapshot resets on new media load.

export class Transform {
  /**
   * @param {HTMLImageElement | HTMLVideoElement} guestElement
   * @param {HTMLElement} pane
   */
  constructor(guestElement, pane) {
    this.guest = guestElement;
    this.pane = pane;

    // Find host wrapper (should have .transform-host class)
    const host = guestElement.parentElement;
    if (!host || !host.classList.contains('transform-host')) {
      throw new Error('Guest element parent must have transform-host class');
    }
    this.host = host;

    // Transform snapshot state: display size and transform from last apply
    this.prevDisplayW = 0;
    this.prevDisplayH = 0;
    this.prevRot    = 0;
    this.prevScale  = 1;
    this.prevMirror = false;
    this.prevFlip   = false;
  }

  // ── Image transform ───────────────────────────────────────────────────────────
  //
  // The transform-host div is sized to the image's visual bounding box.
  // The this.guest element is absolutely positioned at the center of transform-host
  // with CSS transforms for rotation, mirror, and scale.
  //
  // For 90°/270° rotation, visual W and H are swapped relative to natural dims.

  /**
   * Apply current transform state to the image.
   */
  applyTransform() {
    const nw = (this.guest instanceof HTMLImageElement ? this.guest.naturalWidth : this.guest.videoWidth);
    const nh = (this.guest instanceof HTMLImageElement ? this.guest.naturalHeight : this.guest.videoHeight);
    if (!nw || !nh) return;
    const specScale = st.scale.get();
    const flip = st.flip.get();
    const mirror = st.mirror.get();
    const zoomFit = st.zoomFit.get();
    const zoomReduceOnly = st.zoomReduceOnly.get();
    const rotation = st.rotation.get();
    let isTrivial = false;
    if ((zoomFit || specScale === 1) && !flip && !mirror && rotation == '0') {
      // trivial transformation
      isTrivial = true;
    }

    // Capture the exact image pixel at the viewport centre before any changes.
    // Defaults to (0, 0) = image centre for new or previously zoomed images
    // (this.prevDisplayW == 0).
    var _snapIPX = 0, _snapIPY = 0;
    if (!zoomFit && this.prevDisplayW > 0) {
      var _snapPW = this.pane.clientWidth;
      var _snapPH = this.pane.clientHeight;
      var _snapOX = Math.max(0, (_snapPW - this.prevDisplayW) / 2);
      var _snapOY = Math.max(0, (_snapPH - this.prevDisplayH) / 2);
      // Viewport centre → transform-host-centre offset
      var _vcOX = this.pane.scrollLeft + _snapPW / 2 - _snapOX - this.prevDisplayW / 2;
      var _vcOY = this.pane.scrollTop  + _snapPH / 2 - _snapOY - this.prevDisplayH / 2;
      var _snap = visualOffsetToImage(_vcOX, _vcOY,
                                      this.prevRot, this.prevMirror, this.prevFlip, this.prevScale);
      _snapIPX = _snap.x;
      _snapIPY = _snap.y;
    }

    if (isTrivial) {
      this.host.classList.remove('transforming');
      this.host.style.setProperty('--transform-object-fit', zoomFit ? (zoomReduceOnly ? 'scale-down' : 'contain') : 'none');
      if (zoomFit) {
        this.pane.classList.remove('mode-scroll');
        this.prevDisplayW = 0;
        return;
      }
      this.pane.classList.add('mode-scroll');
      this.pane.scrollLeft = Math.max(0, nw / 2 + _snapIPX - this.pane.clientWidth / 2);
      this.pane.scrollTop  = Math.max(0, nh / 2 + _snapIPY - this.pane.clientHeight / 2);
      this.prevDisplayW = nw;
      this.prevDisplayH = nh;
      this.prevRot      = 0;
      this.prevScale    = 1;
      this.prevMirror   = false;
      this.prevFlip     = false;
      return;
    }

    var rot = parseInt(rotation);

    // Visual dimensions at scale=1 (W/H swap for 90°/270° rotation)
    var visW = (rot === 90 || rot === 270) ? nh : nw;
    var visH = (rot === 90 || rot === 270) ? nw : nh;

    // Compute effective display scale
    var scale;
    if (zoomFit) {
      var pW = this.pane.clientWidth;
      var pH = this.pane.clientHeight;
      if (!pW || !pH) return;
      scale = Math.min(pW / visW, pH / visH);
      if (zoomReduceOnly) scale = Math.min(scale, 1.0);
    } else {
      scale = specScale;
    }

    var displayW = visW * scale;
    var displayH = visH * scale;

    // Size the transform-host to the image's visual bounding box
    this.host.classList.add('transforming');
    this.host.style.setProperty("--display-width", Math.ceil(displayW) + 'px');
    this.host.style.setProperty("--display-height", Math.ceil(displayH) + 'px');

    // Center the img within transform-host, then rotate+mirror+scale
    this.host.style.setProperty("--natural-width", nw + 'px');
    this.host.style.setProperty("--natural-height", nh + 'px');

    var parts = [];
    if (rot)    parts.push('rotate(' + rot + 'deg)');
    if (mirror) parts.push('scaleX(-1)');  // horizontal mirror (M)
    if (flip)   parts.push('scaleY(-1)');  // vertical flip    (F)
    if (scale !== 1) parts.push('scale(' + scale + ')');
    this.host.style.setProperty("--forward-transform", parts.length ? parts.join(' ') : 'none');

    // Set pane display mode
    if (zoomFit) {
      this.pane.classList.remove('mode-scroll');
      this.prevDisplayW = 0;
      return;
    } else {
      this.pane.classList.add('mode-scroll');
    }

    // Centre-preservation in scroll mode.  After any transform change (scale,
    // rotation, mirror, flip) we restore the scroll so the image pixel that was
    // at the viewport centre before the change is still at the centre after it.
    //
    // We recover the image pixel via the exact inverse transform, then re-apply
    // the new forward transform to find where it lands.  Exact for all cases.
    // When this.prevDisplayW == 0 (new image) _snapIPX/Y default to (0,0) = image
    // centre, which centres the image in the viewport.
    var pW = this.pane.clientWidth;
    var pH = this.pane.clientHeight;
    var newOffX = Math.max(0, (pW - displayW) / 2);
    var newOffY = Math.max(0, (pH - displayH) / 2);
    var newVis  = imageOffsetToVisual(_snapIPX, _snapIPY,
                                      rot, mirror, flip, scale);
    this.pane.scrollLeft = Math.max(0, displayW / 2 + newVis.x + newOffX - pW / 2);
    this.pane.scrollTop  = Math.max(0, displayH / 2 + newVis.y + newOffY - pH / 2);

    this.prevDisplayW = displayW;
    this.prevDisplayH = displayH;
    this.prevRot    = rot;
    this.prevScale  = scale;
    this.prevMirror = mirror;
    this.prevFlip   = flip;
  }

  /**
   * Clear all transform styles from the image element.
   */
  clearTransform() {
    this.host.classList.remove('transforming');
    for (const p of ['--forward-transform', '--reverse-transform', '--natural-width', '--natural-height', '--display-width', '--display-height', '--transform-object-fit']) {
      this.host.style.removeProperty(p);
    }
    this.pane.classList.remove('mode-scroll');
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────────

  /**
   * Toggle between zoom-to-fit and explicit scale mode.
   */
  toggleZoom() {
    st.zoomFit.set(!st.zoomFit.get());
    if (!st.zoomFit.get() && st.scale.get() <= 0) st.scale.set(1.0);
    this.applyTransform();
    state.save();
  }

  /**
   * Toggle whether zoom-to-fit limits magnification to 100%.
   */
  toggleZoomReduceOnly() {
    st.zoomReduceOnly.set(!st.zoomReduceOnly.get());
    this.applyTransform();
    state.save();
  }

  // ── Rotation ─────────────────────────────────────────────────────────────────

  /**
   * Rotate the image by the given number of degrees.
   * @param {number} deg
   */
  rotateBy(deg) {
    const newRotation = (parseInt(st.rotation.get()) + deg + 360) % 360;
    st.rotation.set(/** @type {"0"|"90"|"180"|"270"} */ (String(newRotation)));
    this.applyTransform();
    state.save();
  }

  // ── Mirror / Flip ─────────────────────────────────────────────────────────────

  /**
   * Toggle horizontal mirror (xzgv 'm').
   */
  toggleMirror() {
    st.mirror.set(!st.mirror.get());
    this.applyTransform();
    state.save();
  }

  /**
   * Toggle vertical flip (xzgv 'f', uppercased to avoid conflict with fullscreen).
   */
  toggleFlip() {
    st.flip.set(!st.flip.get());
    this.applyTransform();
    state.save();
  }

  // ── Orientation reset ─────────────────────────────────────────────────────────

  /**
   * Reset rotation, mirror, and flip to their default states.
   */
  resetOrientation() {
    st.rotation.set('0');
    st.mirror.set(false);
    st.flip.set(false);
    this.applyTransform();
    state.save();
  }

  // ── Scale ─────────────────────────────────────────────────────────────────────

  /**
   * Switch from fit mode to explicit scale mode.
   */
  enterScaleMode() {
    if (st.zoomFit.get()) {
      st.zoomFit.set(false);
      // Compute the current effective fit scale and use it as starting point
      var nw  = (this.guest instanceof HTMLImageElement ? this.guest.naturalWidth : this.guest.videoWidth);
      if (nw) {
        var nh  = (this.guest instanceof HTMLImageElement ? this.guest.naturalHeight : this.guest.videoHeight);
        var rot = st.rotation.get();
        var vw  = (rot === "90" || rot === "270") ? nh : nw;
        var vh  = (rot === "90" || rot === "270") ? nw : nh;
        var pW  = this.pane.clientWidth;
        var pH  = this.pane.clientHeight;
        var s   = Math.min(pW / vw, pH / vh);
        if (st.zoomReduceOnly.get()) s = Math.min(s, 1.0);
        st.scale.set(s);
      } else {
        st.scale.set(1);
      }
    }
  }

  /**
   * Double the current scale factor.
   */
  scaleDouble() {
    this.enterScaleMode();
    st.scale.set(Math.min(32, st.scale.get() * 2));
    this.applyTransform();
    state.save();
  }

  /**
   * Halve the current scale factor.
   */
  scaleHalve() {
    this.enterScaleMode();
    st.scale.set(Math.max(0.05, st.scale.get() / 2));
    this.applyTransform();
    state.save();
  }

  /**
   * Step through preset scale factors in the given direction.
   * @param {number} dir
   */
  scaleStep(dir) {
    this.enterScaleMode();
    var cur = st.scale.get();
    if (dir > 0) {
      var next = null;
      for (var i = 0; i < SCALE_STEPS.length; i++) {
        if (SCALE_STEPS[i] > cur + 0.001) { next = SCALE_STEPS[i]; break; }
      }
      st.scale.set((next !== null) ? next : Math.min(32, cur * 1.5));
    } else {
      var prev = null;
      for (var i = 0; i < SCALE_STEPS.length; i++) {
        if (SCALE_STEPS[i] < cur - 0.001) prev = SCALE_STEPS[i];
      }
      st.scale.set((prev !== null) ? prev : Math.max(0.05, cur / 1.5));
    }
    this.applyTransform();
    state.save();
  }

  /**
   * Set the scale factor to a specific value.
   * @param {number} scale
   */
  scaleTo(scale) {
    st.zoomFit.set(false);
    st.scale.set(scale);
    this.applyTransform();
    state.save();
  }

  /**
   * Reset snapshot state when a new image is loaded.
   */
  resetSnapshot() {
    this.prevDisplayW = 0;
  }
}

// ── Module-level utility functions ────────────────────────────────────────────
//
// These functions operate on the global pane or don't have instance context.

// ── Image scrolling ───────────────────────────────────────────────────────────

/**
 * Scroll the image pane by the given amount.
 * @param {HTMLElement} pane
 * @param {number} dx
 * @param {number} dy
 */
export function scrollImage(pane, dx, dy) {
  pane.scrollLeft += dx;
  pane.scrollTop  += dy;
}

