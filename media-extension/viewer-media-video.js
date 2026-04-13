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
//   PlayableContent,
//   toggleHudPin.                                          (viewer-media-playable.js)
//   GifContent.                                            (viewer-media-gif.js)

import { LoadContext } from './viewer-load-context.js';
import { PlayableContent, _updateVideoControls, toggleHudPin } from './viewer-media-playable.js';
import { GifContent } from './viewer-media-gif.js';
import { wireMediaElement } from './viewer-audio.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-list.js').ItemList} ItemList */
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */

// ── DOM refs ──────────────────────────────────────────────────────────────────

export var videoEl = /** @type {HTMLVideoElement} */ (document.getElementById('main-video'));
wireMediaElement(videoEl);

// ── Constants ──────────────────────────────────────────────────────────────

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

// ── Video track cycling ───────────────────────────────────────────────────────

/**
 * @param {HTMLVideoElement} el
 */
function cycleVideoTrack(el) {
  var tracks = /** @type {any} */ (el).videoTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].selected) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].selected = (i === next); }
}

// ── VideoContentBase ──────────────────────────────────────────────────────────
export class VideoContentBase extends PlayableContent {
  /**
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats
   */
  constructor(creator, stats) {
    super(creator, stats);
    this._name = 'video:' + this.fullPath;
    // Per-instance CSS filter state; resets to neutral on each new VideoContent.
    // mplayer key layout: 1/2 contrast, 3/4 brightness, 5/6 hue-rotate, 7/8 saturate
    this._vContrast   = 1.0;
    this._vBrightness = 1.0;
    this._vHue        = 0;
    this._vSaturation = 1.0;
  }

  /** @type {HTMLVideoElement} */
  get mediaEl()      { return videoEl; }
  get controlsMode() { return 'video'; }

  // ── CSS filter helpers ──────────────────────────────────────────────────────

  /**
   * @param {HTMLVideoElement} el
   */
  _applyFilter(el) {
    var parts = [];
    if (this._vContrast   !== 1.0) parts.push('contrast('   + this._vContrast.toFixed(2)   + ')');
    if (this._vBrightness !== 1.0) parts.push('brightness(' + this._vBrightness.toFixed(2) + ')');
    if (this._vHue        !== 0)   parts.push('hue-rotate(' + this._vHue                   + 'deg)');
    if (this._vSaturation !== 1.0) parts.push('saturate('   + this._vSaturation.toFixed(2) + ')');
    el.style.filter = parts.join(' ');
  }

  /**
   * @param {string} prop
   * @param {number} delta
   */
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

  // ── Key handler ─────────────────────────────────────────────────────────────

  /**
   * @param {KeyboardEvent} e
   * @param {string} key
   * @param {boolean} ctrl
   * @param {boolean} plain
   */
  handleKey(e, key, ctrl, plain) {
    if (plain) {
      switch (key) {
        // Frame-step forward (Firefox-only mozSeekToNextFrame advances exactly one frame)
        case '.':
          e.preventDefault();
          (/** @type {any} */ (this.mediaEl)).mozSeekToNextFrame();
          _updateVideoControls();
          return;
        // Video track cycling
        case '_':
          e.preventDefault();
          cycleVideoTrack(this.mediaEl);
          return;
        // HUD pin/unpin (o: mplayer OSD key repurposed for the controls overlay)
        case 'o':
          e.preventDefault();
          toggleHudPin();
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
}

/**
 * @this {HTMLVideoElement}
 */
function doAutoFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function() {});
  }
  this.removeEventListener('playing', doAutoFullscreen);
}

// ── VideoContent ──────────────────────────────────────────────────────────────

export class VideoContent extends VideoContentBase {
  /**
   * @returns {GifContent | null}
   */
  mutate() {
    const el = /** @type {HTMLVideoElement} */ (this.mediaEl);
    // Gif-loop detection: short video, no audio → redirect and hand off.
    // GifContent.load() handles gif-specific playback setup.
    if (el === videoEl && isFinite(el.duration) && el.duration < 60 && !(/** @type {any} */ (el)).mozHasAudio) {
      return new GifContent(/** @type {ItemList} */ (this._creator), this._stats);
      // cast is guaranteed to work because the constructor only accepts a real creator.
    }
    return null;
  }

  /**
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   */
  async load(pane, ctx) {
    await super.load(pane, ctx);
    // this await steals back control after mutation; give it back gracefully.
    if (pane.future !== this) return;
    const el = /** @type {HTMLVideoElement} */ (this.mediaEl);
    if (!document.fullscreenElement && FULLSCREEN_DIMS.has(el.videoWidth + 'x' + el.videoHeight)) {
      el.addEventListener('playing', doAutoFullscreen);
      return;
    }
  }

  /**
   * @returns {VideoContent}
   */
  clone() { return new VideoContent(/** @type {ItemList} */ (this._creator), this._stats); }
  // cast is guaranteed to work because the constructor only accepts a real creator.
}
