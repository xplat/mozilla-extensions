'use strict';
// ── viewer-media-queued-video.js ──────────────────────────────────────────────
//
// QueuedVideoContent: a VideoContent variant that reads its saved position from
// the video-queue state rather than the per-file localStorage entry, so that
// queue watching doesn't affect normal resume behaviour.  Also suppresses
// gif-loop detection (queue videos are always played as plain video).
//
// Declares these globals used by other modules:
//   QueuedVideoContent.
//
// Calls into globals defined in earlier / later modules:
//   VideoContent.                                          (viewer-media-video.js)
//   _qState.                                               (viewer-queue-mgt.js)

class QueuedVideoContent extends VideoContent {
  constructor(fullPath, queueIndex) {
    super(fullPath);
    this.queueIndex = queueIndex;
    this._name = 'qvideo:' + queueIndex + ':' + fullPath;
  }

  mutate() { return null; }

  get savedPosition() { return _qState.video.time || 0; }

  clone() { return new QueuedVideoContent(this.fullPath, this.queueIndex); }
}
