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
//   VideoContent, QueuedVideoContent,                    (viewer-media.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   mainImageEl,                                         (viewer-media-image.js)
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia.                                    (viewer-media-playable.js)

class ContentPane {
  constructor() {
    this.current    = null;  // committed occupant (currently displayed)
    this.future     = null;  // occupant being loaded, or null
    this._futureCtx = null;  // LoadContext for the current future, or null
  }

  // ── State queries ───────────────────────────────────────────────────────────

  get fullPath() {
    var active = this.future || this.current;
    return active ? active.fullPath : null;
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

    if (this.current &&
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
  // Shows the transition cover if needed, cleans up the old occupant, applies
  // the new CSS class, and makes this occupant current.
  // _endTransitionCover() must be called by the caller immediately after.
  commitFuture(occupant) {
    if (occupant !== this.future) return;

    const prev = this.current;

    // Show transition cover when switching away from a visible occupant, except
    // for image→image (which uses the visibility:hidden seamless-swap technique).
    const needCover = prev !== null &&
      !(prev instanceof ImageContent && occupant instanceof ImageContent);
    if (needCover) _startTransitionCover();

    // Clean up old occupant.  cleanup() is a no-op for surrendered occupants.
    if (prev) prev.cleanup();

    // Apply CSS class for the new occupant (e.g. 'media-video').
    // ImageContent.applyClass() is a no-op (image-loaded was set in load()).
    occupant.applyClass();

    this.current    = occupant;
    this.future     = null;
    this._futureCtx = null;
    this._syncLegacyGlobals();
  }

  // Drop the future without committing (load error or cancelled).
  abortFuture(occupant) {
    if (occupant !== this.future) return;
    this.future     = null;
    this._futureCtx = null;
    this._syncLegacyGlobals();
  }

  // ── Gif redirect ────────────────────────────────────────────────────────────

  redirect(gifOccupant) {
    if (this.future instanceof VideoContent) {
      this.future = gifOccupant;
      // fullPath and isQueueContent are unchanged; _syncLegacyGlobals not needed.
    }
  }

  // ── Legacy global sync ──────────────────────────────────────────────────────

  _syncLegacyGlobals() {
    _contentPath    = this.fullPath;
    _isQueueContent = this.isQueueContent;
  }

  // ── Clear ───────────────────────────────────────────────────────────────────

  _clearToEmpty() {
    if (this._futureCtx) { this._futureCtx.cancel(); this._futureCtx = null; }
    this.future = null;
    _startTransitionCover();
    if (this.current) { this.current.cleanup(); this.current = null; }
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    _contentPath    = null;
    _isQueueContent = false;
    _endTransitionCover();
  }
}

var content = new ContentPane();
