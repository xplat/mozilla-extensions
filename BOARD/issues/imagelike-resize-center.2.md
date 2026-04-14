`viewer-media-imagelike.js`, `ImagelikeContent.load()`, the `ResizeObserver` callback (roughly lines 90–100 of the ImagelikeContent section):

```js
this._resizeObserver = new ResizeObserver(() => {
  const newWidth  = imagePaneEl.clientWidth;
  const newHeight = imagePaneEl.clientHeight;
  const dW = prevWidth  - newWidth;
  const dH = prevHeight - newHeight;
  scrollImage(imagePaneEl, dW / 2, dH / 2);   // ← incremental delta, truncated each time
  prevWidth  = newWidth;
  prevHeight = newHeight;
  self._transform.applyTransform();
});
```

Each callback computes an incremental delta and passes half of it to `scrollImage()`.  `scrollImage` (or the browser's own scroll assignment) rounds to integer pixels.  With many rapid callbacks during a drag-resize, the sub-pixel remainder is silently dropped each time, so the center wanders.  Additionally, `applyTransform()` is called *after* the scroll adjustment, which may change `scrollWidth`/`scrollHeight` and further invalidate the position.
