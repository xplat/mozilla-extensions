'use strict';
// ── viewer-media.js ───────────────────────────────────────────────────────────
//
// Content-occupant class hierarchy.  Each media item is an ES6 class instance
// that knows its own full path, how to load itself into the content pane (async,
// cancellable), how to surrender its element to an incoming occupant that needs
// it, and how to clean up when it is silently replaced.
//
// Declares these globals used by other modules:
//   ContentOccupant, ImageContent, GifContent,
//   PlayableContent, AudioContent, VideoContent, QueuedVideoContent,
//   EmptyContent, EMPTY_CONTENT, ErrorContent,
//   makeContentOccupant.
//
// Calls into globals defined in earlier / later modules:
//   CancelledError, LoadContext,                          (viewer-load-context.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   videoEl, audioEl, audioPlaceholderEl, activeMediaEl,
//   _autoplay, _pendingQueuePlay,
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia, _updateVideoControls,
//   _getSavedPosition, _shouldAnnounce,
//   _pendingAutoFS, _mediaErrorMessage,                  (viewer-media-playable.js)
//   _imgPendingLoad, mainImageEl, imgSpinnerEl,
//   transformHostEl, _prevDisplayW, _prevDisplayH,
//   applyImageTransform,                                 (viewer-media-image.js)
//   _qState,                                             (viewer-queue-mgt.js)
//   _bcPost, _updateChannelWiring, _hasAnnounced,        (viewer-audio.js)
//   toProxyFile,                                         (media-shared.js)
//   mediaType, FULLSCREEN_DIMS,
//   _contentPath, _vContrast, _vBrightness, _vHue, _vSaturation,
//   infoOverlayEl, updateInfoOverlay,                    (viewer.js)
//   errorContentEl.                                      (viewer.js)

// ── Base class ────────────────────────────────────────────────────────────────

class ContentOccupant {
  constructor(fullPath) {
    this.fullPath = fullPath;
    this._name    = null;  // set by each concrete subclass
  }

  get name()     { return this._name; }
  get filename() { return this.fullPath ? this.fullPath.replace(/.*\//, '') : null; }

  // Which DOM element does this occupant exclusively own?
  // ContentPane.request() compares elements to decide if surrender is needed.
  get element() { return null; }

  // Which DOM element should be given the 'content-active' class when this
  // occupant is committed?  May differ from element (e.g. audioPlaceholderEl
  // rather than the invisible <audio> element).  null means nothing is shown
  // via content-active (occupant manages its own visibility).
  get displayEl() { return null; }

  // Async: start loading content.  ctx is a LoadContext for event-waits;
  // if ctx.cancel() is called (load superseded), all awaited events reject
  // with CancelledError and load() should return silently.
  // The spinner is started by ContentPane.load() before this is called.
  async load(pane, ctx) {}

  // Async: give up this.element to an incoming occupant that requested it.
  // Called only when the new occupant needs the SAME element as this one.
  // Must resolve only when the element is unused and safe for the caller.
  // Implementations using the transition cover should call _startTransitionCover()
  // here; ImageContent uses visibility:hidden instead.
  async surrender(element) {}

  // Sync: fast cleanup called at commitFuture() time when this occupant's
  // element was NOT surrendered (was already hidden under CSS classes).
  // Must be idempotent.
  cleanup() {}

  // Sync: apply per-type imagePaneEl CSS class(es) for this occupant (e.g.
  // 'media-video').  Called at commitFuture() after old occupant's cleanup().
  // The content-active class on displayEl is managed by commitFuture() directly.
  applyClass() {}

  // Return a pristine (unloaded) copy of this occupant, suitable for a reload
  // attempt.  Returns null if the occupant cannot be reloaded (e.g. EmptyContent).
  clone() { return null; }
}

// ── Image ─────────────────────────────────────────────────────────────────────

class ImageContent extends ContentOccupant {
  constructor(fullPath) {
    super(fullPath);
    this._name        = 'image:' + fullPath;
    this._surrendered = false;
  }

  get element()   { return mainImageEl; }
  get displayEl() { return transformHostEl; }

  async load(pane, ctx) {
    const proxyUrl = toProxyFile(this.fullPath);

    if (!infoOverlayEl.classList.contains('hidden')) updateInfoOverlay(this.filename);
    document.title = this.filename + ' — Media Viewer';

    // Phase 1: preload with a throwaway Image; old content stays visible.
    const pending = new Image();
    _imgPendingLoad = pending;
    pending.src = proxyUrl;
    try {
      await ctx.waitFor(pending, 'load', [pending, 'error', Error]);
    } catch (e) {
      pending.src = '';
      if (_imgPendingLoad === pending) _imgPendingLoad = null;
      if (!(e instanceof CancelledError)) pane.abortFuture(this);
      return;
    }
    if (_imgPendingLoad === pending) _imgPendingLoad = null;

    // Phase 2: request the image element (shared with any other ImageContent).
    // surrender() hides it with visibility:hidden, preserving the layout area.
    await pane.request(this, ctx);

    // Phase 3: feed URL into mainImageEl and wait for decode+paint.
    mainImageEl.style.visibility = 'hidden';
    mainImageEl.src = proxyUrl;
    try {
      await ctx.waitFor(mainImageEl, 'load', [mainImageEl, 'error', Error]);
    } catch (e) {
      mainImageEl.style.visibility = '';
      mainImageEl.src = '';
      if (!(e instanceof CancelledError)) pane.abortFuture(this);
      return;
    }

    // Image decoded: set up transform before revealing.
    imagePaneEl.classList.add('image-loaded');
    _prevDisplayW = 0;
    _prevDisplayH = 0;
    applyImageTransform();
    mainImageEl.style.visibility = '';

    pane.commitFuture(ctx);
    // _endTransitionCover() is called by commitFuture().
  }

  async surrender(element) {
    this._surrendered = true;
    // Use visibility:hidden rather than the cover: preserves the layout area so
    // the incoming ImageContent can overwrite mainImageEl.src without a size flash.
    mainImageEl.style.visibility = 'hidden';
  }

  cleanup() {
    if (this._surrendered) return;
    // Still showing — clear it so the incoming occupant starts from a clean slate.
    if (_imgPendingLoad) { _imgPendingLoad.src = ''; _imgPendingLoad = null; }
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
  }

  applyClass() {
    // image-loaded is set during load() before commitFuture; nothing extra here.
  }

  clone() { return new ImageContent(this.fullPath); }
}

// ── Gif-loop ──────────────────────────────────────────────────────────────────
//
// A short looping video with no audio track, treated as a static image.
// GifContent shares the 'video:' name prefix with VideoContent so that
// gif↔video reclassification via ContentPane.redirect() is transparent.

class GifContent extends ContentOccupant {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  get element()   { return videoEl; }
  get displayEl() { return videoEl; }

  // GifContent is never loaded directly: VideoContent starts the <video> load,
  // then _loadPlayable() detects the gif and calls ContentPane.redirect().
  async load(pane, ctx) {}

  async surrender(element) {
    _startTransitionCover();
    _stopActiveMedia();
  }

  cleanup() { _stopActiveMedia(); }

  applyClass() { imagePaneEl.classList.add('media-gif'); }

  clone() { return new GifContent(this.fullPath); }
}

// ── Playable (audio + video) ──────────────────────────────────────────────────

class PlayableContent extends ContentOccupant {
  async surrender(element) {
    _startTransitionCover();
    _stopActiveMedia();
  }

  cleanup() { _stopActiveMedia(); }
}

class AudioContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'audio:' + fullPath;
  }

  get element()   { return audioEl; }
  get displayEl() { return audioPlaceholderEl; }

  async load(pane, ctx) {
    await _loadPlayable(this, audioEl, 'audio', pane, ctx);
  }

  applyClass() { imagePaneEl.classList.add('media-audio'); }

  clone() { return new AudioContent(this.fullPath); }
}

class VideoContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  get element()   { return videoEl; }
  get displayEl() { return videoEl; }

  async load(pane, ctx) {
    await _loadPlayable(this, videoEl, 'video', pane, ctx);
  }

  applyClass() { imagePaneEl.classList.add('media-video'); }

  clone() { return new VideoContent(this.fullPath); }
}

// ── Queued video ──────────────────────────────────────────────────────────────

class QueuedVideoContent extends VideoContent {
  constructor(fullPath, queueIndex) {
    super(fullPath);
    this.queueIndex = queueIndex;
    this._name = 'qvideo:' + queueIndex + ':' + fullPath;
  }

  clone() { return new QueuedVideoContent(this.fullPath, this.queueIndex); }
}

// ── Empty ─────────────────────────────────────────────────────────────────────
//
// Singleton representing an unoccupied content pane.  content.current starts as
// EMPTY_CONTENT; transitioning away from it needs no cover.

class EmptyContent extends ContentOccupant {
  constructor() {
    super(null);
    this._name = 'empty';
  }

  get filename() { return null; }
  // No element, no displayEl: nothing is shown or surrendered.
}

const EMPTY_CONTENT = new EmptyContent();

// ── Error ─────────────────────────────────────────────────────────────────────
//
// Wraps a failed occupant to display an error message with a retry button.
// Use ContentPane.redirect(new ErrorContent(original, msg), ctx) from inside a
// load() method to handle errors during loading, or content.load(new
// ErrorContent(current, msg)) for errors during committed playback.

class ErrorContent extends ContentOccupant {
  constructor(wrappedOccupant, message) {
    super(wrappedOccupant ? wrappedOccupant.fullPath : null);
    this._wrapped = wrappedOccupant;
    this._message = message || 'An error occurred.';
    this._name    = 'error:' + (wrappedOccupant ? wrappedOccupant.name : 'unknown');
  }

  get displayEl() { return errorContentEl; }

  async load(pane, ctx) {
    // Populate the error display element before committing.
    if (errorContentEl) {
      var msgEl = document.createElement('p');
      msgEl.className = 'error-content-msg';
      msgEl.textContent = this._message;
      errorContentEl.appendChild(msgEl);

      var retryTarget = this._wrapped ? this._wrapped.clone() : null;
      if (retryTarget) {
        var btn = document.createElement('button');
        btn.className = 'error-content-retry';
        btn.textContent = 'Try again';
        btn.addEventListener('click', function() { content.load(retryTarget); });
        errorContentEl.appendChild(btn);
      }
    }

    pane.commitFuture(ctx);
    // _endTransitionCover() is called by commitFuture().
  }

  cleanup() {
    // Clear dynamically-inserted message and retry button when replaced.
    if (errorContentEl) errorContentEl.innerHTML = '';
  }

  // clone() returns the wrapped occupant's clone so a retry re-attempts the
  // original load rather than producing a nested ErrorContent.
  clone() { return this._wrapped ? this._wrapped.clone() : null; }
}

// ── Shared playable load implementation ───────────────────────────────────────
//
// Audio and Video share all loading logic; the only differences are which
// element to use and which CSS class to apply.

async function _loadPlayable(occupant, el, type, pane, ctx) {
  const proxyUrl = toProxyFile(occupant.fullPath);

  // Request the media element.  If current also uses this element (media→media),
  // surrender() shows the cover and stops the old media before returning.
  await pane.request(occupant, ctx);

  // Wire the element.
  activeMediaEl      = el;
  el.loop            = false;
  el.volume          = parseFloat(localStorage.getItem('media-volume') || '1');
  el.muted           = localStorage.getItem('media-muted') === 'true';
  _updateChannelWiring();

  if (el === videoEl) {
    // Reset per-file video filter.
    _vContrast = _vBrightness = 1.0;
    _vHue      = 0;
    _vSaturation = 1.0;
    videoEl.style.filter = '';
  }

  if (!infoOverlayEl.classList.contains('hidden')) updateInfoOverlay(occupant.filename);
  document.title = occupant.filename + ' — Media Viewer';

  el.src = proxyUrl;

  // Wait for the browser to have duration/dimensions — or error out.
  try {
    await ctx.waitFor(el, 'loadedmetadata', [el, 'error', Error]);
  } catch (e) {
    if (!(e instanceof CancelledError)) {
      // Media error during load: redirect to ErrorContent so the user sees the
      // message and can retry.  _onMediaError() skips its own display while
      // content.future is set (i.e. now, before commitFuture clears it).
      pane.redirect(new ErrorContent(occupant, _mediaErrorMessage()), ctx);
      pane.commitFuture(ctx);
    }
    return;
  }

  // Gif-loop detection: short video, no audio → loop silently.
  var isGif = false;
  if (el === videoEl && isFinite(el.duration) && el.duration < 60 && !el.mozHasAudio) {
    isGif = true;
    el.loop  = true;
    el.muted = true;
    pane.redirect(new GifContent(occupant.fullPath), ctx);
  }

  // Restore saved playback position (skipped for gif-loops: no temporal state).
  var saved = 0;
  if (!isGif) {
    saved = content.isQueueContent ? (_qState.video.time || 0)
                                   : _getSavedPosition(occupant.fullPath);
    if (saved > 0 && isFinite(el.duration) && saved < el.duration) {
      el.currentTime = saved;
    }
  }

  var hasAudio = el === audioEl ||
                 (el === videoEl && el.mozHasAudio && !isGif);
  _shouldAnnounce = hasAudio;

  _pendingAutoFS = (el === videoEl && !isGif &&
      !document.fullscreenElement && !(saved > 0) &&
      FULLSCREEN_DIMS.has(el.videoWidth + 'x' + el.videoHeight));

  _updateVideoControls();

  // Commit: if deferred (image→media), this atomically hides the image and
  // shows the media; if immediate, media was already prepared under the cover.
  pane.commitFuture(ctx);
  // _endTransitionCover() is called by commitFuture().

  if (_autoplay || isGif || _pendingQueuePlay) {
    _pendingQueuePlay = false;
    el.play().catch(function() {});
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function makeContentOccupant(fullPath, isQueueItem, queueIndex) {
  var type = mediaType(fullPath.replace(/.*\//, ''));
  if (type === 'image') return new ImageContent(fullPath);
  if (type === 'audio') return new AudioContent(fullPath);
  if (type === 'video') {
    return isQueueItem
      ? new QueuedVideoContent(fullPath, queueIndex)
      : new VideoContent(fullPath);
  }
  return null;
}
