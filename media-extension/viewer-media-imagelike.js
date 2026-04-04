'use strict';
// ── viewer-media-imagelike.js ─────────────────────────────────────────────────
//
// Shared base class for image and gif-loop content occupants, carrying the
// common key handler: panning, navigation, basic zoom (z/n), and info (:;).
// Image-specific transforms (rotation, mirror/flip, scale stepping, quick zoom)
// live in ImageContent.
//
// Declares these globals used by other modules:
//   ImagelikeContent.
//
// Calls into globals defined in earlier / later modules:
//   ContentOccupant.                                        (viewer-media.js)
//   imagePaneEl.                                            (viewer-ui.js)
//   scrollImage, scaleTo1, toggleZoom.                      (viewer-media-image.js)

const [_onImgPointerDown, _onImgPointerMove, _onImgPointerUp] = (() => {
  let startX, startY, startScrollX, startScrollY;

  function onDown(e) {
    if (e.button !== 0) return;
    imagePaneEl.setPointerCapture(e.pointerId);
    startX       = e.clientX;
    startY       = e.clientY;
    startScrollX = imagePaneEl.scrollLeft;
    startScrollY = imagePaneEl.scrollTop;
    imagePaneEl.addEventListener('pointermove', onMove);
    e.preventDefault();
  }

  function onMove(e) {
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    imagePaneEl.scrollLeft = startScrollX - dx;
    imagePaneEl.scrollTop  = startScrollY - dy;
  }

  function onUp() {
    imagePaneEl.removeEventListener('pointermove', onMove);
  }

  return [onDown, onMove, onUp];
})();

class ImagelikeContent extends ContentOccupant {
  async load(pane, ctx) {
    imagePaneEl.addEventListener('pointerdown', _onImgPointerDown);
    imagePaneEl.addEventListener('pointerup',   _onImgPointerUp);
  }

  async surrender(element) {
    this._detachDragListeners();
  }

  cleanup() {
    this._detachDragListeners();
  }

  _detachDragListeners() {
    imagePaneEl.removeEventListener('pointerdown', _onImgPointerDown);
    imagePaneEl.removeEventListener('pointermove', _onImgPointerMove);
    imagePaneEl.removeEventListener('pointerup',   _onImgPointerUp);
  }

  handleKey(e, key, ctrl, plain) {
    if (plain) {
      switch (key) {
        // Scrolling — 100 px steps
        case 'ArrowUp':    e.preventDefault(); scrollImage(0, -100); return;
        case 'ArrowDown':  e.preventDefault(); scrollImage(0, +100); return;
        case 'ArrowLeft':  e.preventDefault(); scrollImage(-100, 0); return;
        case 'ArrowRight': e.preventDefault(); scrollImage(+100, 0); return;
        // Large scrolling — ~90% of pane
        case 'PageUp':
          e.preventDefault();
          scrollImage(0, -(imagePaneEl.clientHeight * 0.9));
          return;
        case 'PageDown':
          e.preventDefault();
          scrollImage(0, +(imagePaneEl.clientHeight * 0.9));
          return;
        case '-':
          e.preventDefault();
          scrollImage(-(imagePaneEl.clientWidth * 0.9), 0);
          return;
        case '=':
          e.preventDefault();
          scrollImage(+(imagePaneEl.clientWidth * 0.9), 0);
          return;
        // Jump to corners
        case 'Home':
          e.preventDefault();
          imagePaneEl.scrollLeft = 0;
          imagePaneEl.scrollTop  = 0;
          return;
        case 'End':
          e.preventDefault();
          imagePaneEl.scrollLeft = imagePaneEl.scrollWidth;
          imagePaneEl.scrollTop  = imagePaneEl.scrollHeight;
          return;
        // Navigation
        case 'Enter':
        case ' ':
          e.preventDefault();
          this.nextItem();
          return;
        case 'b':
          e.preventDefault();
          this.prevItem();
          return;
        // Scale to 1:1 (shared with ImageContent's quick-zoom '1' alias)
        case 'n': scaleTo1();   return;
        // Zoom-fit toggle
        case 'z': toggleZoom(); return;
      }
    } else if (ctrl) {
      // Fine scrolling — 10 px steps
      switch (key) {
        case 'ArrowUp':    e.preventDefault(); scrollImage(0, -10);  return;
        case 'ArrowDown':  e.preventDefault(); scrollImage(0, +10);  return;
        case 'ArrowLeft':  e.preventDefault(); scrollImage(-10,  0); return;
        case 'ArrowRight': e.preventDefault(); scrollImage(+10,  0); return;
      }
    }
  }
}
