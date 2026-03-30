'use strict';
// ── viewer-content.js ─────────────────────────────────────────────────────────
//
// ContentPane: manages current and future content-pane occupants, drives
// transitions, and exposes state queries used by event handlers.
//
// Declares these globals:
//   content                                               (ContentPane instance)
//
// Calls into globals defined in earlier / later modules:
//   CancelledError, LoadContext,                         (viewer-load-context.js)
//   ImageContent, GifContent, PlayableContent,
//   VideoContent, QueuedVideoContent,
//   EmptyContent, EMPTY_CONTENT, ErrorContent,           (viewer-media.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   imgSpinnerEl,                                        (viewer-media-image.js)
//   selector,                                            (viewer-selector.js)
//   _endTransitionCover.                                 (viewer-media-playable.js)

class ContentPane {
  constructor() {
    this.current      = EMPTY_CONTENT;  // committed occupant (currently displayed)
    this.future       = null;           // occupant being loaded, or null
    this._futureCtx   = null;           // LoadContext for the current future, or null
    this._surrendered = false;          // true once current has surrendered its element
  }

  // ── State queries ───────────────────────────────────────────────────────────

  get fullPath() {
    var active = this.future || this.current;
    return (active && active.name !== 'empty') ? active.fullPath : null;
  }

  get isQueueContent() {
    return (this.future || this.current) instanceof QueuedVideoContent;
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  // Kick off an async content load.  Returns false if already loaded (no-op).
  // The actual loading runs asynchronously; this method returns immediately
  // after starting it so the caller can proceed (e.g. set focus).
  load(occupant) {
    if (this.current.name === occupant.name && !this.future) {
      return false;  // already loaded, nothing to do
    }

    // Cancel any in-progress load.  _surrendered is NOT reset here: if the
    // outgoing current already surrendered its element, that state stands and
    // guards against calling surrender again on the next request().
    if (this._futureCtx) {
      this._futureCtx.cancel();
      this._futureCtx = null;
    }
    this.future = null;

    const ctx = new LoadContext();
    this._futureCtx = ctx;
    this.future     = occupant;

    // Spinner on: stopped by commitFuture() on success.
    imgSpinnerEl.classList.remove('hidden');

    if (occupant.filename) {
      document.title = occupant.filename + ' — Media Viewer';
    } else {
      selector.updateDirPath();
    }

    const self = this;
    occupant.load(this, ctx)
      .then(function() { self.commitFuture(ctx); })
      .catch(function(e) {
        if (e instanceof CancelledError) return;
        console.error('content load failed:', e);
        content.load(new ErrorContent(occupant, 'Failed to load content.'));
      });

    return true;
  }

  // ── Request ─────────────────────────────────────────────────────────────────

  // Called by occupant.load() when it needs its element.
  // If the current occupant uses the same element, ask it to surrender first.
  // After this resolves, the element is unused.
  // Double-surrender is guarded by the central _surrendered flag.
  async request(occupant, ctx) {
    if (!this._surrendered && this.current.element === occupant.element) {
      this._surrendered = true;
      await this.current.surrender(occupant.element);
    }
    if (ctx._cancelled) throw new CancelledError();
  }

  // ── Commit ──────────────────────────────────────────────────────────────────

  // Called by the .then() chain in load() after occupant.load() resolves.
  // Stops the spinner, cleans up the old occupant, switches the content-active
  // class, applies the imagePaneEl mode class, and ends any transition cover.
  commitFuture(ctx) {
    if (ctx !== this._futureCtx) return;
    const occupant = this.future;
    const prev     = this.current;

    imgSpinnerEl.classList.add('hidden');

    // Clean up old occupant.  No-op if it was surrendered (already torn down).
    if (!this._surrendered) prev.cleanup();

    // Manage content-active on display elements.
    // Avoid a remove+add flash when the same element is reused.
    if (prev.element && prev.element !== occupant.element) {
      prev.element.classList.remove('content-active');
    }
    if (occupant.element) {
      occupant.element.classList.add('content-active');
    }

    // Apply per-type imagePaneEl class for HUD / controls visibility.
    // Old class is always removed first; _stopActiveMedia() may have already
    // done this, but the remove is idempotent.
    imagePaneEl.classList.remove('media-video', 'media-audio', 'media-gif');
    if (occupant.paneClass) imagePaneEl.classList.add(occupant.paneClass);

    this.current      = occupant;
    this.future       = null;
    this._futureCtx   = null;
    this._surrendered = false;

    _endTransitionCover();
  }

  // ── Key dispatch ────────────────────────────────────────────────────────────

  // Route a keydown event to the current occupant, but swallow it silently
  // while a new occupant is loading (future !== null).
  handleKey(e, key, ctrl, plain) {
    if (this.future) return;
    this.current.handleKey(e, key, ctrl, plain);
  }

  // ── Redirect ────────────────────────────────────────────────────────────────

  // Swap the future occupant mid-load without cancelling the load.  The context
  // is checked for staleness; a mismatched ctx is silently ignored.  By
  // convention the caller should immediately hand off via pane.future.load().
  redirect(newOccupant, ctx) {
    if (ctx !== this._futureCtx) return;
    this.future = newOccupant;
  }
}

var content = new ContentPane();
