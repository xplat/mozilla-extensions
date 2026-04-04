In viewer-media-playable.js: `audioEl` and `audioPlaceholderEl` are declared as globals (exact lines TBD — grep for `audioEl`).

In viewer-media-audio.js lines 19–20: `AudioContent` exposes them via `mediaEl` and `element` getters, reading the playable-file globals.

These elements are used by the audio subsystem but housed in the playable file, which is a different conceptual layer.
