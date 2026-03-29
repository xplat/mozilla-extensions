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
//   _startTransitionCover,
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
//   errorContentEl, noImageHintEl.                       (viewer.js)

// ── Base class ────────────────────────────────────────────────────────────────

class ContentOccupant {
  constructor(fullPath) {
    this.fullPath = fullPath;
    this._name    = null;  // set by each concrete subclass
  }

  get name()      { return this._name; }
  get filename()  { return this.fullPath ? this.fullPath.replace(/.*\//, '') : null; }

  // Which DOM element does this occupant exclusively own?
  // ContentPane.request() compares elements to decide if surrender is needed.
  // commitFuture() toggles 'content-active' on this element.
  // null means the occupant manages its own visibility.
  get element()   { return null; }

  // Per-type CSS class to apply to imagePaneEl for HUD / controls visibility.
  // null (default) means no class is needed.
  get paneClass() { return null; }

  // Async: start loading content.  ctx is a LoadContext for event-waits;
  // if ctx.cancel() is called (load superseded), all awaited events reject
  // with CancelledError and load() should return silently.
  // The spinner is started by ContentPane.load() before this is called;
  // commitFuture() is called by ContentPane.load()'s .then() chain.
  async load(pane, ctx) {}

  // Async: give up this.element to an incoming occupant that requested it.
  // Called only when the new occupant needs the SAME element as this one.
  // Must resolve only when the element is unused and safe for the caller.
  // Implementations using the transition cover call _startTransitionCover() here;
  // ImageContent uses visibility:hidden instead.
  async surrender(element) {}

  // Sync: fast cleanup called at commitFuture() time when this occupant's
  // element was NOT surrendered (was already hidden under CSS classes).
  // Must be idempotent.
  cleanup() {}

  // Return a pristine (unloaded) copy of this occupant, suitable for a reload
  // attempt.  Returns null if the occupant cannot be reloaded (e.g. EmptyContent).
  clone() { return null; }
}

// ── Image ─────────────────────────────────────────────────────────────────────

class ImageContent extends ContentOccupant {
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
      throw e;  // CancelledError → swallowed by ContentPane; other → backstop
    }
    if (_imgPendingLoad === pending) _imgPendingLoad = null;

    // Phase 2: request the shared image element.
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
      throw e;
    }

    // Image decoded: set up transform before revealing.
    imagePaneEl.classList.add('image-loaded');
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
    if (_imgPendingLoad) { _imgPendingLoad.src = ''; _imgPendingLoad = null; }
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
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
    this._name    = 'video:' + fullPath;
  }

  get element()   { return videoEl; }
  get paneClass() { return 'media-gif'; }

  // GifContent is reached via redirect() from VideoContent._loadPlayable(), which
  // has already set el.loop/muted and el.src.  This load() secures the element
  // (guarded against double-surrender by ContentPane._surrendered), sets up the
  // gif-specific playback state, and starts playback.
  async load(pane, ctx) {
    await pane.request(this, ctx);
    _shouldAnnounce   = false;
    _pendingAutoFS    = false;
    _pendingQueuePlay = false;
    _updateVideoControls();
    videoEl.play().catch(function() {});
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }

  async surrender(element) {
    _startTransitionCover();
    _stopActiveMedia();
  }

  cleanup() { _stopActiveMedia(); }

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

  // audioPlaceholderEl serves as both the exclusive resource and the display
  // target.  Using it (rather than the invisible audioEl) unifies displayEl and
  // element into a single property.
  get element()   { return audioPlaceholderEl; }
  get paneClass() { return 'media-audio'; }

  async load(pane, ctx) {
    await _loadPlayable(this, audioEl, 'audio', pane, ctx);
  }

  clone() { return new AudioContent(this.fullPath); }
}

class VideoContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  get element()   { return videoEl; }
  get paneClass() { return 'media-video'; }

  async load(pane, ctx) {
    await _loadPlayable(this, videoEl, 'video', pane, ctx);
  }

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
// EMPTY_CONTENT.  noImageHintEl is its exclusive element, so the invariant that
// exactly one element always has 'content-active' is maintained uniformly.

class EmptyContent extends ContentOccupant {
  constructor() {
    super(null);
    this._name = 'empty';
  }

  get filename() { return null; }

  // noImageHintEl is declared in viewer.js, evaluated lazily at call time.
  get element()  { return noImageHintEl; }

  async load(pane, ctx) {
    // Secures noImageHintEl (no surrender ever needed since no other occupant
    // uses it; the call provides a cancellation-check point).
    await pane.request(this, ctx);
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }
}

const EMPTY_CONTENT = new EmptyContent();

// ── Error ─────────────────────────────────────────────────────────────────────
//
// Wraps a failed occupant to display an error message with a retry button.
// Use pane.redirect(new ErrorContent(original, msg), ctx) from inside a load()
// method to handle errors during loading, or content.load(new ErrorContent(...))
// for errors during committed playback.

class ErrorContent extends ContentOccupant {
  constructor(wrappedOccupant, message) {
    super(wrappedOccupant ? wrappedOccupant.fullPath : null);
    this._wrapped = wrappedOccupant;
    this._message = message || 'An error occurred.';
    this._name    = 'error:' + (wrappedOccupant ? wrappedOccupant.name : 'unknown');
  }

  // errorContentEl is declared in viewer.js, evaluated lazily at call time.
  get element() { return errorContentEl; }

  async surrender(element) {
    // Clear the DOM so the incoming ErrorContent starts from a blank slate.
    errorContentEl.innerHTML = '';
  }

  async load(pane, ctx) {
    // Secure errorContentEl, potentially surrendering an earlier ErrorContent.
    await pane.request(this, ctx);

    // Clear any stale content left by a cancelled prior ErrorContent load.
    errorContentEl.innerHTML = '';

    // Populate the error display element before commitFuture() reveals it.
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
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }

  cleanup() {
    // Clear dynamically-inserted message and retry button when replaced.
    errorContentEl.innerHTML = '';
  }

  // clone() returns the wrapped occupant's clone so a retry re-attempts the
  // original load rather than producing a nested ErrorContent.
  clone() { return this._wrapped ? this._wrapped.clone() : null; }
}

// ── Shared playable load implementation ───────────────────────────────────────
//
// Audio and Video share all loading logic; the only differences are which
// element to use and which occupant type was created.

async function _loadPlayable(occupant, el, type, pane, ctx) {
  const proxyUrl = toProxyFile(occupant.fullPath);

  // Request the display element.  For same-element (media→media) transitions,
  // surrender() shows the cover and stops the old media before returning.
  await pane.request(occupant, ctx);

  // For cross-element transitions (e.g. audio→video), surrender() was not
  // called, so we must explicitly stop any still-playing media before taking
  // over activeMediaEl.  Setting pane._surrendered prevents commitFuture from
  // calling cleanup() a second time (which would stop the new element).
  if (activeMediaEl) {
    pane._surrendered = true;
    _stopActiveMedia();
  }

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
    if (e instanceof CancelledError) throw e;
    // Media error during load: redirect to ErrorContent so the user sees the
    // message and can retry.  _onMediaError() skips its own display while
    // content.future is set (i.e. now, before commitFuture clears it).
    pane.redirect(new ErrorContent(occupant, _mediaErrorMessage()), ctx);
    await pane.future.load(pane, ctx);
    return;
  }

  // Gif-loop detection: short video, no audio → redirect and hand off.
  // GifContent.load() handles the gif-specific playback setup.
  if (el === videoEl && isFinite(el.duration) && el.duration < 60 && !el.mozHasAudio) {
    el.loop  = true;
    el.muted = true;
    pane.redirect(new GifContent(occupant.fullPath), ctx);
    await pane.future.load(pane, ctx);
    return;
  }

  // Restore saved playback position.
  var saved = content.isQueueContent ? (_qState.video.time || 0)
                                     : _getSavedPosition(occupant.fullPath);
  if (saved > 0 && isFinite(el.duration) && saved < el.duration) {
    el.currentTime = saved;
  }

  var hasAudio = el === audioEl || (el === videoEl && el.mozHasAudio);
  _shouldAnnounce = hasAudio;

  _pendingAutoFS = (el === videoEl &&
      !document.fullscreenElement && !(saved > 0) &&
      FULLSCREEN_DIMS.has(el.videoWidth + 'x' + el.videoHeight));

  _updateVideoControls();
  // commitFuture() is called by ContentPane.load()'s .then() chain.

  if (_autoplay || _pendingQueuePlay) {
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
