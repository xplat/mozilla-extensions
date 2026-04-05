This is probably best addressed by a rearrangement of the video hierarchy's inheritance relationships so that VideoContent (viewer-media-video.js) and QueuedVideoContent (viewer-media-queued-video.js) both descend from a common base class instead of the latter descending from the former, and using class-attached event handlers in place of global ones.

This issue subsumes gif-encapsulation.  GifContent (viewer-media-gif.js, ~lines 17–46) directly
accesses globals declared in viewer-media-playable.js:
- `videoEl` — the shared video element
- `_pendingAutoFS` — auto-fullscreen flag
- `_pendingQueuePlay` — auto-queue-play flag
- `_startTransitionCover` — transition cover function
- `_stopActiveMedia` — stop function

GifContent is not in the PlayableContent class hierarchy despite this tight coupling.  The audit noted
this implies gif is a specialisation of playable, and the hierarchy refactor is the right moment to
formalise that.
