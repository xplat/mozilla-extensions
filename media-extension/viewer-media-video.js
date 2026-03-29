'use strict';
// ── viewer-media-video.js ─────────────────────────────────────────────────────
//
// VideoContent: plays video files using the shared <video> element, with
// per-file filter state, gif-loop detection, and auto-fullscreen.
//
// Declares these globals used by other modules:
//   VideoContent.
//
// Calls into globals defined in earlier / later modules:
//   PlayableContent, videoEl, _pendingAutoFS.              (viewer-media-playable.js)
//   GifContent.                                            (viewer-media-gif.js)
//   FULLSCREEN_DIMS,
//   _vContrast, _vBrightness, _vHue, _vSaturation.        (viewer.js)

class VideoContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  get element()   { return videoEl; }
  get paneClass() { return 'media-video'; }

  prepMediaEl() {
    super.prepMediaEl();
    const el = this.mediaEl;

    if (el === videoEl) {
      // Reset per-file video filter.
      _vContrast = _vBrightness = 1.0;
      _vHue      = 0;
      _vSaturation = 1.0;
      videoEl.style.filter = '';
    }
  }

  mutate() {
    const el = this.mediaEl;
    // Gif-loop detection: short video, no audio → redirect and hand off.
    // GifContent.load() handles the gif-specific playback setup.
    if (el === videoEl && isFinite(el.duration) && el.duration < 60 && !el.mozHasAudio) {
      return new GifContent(this.fullPath);
    }
  }

  async load(pane, ctx) {
    await super.load(pane, ctx);
    const el = this.mediaEl;
    _pendingAutoFS = !document.fullscreenElement &&
        FULLSCREEN_DIMS.has(el.videoWidth + 'x' + el.videoHeight);
    return;
  }

  clone() { return new VideoContent(this.fullPath); }
}
