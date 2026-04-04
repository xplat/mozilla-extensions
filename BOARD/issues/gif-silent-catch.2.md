viewer-media-gif.js line ~34, inside `load()`:
```js
.catch(function() {})
```
This swallows any autoplay rejection silently. The user sees nothing; the media element is in an unknown state. There is no way to retry playback without reloading.

ErrorContent is the existing mechanism for displaying load/play failures in the viewer pane.
