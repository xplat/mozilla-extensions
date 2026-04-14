Elements currently in viewer-ui.js that logically belong in viewer-content.js:
- `imagePaneEl` — the main content display pane; already referenced by imagelike drag handlers and playable click handler (set up at runtime, so no current load-order crash)
- `_startTransitionCover` / `_endTransitionCover` — transition overlay functions
- `imgSpinnerEl` — loading spinner element
- `videoEl` — possibly; needs verification of all its uses

viewer-content.js is pos 17; viewer-media-imagelike.js is pos 10, viewer-media-playable.js is pos 13. Moving these elements to content.js would mean they are not available at load time for earlier scripts — only runtime (callback/method body) access would be safe.
