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
//   makeContentOccupant.
//
// Calls into globals defined in earlier / later modules:
//   CancelledError, LoadContext,                          (viewer-load-context.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   videoEl, audioEl, activeMediaEl,
//   _autoplay, _pendingQueuePlay,
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia, _updateVideoControls,
//   _getSavedPosition, _shouldAnnounce,
//   _pendingAutoFS,                                      (viewer-media-playable.js)
//   _imgPendingLoad, mainImageEl, imgSpinnerEl,
//   transformHostEl, _prevDisplayW, _prevDisplayH,
//   applyImageTransform,                                 (viewer-media-image.js)
//   _qState,                                             (viewer-queue-mgt.js)
//   _bcPost, _updateChannelWiring, _hasAnnounced,        (viewer-audio.js)
//   toProxyFile,                                         (media-shared.js)
//   mediaType, FULLSCREEN_DIMS,
//   _contentPath, _vContrast, _vBrightness, _vHue, _vSaturation,
//   infoOverlayEl, updateInfoOverlay.                    (viewer.js)

// ── Base class ────────────────────────────────────────────────────────────────

class ContentOccupant {
  constructor(fullPath) {
    this.fullPath = fullPath;
    this._name    = null;  // set by each concrete subclass
  }

  get name()     { return this._name; }
  get filename() { return this.fullPath.replace(/.*\//, ''); }

  // Which DOM element does this occupant use?
  // ContentPane.request() compares elements to decide if surrender is needed.
  get element() { return null; }

  // Async: start loading content.  ctx is a LoadContext for event-waits;
  // if ctx.cancel() is called (load superseded), all awaited events reject
  // with CancelledError and load() should return silently.
  async load(pane, ctx) {}

  // Async: give up this.element to an incoming occupant that requested it.
  // Called only when the new occupant needs the SAME element as this one.
  // Must resolve only when the element is unused and safe for the caller.
  async surrender(element) {}

  // Sync: fast cleanup called at commitFuture() time when this occupant's
  // element was NOT surrendered (was already hidden under CSS classes).
  // Must be idempotent.
  cleanup() {}

  // Sync: apply imagePaneEl CSS class(es) for this occupant.
  // Called at commitFuture() after old occupant's cleanup().
  applyClass() {}
}

// ── Image ─────────────────────────────────────────────────────────────────────

class ImageContent extends ContentOccupant {
  constructor(fullPath) {
    super(fullPath);
    this._name       = 'image:' + fullPath;
    this._surrendered = false;
  }

  get element() { return mainImageEl; }

  async load(pane, ctx) {
    const proxyUrl = toProxyFile(this.fullPath);

    imgSpinnerEl.classList.remove('hidden');
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
      if (!(e instanceof CancelledError)) imgSpinnerEl.classList.add('hidden');
      return;
    }
    if (_imgPendingLoad === pending) _imgPendingLoad = null;

    // Phase 2: request the image element.  If current is also ImageContent,
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
      if (!(e instanceof CancelledError)) imgSpinnerEl.classList.add('hidden');
      return;
    }

    // Image decoded: set up transform before revealing.
    imgSpinnerEl.classList.add('hidden');
    imagePaneEl.classList.add('image-loaded');
    _prevDisplayW = 0;
    _prevDisplayH = 0;
    applyImageTransform();
    mainImageEl.style.visibility = '';

    pane.commitFuture(this);
    _endTransitionCover();
  }

  async surrender(element) {
    this._surrendered = true;
    // Hide seamlessly: preserve image-loaded so the area stays allocated while
    // the incoming ImageContent overwrites mainImageEl.src.
    mainImageEl.style.visibility = 'hidden';
  }

  cleanup() {
    if (this._surrendered) return;
    // Still showing — clear it so the incoming occupant can add its own class.
    if (_imgPendingLoad) { _imgPendingLoad.src = ''; _imgPendingLoad = null; }
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
  }

  applyClass() {
    // load() already adds image-loaded; nothing extra to do at commit time.
  }
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

  get element() { return videoEl; }

  // GifContent is never loaded directly: VideoContent starts the <video> load,
  // then _onMediaLoadedMetadata detects the gif and calls ContentPane.redirect().
  async load(pane, ctx) {}

  async surrender(element) {
    _startTransitionCover();
    _stopActiveMedia();
  }

  cleanup() { _stopActiveMedia(); }

  applyClass() {
    imagePaneEl.classList.add('media-gif');
  }
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

  get element() { return audioEl; }

  async load(pane, ctx) {
    await _loadPlayable(this, audioEl, 'audio', pane, ctx);
  }

  applyClass() { imagePaneEl.classList.add('media-audio'); }
}

class VideoContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  get element() { return videoEl; }

  async load(pane, ctx) {
    await _loadPlayable(this, videoEl, 'video', pane, ctx);
  }

  applyClass() { imagePaneEl.classList.add('media-video'); }
}

// ── Queued video ──────────────────────────────────────────────────────────────

class QueuedVideoContent extends VideoContent {
  constructor(fullPath, queueIndex) {
    super(fullPath);
    this.queueIndex = queueIndex;
    this._name = 'qvideo:' + queueIndex + ':' + fullPath;
  }
}

// ── Shared playable load implementation ───────────────────────────────────────
//
// Audio and Video share all loading logic; the only differences are which
// element to use, which CSS class to apply, and which type string to pass.

async function _loadPlayable(occupant, el, type, pane, ctx) {
  const proxyUrl  = toProxyFile(occupant.fullPath);
  const isDeferred = pane.current instanceof ImageContent;

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

  if (!isDeferred) {
    // Immediate (non-deferred) mode: cover may be on from surrender; show spinner.
    imgSpinnerEl.classList.remove('hidden');
  }
  // Deferred (image→media): old image stays visible until loadedmetadata.

  if (!infoOverlayEl.classList.contains('hidden')) updateInfoOverlay(occupant.filename);
  document.title = occupant.filename + ' — Media Viewer';

  el.src = proxyUrl;

  // Wait for the browser to have duration/dimensions — or error out.
  try {
    await ctx.waitFor(el, 'loadedmetadata', [el, 'error', Error]);
  } catch (e) {
    imgSpinnerEl.classList.add('hidden');
    return;  // cancelled or media error (global _onMediaError shows the message)
  }

  imgSpinnerEl.classList.add('hidden');

  // Gif-loop detection: short video, no audio → loop silently.
  var isGif = false;
  if (el === videoEl && isFinite(el.duration) && el.duration < 60 && !el.mozHasAudio) {
    isGif = true;
    el.loop  = true;
    el.muted = true;
    pane.redirect(new GifContent(occupant.fullPath));
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
  pane.commitFuture(content.future);
  _endTransitionCover();

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
