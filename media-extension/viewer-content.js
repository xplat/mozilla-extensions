'use strict';
// ── viewer-content.js ─────────────────────────────────────────────────────────
//
// ContentPane: manages the current and future content-pane occupants, drives
// load transitions, and exposes state queries used by event handlers.
//
// Declares these globals:
//   content                                               (ContentPane instance)
//
// Also maintains the legacy globals _contentPath and _isQueueContent in sync
// for event handlers not yet migrated to content.* directly.
//
// Calls into globals defined in earlier / later modules:
//   ImageContent, GifContent, PlayableContent,
//   VideoContent, QueuedVideoContent,                    (viewer-media.js)
//   imagePaneEl,                                         (viewer-ui.js)
//   mainImageEl, _imgPendingLoad,                        (viewer-media-image.js)
//   _startTransitionCover, _endTransitionCover,
//   _stopActiveMedia.                                    (viewer-media-playable.js)

class ContentPane {
  constructor() {
    this.current = null;  // committed occupant (what is currently displayed)
    this.future  = null;  // occupant being loaded, or null
  }

  // ── State queries ───────────────────────────────────────────────────────────

  // Full path of whatever is loading or currently displayed.
  get fullPath() {
    var active = this.future || this.current;
    return active ? active.fullPath : null;
  }

  // True when the active content (loading or displayed) is a queue video.
  get isQueueContent() {
    return (this.future || this.current) instanceof QueuedVideoContent;
  }

  // True when the current→future transition is deferred (image→media):
  // the old image stays visible until loadedmetadata fires; no CSS class is
  // added yet.  Called by PlayableContent.load() to decide whether to skip
  // the spinner/class-add, and by _onMediaLoadedMetadata for the same reason.
  _isDeferred() {
    return (this.current instanceof ImageContent) &&
           (this.future  instanceof PlayableContent ||
            this.future  instanceof GifContent);
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  // Request loading of a new occupant.
  // Returns false if the same content is already loaded (no-op).
  // Returns true if loading was started (or the pane was cleared).
  load(occupant) {
    if (!occupant) { this._clearToEmpty(); return true; }

    // Deduplication: same content already current, nothing pending → no-op.
    if (this.current &&
        this.current.name === occupant.name &&
        !this.future) {
      return false;
    }

    // Cancel any previous pending future before replacing it.
    if (this.future) {
      this.future.surrender();
      this.future = null;
    }

    var curIsImage    = this.current instanceof ImageContent;
    var curIsPlayable = this.current instanceof PlayableContent ||
                        this.current instanceof GifContent;
    var newIsImage    = occupant instanceof ImageContent;

    this.future = occupant;
    this._syncLegacyGlobals();

    if (newIsImage) {
      if (curIsPlayable) {
        // media→image: keep media playing until mainImageEl 'load' fires and
        // calls commitFuture(), which calls current.surrender() to stop media.
      } else if (this.current) {
        // image→image: cancel any pending preload for the old occupant.
        this.current.surrender();
      }
      // null→image: nothing extra needed.
    } else {
      // New content is playable (audio / video / gif).
      if (!curIsImage) {
        // media→media or null→media: stop whatever is current under a cover.
        _startTransitionCover();
        if (this.current) this.current.surrender();
        mainImageEl.src = '';
        imagePaneEl.classList.remove('image-loaded');
      }
      // image→media (curIsImage): deferred — old image stays visible; the media
      // element loads invisibly and _onMediaLoadedMetadata does the atomic swap.
    }

    occupant.load(this);
    return true;
  }

  // ── Commit / abort ──────────────────────────────────────────────────────────

  // Called from event handlers once loading has finished and the future occupant
  // should become current.  Silently ignored if occupant is no longer the future
  // (superseded by a later navigation).
  commitFuture(occupant) {
    if (occupant !== this.future) return;
    if (this.current && this.current !== occupant) {
      // media→image path: current is still the playing media.  The 'load'
      // handler stops it via surrender() before calling here; current is nulled.
      // Nothing else to do — current.surrender() already ran.
    }
    this.current = occupant;
    this.future  = null;
    this._syncLegacyGlobals();
  }

  // Drop the future occupant without committing (e.g. load error, superseded).
  abortFuture(occupant) {
    if (occupant === this.future) {
      this.future = null;
      this._syncLegacyGlobals();
    }
  }

  // ── Gif redirect ────────────────────────────────────────────────────────────
  //
  // Swap the future VideoContent for a GifContent covering the same file.
  // Called from _onMediaLoadedMetadata when a gif-loop is detected.
  // The 'video:' name prefix is shared between VideoContent and GifContent,
  // so deduplication remains correct after the reclassification.
  redirect(gifOccupant) {
    if (this.future instanceof VideoContent) {
      this.future = gifOccupant;
      // fullPath and isQueueContent are unchanged; no need to resync.
    }
  }

  // ── Legacy global sync ──────────────────────────────────────────────────────
  //
  // Keep _contentPath and _isQueueContent in sync for the event handlers in
  // viewer-media-playable.js that still read them directly.
  _syncLegacyGlobals() {
    _contentPath    = this.fullPath;
    _isQueueContent = this.isQueueContent;
  }

  // ── Clear ───────────────────────────────────────────────────────────────────

  _clearToEmpty() {
    if (this.future)  { this.future.surrender();  this.future  = null; }
    _startTransitionCover();
    if (this.current) { this.current.surrender(); this.current = null; }
    mainImageEl.src = '';
    imagePaneEl.classList.remove('image-loaded');
    _contentPath    = null;
    _isQueueContent = false;
    _endTransitionCover();
  }
}

var content = new ContentPane();
