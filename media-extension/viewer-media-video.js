'use strict';
// ── viewer-media-video.js ─────────────────────────────────────────────────────
//
// VideoContent: plays video files using the shared <video> element, with
// per-instance CSS filter state, gif-loop detection, auto-fullscreen, and a
// key handler for filter adjustment and video-track cycling.
//
// Declares these globals used by other modules:
//   VideoContent.
//
// Calls into globals defined in earlier / later modules:
//   PlayableContent, videoEl, _pendingAutoFS.              (viewer-media-playable.js)
//   GifContent.                                            (viewer-media-gif.js)
//   FULLSCREEN_DIMS.                                       (viewer.js)

// ── Video track cycling ───────────────────────────────────────────────────────

function cycleVideoTrack(el) {
  var tracks = el.videoTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].selected) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].selected = (i === next); }
}

// ── VideoContent ──────────────────────────────────────────────────────────────

class VideoContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
    // Per-instance CSS filter state; resets to neutral on each new VideoContent.
    // mplayer key layout: 1/2 contrast, 3/4 brightness, 5/6 hue-rotate, 7/8 saturate
    this._vContrast   = 1.0;
    this._vBrightness = 1.0;
    this._vHue        = 0;
    this._vSaturation = 1.0;
  }

  get element()   { return videoEl; }
  get paneClass() { return 'media-video'; }

  // ── CSS filter helpers ──────────────────────────────────────────────────────

  _applyFilter(el) {
    var parts = [];
    if (this._vContrast   !== 1.0) parts.push('contrast('   + this._vContrast.toFixed(2)   + ')');
    if (this._vBrightness !== 1.0) parts.push('brightness(' + this._vBrightness.toFixed(2) + ')');
    if (this._vHue        !== 0)   parts.push('hue-rotate(' + this._vHue                   + 'deg)');
    if (this._vSaturation !== 1.0) parts.push('saturate('   + this._vSaturation.toFixed(2) + ')');
    el.style.filter = parts.join(' ');
  }

  _adjustFilter(prop, delta) {
    if (prop === 'contrast') {
      this._vContrast   = +Math.max(0, Math.min(3, this._vContrast   + delta)).toFixed(2);
    } else if (prop === 'brightness') {
      this._vBrightness = +Math.max(0, Math.min(3, this._vBrightness + delta)).toFixed(2);
    } else if (prop === 'hue') {
      this._vHue = ((this._vHue + delta) % 360 + 360) % 360;
      if (this._vHue > 180) this._vHue -= 360;
    } else if (prop === 'saturation') {
      this._vSaturation = +Math.max(0, Math.min(3, this._vSaturation + delta)).toFixed(2);
    }
    this._applyFilter(this.mediaEl);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  prepMediaEl() {
    super.prepMediaEl();
    // Per-instance filter state already defaults to neutral; clear any inline
    // filter left by a previous occupant of the same element.
    this.mediaEl.style.filter = '';
  }

  mutate() {
    const el = this.mediaEl;
    // Gif-loop detection: short video, no audio → redirect and hand off.
    // GifContent.load() handles gif-specific playback setup.
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

  // ── Key handler ─────────────────────────────────────────────────────────────

  handleKey(e, key, ctrl, plain) {
    if (plain) {
      switch (key) {
        // Video track cycling
        case '_':
          e.preventDefault();
          cycleVideoTrack(this.mediaEl);
          return;
        // Color/quality (overrides image quick-zoom keys 1–8 for video;
        // mplayer layout: 1/2 contrast, 3/4 brightness, 5/6 hue, 7/8 saturation)
        case '1': case '2': case '3': case '4':
        case '5': case '6': case '7': case '8':
          e.preventDefault();
          if      (key === '1') this._adjustFilter('contrast',   -0.1);
          else if (key === '2') this._adjustFilter('contrast',   +0.1);
          else if (key === '3') this._adjustFilter('brightness', -0.1);
          else if (key === '4') this._adjustFilter('brightness', +0.1);
          else if (key === '5') this._adjustFilter('hue',        -10);
          else if (key === '6') this._adjustFilter('hue',        +10);
          else if (key === '7') this._adjustFilter('saturation', -0.1);
          else if (key === '8') this._adjustFilter('saturation', +0.1);
          return;
      }
    }
    super.handleKey(e, key, ctrl, plain);
  }

  clone() { return new VideoContent(this.fullPath); }
}
