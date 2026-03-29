'use strict';
// ── viewer-media-audio.js ─────────────────────────────────────────────────────
//
// AudioContent: plays audio files using the dedicated <audio> element and
// shows the placeholder element as the visual occupant.
//
// Declares these globals used by other modules:
//   AudioContent.
//
// Calls into globals defined in earlier / later modules:
//   PlayableContent, audioEl, audioPlaceholderEl.          (viewer-media-playable.js)

class AudioContent extends PlayableContent {
  constructor(fullPath) {
    super(fullPath);
    this._name = 'audio:' + fullPath;
  }

  get mediaEl()   { return audioEl; }
  get element()   { return audioPlaceholderEl; }
  get paneClass() { return 'media-audio'; }

  clone() { return new AudioContent(this.fullPath); }
}
