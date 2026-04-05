GifContent (viewer-media-gif.js, ~lines 17–46) directly accesses globals declared in viewer-media-playable.js:
- `videoEl` — the shared video element
- `_pendingAutoFS` — auto-fullscreen flag
- `_pendingQueuePlay` — auto-queue-play flag
- `_startTransitionCover` — transition cover function
- `_stopActiveMedia` — stop function

GifContent is not in the PlayableContent class hierarchy despite this tight coupling. The dependency runs from pos 12 (gif) into pos 13 (playable), but since all access is inside method bodies (not at load time) there is no load-order crash — the issue is purely architectural.

The audit noted this implies gif is a specialization of playable, but it is not reflected in the class hierarchy.
