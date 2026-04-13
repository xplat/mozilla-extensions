// ── viewer-media-playable.js ──────────────────────────────────────────────────
//
// Common audio+video playback infrastructure: media element refs, lifecycle
// flags, event handlers, autoplay, seek, saved-position persistence, controls
// HUD, transition cover, stop/tear-down, and the PlayableContent base class.
//
// Calls into globals defined in earlier / later modules:
//   toProxyFile, _panValue                                 (media-shared.js)

import { requireElement } from './viewer-util.js'
import { LoadContext, CancelledError } from './viewer-load-context.js';
import { ContentOccupant, FileContent, ErrorContent } from './viewer-media.js'
import { imagePaneEl, infoOverlayEl, updateInfoOverlay, content, _startTransitionCover } from './viewer-content.js'
import { loadAvSettings, playAndAnnounce, togglePlayPause, dropAudioBaton, isAudioMuted, getAudioVolume, getAudioBalance, avSettingsWatcher, _updateChannelWiring } from './viewer-audio.js'
/** @typedef {import('./viewer-content.js').ContentPane} ContentPane */

// ── DOM refs ──────────────────────────────────────────────────────────────────

var videoControlsEl     = requireElement('video-controls');
var videoProgressEl     = requireElement('video-progress');
var videoSeekFillEl     = requireElement('video-seek-fill');
var videoTimeEl         = requireElement('video-time');
var videoVolEl          = requireElement('video-vol');

// ── Autoplay flag and position-checkpoint timer ───────────────────────────────

var _autoplay           = true;  // if false, media loads but does not start playing

// ── Position persistence ──────────────────────────────────────────────────────

/**
 * @param {string} fileUrl
 * @returns {string}
 */
function _posKey(fileUrl) {
  return 'media-pos:' + fileUrl.replace(/^file:\/\//, '');
}

// ── Controls HUD ──────────────────────────────────────────────────────────────

/**
 * @param {number} secs
 * @returns {string}
 */
function fmtTime(secs) {
  var s = Math.floor(secs);
  var m = Math.floor(s / 60);
  var h = Math.floor(m / 60);
  m = m % 60;
  s = s % 60;
  var pad = function(/** @type {number} */ n) { return n < 10 ? '0' + n : String(n); };
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/**
 * @param {HTMLMediaElement} [element]
 * @returns {void}
 */
export function _updateVideoControls(element) {
  // If element === activeMediaEl, update all info (time, progress, volume).
  // If element is null/undefined, update only audio and autoplay info (volume).
  // Otherwise, do nothing.
  const updateAll = (element === activeMediaEl);
  const updateVol = (updateAll || element === undefined);

  if (updateAll && activeMediaEl) {
    var cur = activeMediaEl.currentTime || 0;
    var dur = activeMediaEl.duration;
    if (videoTimeEl) {
      videoTimeEl.textContent = fmtTime(cur) + ' / ' + (isFinite(dur) ? fmtTime(dur) : '?');
    }
    if (videoSeekFillEl && isFinite(dur) && dur > 0) {
      videoSeekFillEl.style.width = (cur / dur * 100).toFixed(2) + '%';
    }
  }

  if (updateVol) {
    if (videoVolEl) {
      var muted = isAudioMuted();
      var rawVol = muted ? 0 : getAudioVolume();
      var volStr = (rawVol <= 0)
        ? '-\u221edB'
        : (Math.round(20 * Math.log10(rawVol)) + 'dB');
      var text = muted ? 'MUTED' : ('VOL\u00a0' + volStr);
      var balance = getAudioBalance();
      if (balance !== 0) {
        var side = balance > 0 ? 'R' : 'L';
        text += '\u2002' + side + Math.abs(balance).toFixed(1);
      }
      if (!_autoplay) text += '\u2002MANUAL';
      videoVolEl.textContent = text;
    }
  }
}

// Progress bar click-to-seek
if (videoProgressEl) {
  videoProgressEl.addEventListener('click', function(e) {
    if (!activeMediaEl || !isFinite(activeMediaEl.duration)) return;
    var rect = videoProgressEl.getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    activeMediaEl.currentTime = frac * activeMediaEl.duration;
    _updateVideoControls(activeMediaEl);
  });
}

// ── A/V settings change subscription ──────────────────────────────────────────
// Subscribe to settings changes only when video/audio controls are visible,
// not when displaying images or other non-playable content.

function _onAvSettingsChange() {
  _updateVideoControls(undefined);
}

var _avSettingsListenerAttached = false;

// Watch imagePaneEl data-mode attribute to manage subscription lifecycle
var modeObserver = new MutationObserver(function() {
  var mode = imagePaneEl.dataset.mode;
  var needsListener = (mode === 'audio' || mode === 'video');

  if (needsListener && !_avSettingsListenerAttached) {
    avSettingsWatcher.addEventListener('avSettingsChange', _onAvSettingsChange);
    _avSettingsListenerAttached = true;
  } else if (!needsListener && _avSettingsListenerAttached) {
    avSettingsWatcher.removeEventListener('avSettingsChange', _onAvSettingsChange);
    _avSettingsListenerAttached = false;
  }
});

modeObserver.observe(imagePaneEl, { attributes: true, attributeFilter: ['data-mode'] });

// ── Autoplay toggle and relative seek ────────────────────────────────────────

export function toggleAutoplay() {
  _autoplay = !_autoplay;
  _updateVideoControls(undefined);
}

// secs may be negative (seek back) or positive (seek forward)
/**
 * @param {HTMLMediaElement} el
 * @param {number} secs
 */
function seekRelative(el, secs) {
  if (!el || !isFinite(el.duration)) return;
  el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + secs));
  _updateVideoControls(el);
}

// ── HUD pin/unpin ─────────────────────────────────────────────────────────────
//
// Toggles the .visible class on #video-controls, which the CSS uses to keep
// the controls overlay shown regardless of hover state.

export function toggleHudPin() {
  if (videoControlsEl) videoControlsEl.classList.toggle('visible');
}

// ── Audio / video track cycling ───────────────────────────────────────────────

/**
 * @param {HTMLMediaElement} el
 */
function cycleAudioTrack(el) {
  if (!el) return;
  var tracks = /** @type {any} */ (el).audioTracks;
  if (!tracks || tracks.length <= 1) return;
  var cur = 0;
  for (var i = 0; i < tracks.length; i++) { if (tracks[i].enabled) { cur = i; break; } }
  var next = (cur + 1) % tracks.length;
  for (var i = 0; i < tracks.length; i++) { tracks[i].enabled = (i === next); }
}

// ── Media element refs and playback lifecycle flags ───────────────────────────

/** @type {HTMLMediaElement | null} */
var activeMediaEl      = null;   // currently active <video> or <audio>, or null
/** @type {any} */
var _controlsClaimedBy = null;   // the key (typically a PlayableContent instance) holding the claim

/**
 * @param {HTMLMediaElement} el
 * @param {any} key
 * @returns {void}
 */
function claimVideoControls(el, key) {
  activeMediaEl = el;
  _controlsClaimedBy = key;
}

/**
 * @param {HTMLMediaElement} el
 * @param {any} key
 * @returns {void}
 */
function releaseVideoControls(el, key) {
  // Only clear if the same element and key that claimed it are releasing it
  if (activeMediaEl === el && _controlsClaimedBy === key) {
    activeMediaEl = null;
    _controlsClaimedBy = null;
  }
}

// Build a human-readable message from a media element's error information.
/**
 * @param {HTMLMediaElement} el
 * @param {string} [path]
 * @returns {string}
 */
function _mediaErrorMessage(el, path) {
  var ext  = path ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : "unknown";
  var code = el.error ? el.error.code : 0;
  if (ext === 'mkv' && code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return 'MKV playback is not supported in this version of Firefox.\n' +
           'Try enabling media.mkv.enabled in about:config, or upgrade to a newer Firefox.';
  }
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
      code === MediaError.MEDIA_ERR_DECODE) {
    return 'This file format is not supported by your browser (' + ext.toUpperCase() + ').';
  }
  return el.error?.message || 'Error loading media.';
}

// ── PlayableContent ───────────────────────────────────────────────────────────

/**
 * @abstract
 */
export class PlayableContent extends FileContent {
  /**
   * @type {HTMLMediaElement}
   */
  get mediaEl() { throw new Error('Abstract property'); }

  /**
   * @type {HTMLElement}
   */
  get element() { return this.mediaEl; }

  // ── Media element event handlers ─────────────────────────────────────────────

  /** @type {number | null} */
  _posCheckpointTimer = null;

  /**
   * @returns {void}
   */
  _clearPosCheckpoint() {
    if (this._posCheckpointTimer !== null) {
      clearTimeout(this._posCheckpointTimer);
      this._posCheckpointTimer = null;
    }
  }

  /**
   * @returns {void}
   */
  _makeEventListeners() {
    const self = this;

    function _onTimeUpdate() {
      _updateVideoControls(self.mediaEl);
      if (self._posCheckpointTimer !== null) return;
      self._posCheckpointTimer = setTimeout(function() {
        self._posCheckpointTimer = null;
        self.savedPosition = self.mediaEl.currentTime;
      }, 5000);
    }
    self._onTimeUpdate = _onTimeUpdate;

    function _onMediaEnded() {
      self.savedPosition = null;
      _updateVideoControls(self.mediaEl);
    }
    self._onMediaEnded = _onMediaEnded;

    function _onMediaPlaying() {
      _updateChannelWiring();  // now playing
    }
    self._onMediaPlaying = _onMediaPlaying;

    /**
     * @param {Event} e
     * @returns {void}
     */
    function _onMediaError(e) {
      // Guard: if src was cleared during navigation, an error is expected.
      if (!/** @type {HTMLMediaElement} */ (e.currentTarget).src) return;
      // Guard: error during an active load — the load's own catch will redirect to
      // ErrorContent with the same message; nothing to do here.
      if (content.future) return;
      var msg = _mediaErrorMessage(/** @type {HTMLMediaElement} */ (e.currentTarget), self.fullPath);
      // Error during committed playback (e.g. stream interrupted): load ErrorContent.
      content.load(new ErrorContent(self, msg));
    }
    self._onMediaError = _onMediaError;
  }

  /** @type {() => void} */
  _onTimeUpdate = () => { throw new Error('_makeEventListeners() not called'); };

  /** @type {() => void} */
  _onMediaEnded = () => { throw new Error('_makeEventListeners() not called'); };

  /** @type {() => void} */
  _onMediaPlaying = () => { throw new Error('_makeEventListeners() not called'); };

  /** @type {(e: Event) => void} */
  _onMediaError = () => { throw new Error('_makeEventListeners() not called'); };

  /**
   * @returns {void}
   */
  prepMediaEl() {
    const el = this.mediaEl;

    // Claim video controls for this content
    claimVideoControls(el, this);

    // Wire the element.
    el.src             = toProxyFile(this.fullPath);
    el.loop            = false;
  }

  /**
   * Now that our content has loaded, should we turn into something else?
   * @returns {ContentOccupant | null}
   */
  mutate() {
    return null;
  }

  /**
   * @returns {number}
   */
  get savedPosition() {
    var raw = localStorage.getItem(_posKey(this.fullPath));
    return raw ? parseFloat(raw) : 0;
  }

  /**
   * @param {number | null} time
   * @returns {void}
   */
  set savedPosition(time) {
    if (time === null) {
      localStorage.removeItem(_posKey(this.fullPath));
    } else {
      localStorage.setItem(_posKey(this.fullPath), String(time));
    }
  }

  /**
   * Overridable -- should we autoplay this media?
   * @returns {boolean}
   */
  _autoplay() {
    return _autoplay;
  }

  /**
   * @param {ContentPane} pane
   * @param {LoadContext} ctx
   * @returns {Promise<void>}
   */
  async load(pane, ctx) {
    // Request the display element.  For same-element (media→media) transitions,
    // surrender() shows the cover and stops the old media before returning.
    await pane.request(this, ctx);

    imagePaneEl.addEventListener('click', togglePlayPause);

    if (!infoOverlayEl.classList.contains('hidden')) updateInfoOverlay(this);

    // Wire src, activeMediaEl, loop — subclass overrides add filter reset etc.
    this.prepMediaEl();

    const el = this.mediaEl;

    // Create and attach instance-specific event listeners
    this._makeEventListeners();
    el.addEventListener('timeupdate', this._onTimeUpdate);
    el.addEventListener('ended', this._onMediaEnded);
    el.addEventListener('playing', this._onMediaPlaying);
    el.addEventListener('error', this._onMediaError);

    // Wait for the browser to have duration/dimensions — or error out.
    try {
      await ctx.waitFor(el, 'loadedmetadata', [el, 'error', () => new Error()]);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      // Media error during load: redirect to ErrorContent so the user sees the
      // message and can retry.  _onMediaError() skips its own display while
      // content.future is set (i.e. now, before commitFuture clears it).
      const errorContent = new ErrorContent(this, _mediaErrorMessage(el, this.fullPath));
      pane.redirect(errorContent, ctx);
      return await errorContent.load(pane, ctx);
    }

    const mutated = this.mutate();
    if (mutated) {
      pane.redirect(mutated, ctx);
      return await mutated.load(pane, ctx);
    }
    // Restore saved playback position.
    var saved = this.savedPosition;
    if (saved > 0 && isFinite(el.duration) && saved < el.duration) {
      el.currentTime = saved;
    }

    loadAvSettings(el);

    if (this._autoplay()) {
      playAndAnnounce(el);
    }
  }

  /**
   * @param {HTMLMediaElement} _element - not used in this implementation
   * @returns {Promise<void>}
   */
  async surrender(_element) {
    imagePaneEl.removeEventListener('click', togglePlayPause);
    _startTransitionCover();
    this._stopActiveMedia();
  }

  /**
   * @returns {void}
   */
  cleanup() {
    imagePaneEl.removeEventListener('click', togglePlayPause);
    this._stopActiveMedia();
  }

  /**
   * @returns {void}
   */
  _stopActiveMedia() {
    const el = this.mediaEl;
    el.removeEventListener('timeupdate', this._onTimeUpdate);
    el.removeEventListener('ended', this._onMediaEnded);
    el.removeEventListener('playing', this._onMediaPlaying);
    el.removeEventListener('error', this._onMediaError);
    this._clearPosCheckpoint();
    el.pause();
    el.removeAttribute('src');
    dropAudioBaton(el);
    releaseVideoControls(el, this);
  }

  /**
   * @param {KeyboardEvent} e
   * @param {string} key
   * @param {boolean} _ctrl - not used in this implementation
   * @param {boolean} plain
   * @returns {void}
   */
  handleKey(e, key, _ctrl, plain) {
    if (!plain) return;
    const el = this.mediaEl;
    switch (key) {
      // Seek (mplayer defaults: ←/→ ±10 s, ↑/↓ ±1 min, PgUp/PgDn ±10 min)
      case 'ArrowLeft':  e.preventDefault(); seekRelative(el, -10);  return;
      case 'ArrowRight': e.preventDefault(); seekRelative(el, +10);  return;
      case 'ArrowUp':    e.preventDefault(); seekRelative(el, +60);  return;
      case 'ArrowDown':  e.preventDefault(); seekRelative(el, -60);  return;
      case 'PageUp':     e.preventDefault(); seekRelative(el, +600); return;
      case 'PageDown':   e.preventDefault(); seekRelative(el, -600); return;
      case 'Home':
        e.preventDefault();
        el.currentTime = 0;
        _updateVideoControls(el);
        return;
      case 'Backspace':
        e.preventDefault();
        el.playbackRate = 1;
        return;
      // Navigation
      case 'Enter':
        e.preventDefault();
        this.nextItem();
        return;
      case 'b':
        e.preventDefault();
        this.prevItem();
        return;
      // Play / pause (or advance when ended)
      case ' ':
        e.preventDefault();
        if (el.ended) { this.nextItem(); }
        else          { togglePlayPause(); }
        return;
      // Playback rate  (</>: ±0.1 step; {/}: halve/double, as in mplayer)
      case '<':
        e.preventDefault();
        el.playbackRate = Math.max(0.25, +(el.playbackRate - 0.1).toFixed(2));
        return;
      case '>':
        e.preventDefault();
        el.playbackRate = Math.min(4.0,  +(el.playbackRate + 0.1).toFixed(2));
        return;
      case '{':
        e.preventDefault();
        el.playbackRate = Math.max(0.25, el.playbackRate / 2);
        return;
      case '}':
        e.preventDefault();
        el.playbackRate = Math.min(4.0,  el.playbackRate * 2);
        return;
      // Audio track cycling
      case 'a':
      case '#': e.preventDefault(); cycleAudioTrack(el); return;
    }
  }
}
