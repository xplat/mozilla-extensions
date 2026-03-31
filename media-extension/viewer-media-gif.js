'use strict';
// ── viewer-media-gif.js ───────────────────────────────────────────────────────
//
// GifContent: a short looping video with no audio track, treated as a static
// image.  Shares the 'video:' name prefix with VideoContent so that
// gif↔video reclassification via ContentPane.redirect() is transparent.
//
// Declares these globals used by other modules:
//   GifContent.
//
// Calls into globals defined in earlier / later modules:
//   ImagelikeContent.                                      (viewer-media-imagelike.js)
//   videoEl, _pendingAutoFS, _pendingQueuePlay,
//   _startTransitionCover, _stopActiveMedia.               (viewer-media-playable.js)

class GifContent extends ImagelikeContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  get element()   { return videoEl; }

  // GifContent is reached via redirect() from VideoContent.load(), which
  // has already set el.src.  This load() secures the element
  // (guarded against double-surrender by ContentPane._surrendered), sets up the
  // gif-specific playback state, and starts playback.
  async load(pane, ctx) {
    videoEl.loop  = true;
    videoEl.muted = true;
    await pane.request(this, ctx);
    _pendingAutoFS    = false;
    _pendingQueuePlay = false;
    videoEl.play().catch(function() {});
    // commitFuture() is called by ContentPane.load()'s .then() chain.
  }

  async surrender(element) {
    _startTransitionCover();
    _stopActiveMedia(videoEl);
  }

  cleanup() { _stopActiveMedia(videoEl); }

  clone() { return new GifContent(this.fullPath); }
}
