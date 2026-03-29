'use strict';
// ── viewer-content.js ─────────────────────────────────────────────────────────
//
// ContentPane: manages current and future content-pane occupants, drives
// transitions, and exposes state queries used by event handlers.
//
// Declares these globals:
//   content                                               (ContentPane instance)
//
// Maintains legacy globals _contentPath and _isQueueContent in sync for
// event handlers that read them directly.
//
// Calls into globals defined in earlier / later modules:
//   CancelledError, LoadContext,                         (viewer-load-context.js)
//   ImageContent, GifContent, PlayableContent,
//   VideoContent, QueuedVideoContent,
//   EmptyContent, EMPTY_CONTENT, ErrorContent,           (viewer-media.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   mainImageEl, imgSpinnerEl,                           (viewer-media-image.js)
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia.                                    (viewer-media-playable.js)

class ContentPane {
  constructor() {
    this.current    = EMPTY_CONTENT;  // committed occupant (currently displayed)
    this.future     = null;           // occupant being loaded, or null
    this._futureCtx = null;           // LoadContext for the current future, or null
  }

  // ── State queries ───────────────────────────────────────────────────────────

  get fullPath() {
    var active = this.future || this.current;
    return (active && !(active instanceof EmptyContent)) ? active.fullPath : null;
  }

  get isQueueContent() {
    return (this.future || this.current) instanceof QueuedVideoContent;
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  // Kick off an async content load.  Returns false if already loaded (no-op).
  // The actual loading runs asynchronously; this method returns immediately
  // after starting it so the caller can proceed (e.g. set focus).
  load(occupant) {
    if (!occupant) { this._clearToEmpty(); return true; }

    if (!(this.current instanceof EmptyContent) &&
        this.current.name === occupant.name &&
        !this.future) {
      return false;  // already loaded, nothing to do
    }

    // Cancel any in-progress load.
    if (this._futureCtx) {
      this._futureCtx.cancel();
      this._futureCtx = null;
    }
    this.future = null;

    const ctx = new LoadContext();
    this._futureCtx = ctx;
    this.future     = occupant;
    this._syncLegacyGlobals();

    // Spinner on: stopped by commitFuture() on success or abortFuture() on failure.
    imgSpinnerEl.classList.remove('hidden');

    occupant.load(this, ctx).catch(function(e) {
      if (e instanceof CancelledError) return;
      console.error('content load failed:', e);
      content.abortFuture(occupant);
    });

    return true;
  }

  // ── Request ─────────────────────────────────────────────────────────────────

  // Called by occupant.load() when it needs its element.
  // If the current occupant uses the same element, ask it to surrender first.
  // After this resolves, the element is unused.
  async request(occupant, ctx) {
    if (this.current &&
        this.current.element !== null &&
        this.current.element === occupant.element) {
      await this.current.surrender(occupant.element);
    }
    if (ctx._cancelled) throw new CancelledError();
  }

  // ── Commit ──────────────────────────────────────────────────────────────────

  // Called by occupant.load() once loading has completed successfully.
  // Stops the spinner, starts the transition cover if needed, cleans up the old
  // occupant, applies the new CSS class, and makes this occupant current.
  // Calls _endTransitionCover() internally so callers need not do so.
  commitFuture(ctx) {
    if (ctx !== this._futureCtx) return;
    const occupant = this.future;
    const prev     = this.current;

    imgSpinnerEl.classList.add('hidden');

    // Show transition cover when switching away from a visible non-empty
    // occupant, except for image→image (which uses visibility:hidden).
    // surrender() already started it for same-element transitions; this handles
    // the deferred cross-element case (e.g. image→media).
    const needCover = !(prev instanceof EmptyContent) &&
      !(prev instanceof ImageContent && occupant instanceof ImageContent);
    if (needCover) _startTransitionCover();  // idempotent if already covering

    // Clean up old occupant.  cleanup() is a no-op for surrendered occupants.
    if (prev) prev.cleanup();

    // Manage the content-active class on display elements.
    // Avoid a remove+add flash when the same displayEl is reused (same-type swap).
    if (prev && prev.displayEl && prev.displayEl !== occupant.displayEl) {
      prev.displayEl.classList.remove('content-active');
    }
    if (occupant.displayEl) {
      occupant.displayEl.classList.add('content-active');
    }

    // Apply per-type imagePaneEl class for HUD / controls visibility.
    occupant.applyClass();

    this.current    = occupant;
    this.future     = null;
    this._futureCtx = null;
    this._syncLegacyGlobals();

    _endTransitionCover();
  }

  // ── Abort ───────────────────────────────────────────────────────────────────

  // Drop the future without committing (load error or cancelled).
  abortFuture(occupant) {
    if (occupant !== this.future) return;
    imgSpinnerEl.classList.add('hidden');
    this.future     = null;
    this._futureCtx = null;
    this._syncLegacyGlobals();
  }

  // ── Redirect ────────────────────────────────────────────────────────────────

  // Swap the future occupant mid-load without cancelling the load.  The context
  // is passed for validation; a stale ctx is silently ignored.  More permissive
  // than checking the outgoing occupant's type — any in-progress future can be
  // redirected as long as the ctx matches.
  redirect(newOccupant, ctx) {
    if (ctx !== this._futureCtx) return;
    this.future = newOccupant;
    // fullPath and isQueueContent are typically unchanged by gif redirects;
    // _syncLegacyGlobals is not needed in the common case but is harmless.
  }

  // ── Legacy global sync ──────────────────────────────────────────────────────

  _syncLegacyGlobals() {
    _contentPath    = this.fullPath;
    _isQueueContent = this.isQueueContent;
  }

  // ── Clear ───────────────────────────────────────────────────────────────────

  _clearToEmpty() {
    if (this._futureCtx) { this._futureCtx.cancel(); this._futureCtx = null; }
    imgSpinnerEl.classList.add('hidden');
    this.future = null;
    const prev = this.current;
    if (prev && !(prev instanceof EmptyContent)) {
      if (prev.displayEl) prev.displayEl.classList.remove('content-active');
      prev.cleanup();
    }
    this.current    = EMPTY_CONTENT;
    _contentPath    = null;
    _isQueueContent = false;
    _startTransitionCover();
    _endTransitionCover();
  }
}

var content = new ContentPane();
