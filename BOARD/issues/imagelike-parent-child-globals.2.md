In viewer-media-imagelike.js, `ImagelikeContent.handleKey` calls three functions defined in viewer-media-image.js (the child file, pos 11 vs parent pos 10):
- `scrollImage()` — scrolls the image pane by a fixed step
- `scaleTo1()` — resets image scale to 1:1
- `toggleZoom()` — toggles between fit and 1:1 zoom

These are safe at runtime (event handlers fire after all scripts load) but represent an inverted dependency that will become a hard circular-import blocker when either file is converted to a module.

Grep: `scrollImage\|scaleTo1\|toggleZoom` in viewer-media-imagelike.js and viewer-media-image.js.
