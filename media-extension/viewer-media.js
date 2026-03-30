'use strict';
// ── viewer-media.js ───────────────────────────────────────────────────────────
//
// ContentOccupant base class, terminal occupants (Empty, Error), and the
// makeContentOccupant factory.  Specific media types live in their own files.
//
// Declares these globals used by other modules:
//   ContentOccupant,
//   EmptyContent, EMPTY_CONTENT, ErrorContent,
//   makeContentOccupant.
//
// Calls into globals defined in earlier / later modules:
//   content,                                             (viewer-content.js)
//   noImageHintEl, errorContentEl, mediaType,            (viewer.js)
//   selector,                                            (viewer-selector.js)
//   ImageContent,                                        (viewer-media-image.js)
//   AudioContent,                                        (viewer-media-audio.js)
//   VideoContent,                                        (viewer-media-video.js)
//   QueuedVideoContent.                                  (viewer-media-queued-video.js)

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
  // null is only allowed for an abstract class.
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
  cleanup() {}

  // Return a pristine (unloaded) copy of this occupant, suitable for a reload
  // attempt.  Returns null if the occupant cannot be reloaded (e.g. EmptyContent).
  clone() { return null; }

  // Navigate to the next / previous item in the current list.
  // QueuedVideoContent overrides these to advance the video queue instead.
  nextItem() { selector.nextFile(); }
  prevItem() { selector.prevFile(); }

  // Handle a keydown event routed from the global dispatcher when this occupant
  // has viewer focus.  Subclasses override; default is a no-op.
  handleKey(e, key, ctrl, plain) {}
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
