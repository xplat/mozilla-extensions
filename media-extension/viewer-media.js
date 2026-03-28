'use strict';
// ── viewer-media.js ───────────────────────────────────────────────────────────
//
// Content-occupant class hierarchy.  Each media item is an ES6 class instance
// that knows its own full path, how to load itself into the content pane, and
// how to surrender the pane when replaced.
//
// Declares these globals used by other modules:
//   ContentOccupant, ImageContent, GifContent,
//   PlayableContent, AudioContent, VideoContent, QueuedVideoContent,
//   makeContentOccupant.
//
// Calls into globals defined in earlier / later modules:
//   _imgPendingLoad,                                      (viewer-media-image.js)
//   showImage,                                            (viewer-media-image.js)
//   _stopActiveMedia,                                     (viewer-media-playable.js)
//   showMedia, mediaType.                                 (viewer.js)

// ── Base class ────────────────────────────────────────────────────────────────

class ContentOccupant {
  constructor(fullPath) {
    this.fullPath = fullPath;
    this._name    = null;  // set by each concrete subclass
  }

  get name()     { return this._name; }
  get filename() { return this.fullPath.replace(/.*\//, ''); }

  // Called by ContentPane.load() to start the actual content load.
  // pane: the ContentPane instance loading this occupant.
  load(pane) {}

  // Called when this occupant is being replaced or cancelled mid-load.
  // Should abort any in-flight loads and release resources.
  surrender() {}
}

// ── Image ─────────────────────────────────────────────────────────────────────

class ImageContent extends ContentOccupant {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'image:' + fullPath;
  }

  load(pane) {
    showImage(this.filename);
  }

  surrender() {
    // Cancel any in-flight off-screen preload started by showImage().
    if (_imgPendingLoad) {
      _imgPendingLoad.onload = _imgPendingLoad.onerror = null;
      _imgPendingLoad.src    = '';
      _imgPendingLoad        = null;
    }
  }
}

// ── Gif-loop ──────────────────────────────────────────────────────────────────
//
// A short looping video with no audio track, treated as a static image.
// GifContent shares the 'video:' name prefix with VideoContent so that
// gif↔video reclassification (via ContentPane.redirect()) is transparent to
// the deduplication check — the same file won't be reloaded.

class GifContent extends ContentOccupant {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  // GifContent is never loaded directly: VideoContent starts the <video> load,
  // then _onMediaLoadedMetadata calls ContentPane.redirect() to swap the occupant
  // to a GifContent once the gif-loop is detected.
  load(pane) {}

  surrender() { _stopActiveMedia(); }
}

// ── Playable (audio + video) ──────────────────────────────────────────────────

class PlayableContent extends ContentOccupant {
  surrender() { _stopActiveMedia(); }
}

class AudioContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'audio:' + fullPath;
  }

  load(pane) {
    showMedia(this.filename, 'audio', pane._isDeferred());
  }
}

class VideoContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'video:' + fullPath;
  }

  load(pane) {
    showMedia(this.filename, 'video', pane._isDeferred());
  }
}

// ── Queued video ──────────────────────────────────────────────────────────────
//
// A video loaded from the video queue.  The name includes the queue index so
// that the same file appearing multiple times in a queue is treated as distinct
// items rather than deduplication no-ops.

class QueuedVideoContent extends VideoContent {
  constructor(fullPath, queueIndex) {
    super(fullPath);
    this.queueIndex = queueIndex;
    this._name = 'qvideo:' + queueIndex + ':' + fullPath;
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
