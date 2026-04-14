Decide ownership:
- Option A: Move `audioEl` and `audioPlaceholderEl` to viewer-media-audio.js as private globals (they are only used by AudioContent).
- Option B: Move to viewer-content.js as shared resources alongside imagePaneEl (but see imagepane-migration — that move is already deferred).

Option A is simpler and more self-contained. Update all references after moving.
