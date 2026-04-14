Move resize-centering responsibility into `viewer-transform.js` / `Transform`, replacing the current ad-hoc `prevWidth`/`prevHeight` delta approach in `ImagelikeContent`.

**Transform gains a pane snapshot** — `{ clientWidth, clientHeight, scrollLeft, scrollTop }` — updated by two new handlers that `Transform` supplies to `ImagelikeContent`:

- **scroll handler** — copies the full pane snapshot (`clientWidth`, `clientHeight`, `scrollLeft`, `scrollTop`) from the current pane state.  Attached to the pane's `scroll` event.  Updating pane size here is essential: it is sometimes the only path by which `clientWidth`/`clientHeight` get into the snapshot in time for the next resize event.
- updated by **`applyTransform()`** — after re-applying the transform, records the resulting scroll dimensions and position into the snapshot.  This is the authoritative update; it also clears the suppress-flag (see below).

**Resize handler** (also supplied by `Transform`, replacing the current `ResizeObserver` callback):

- *zoomFit ON, not currently animating/transforming* — do nothing; the image fills the pane by definition, centering is irrelevant.
- *zoomFit ON, currently animating/transforming* — call `applyTransform()` (which will re-fit and update the snapshot).
- *zoomFit OFF* — use the snapshot to compute where to scroll so that the same content pixel (recorded at last stable snapshot) stays centered in the new pane size:
  ```
  scrollLeft = snapshot.scrollLeft + (snapshot.clientWidth  - newClientWidth)  / 2
  scrollTop  = snapshot.scrollTop  + (snapshot.clientHeight - newClientHeight) / 2
  ```
  Set `suppressScrollUpdate = true` and record the target scroll value.  Do **not** update the snapshot.

**Suppress-flag logic** — in the scroll handler:

- If `suppressScrollUpdate` is set and `|currentScroll - targetScroll| < 3px` (both axes), skip the snapshot update.
- Once the scroll is ≥ 3 px away from `targetScroll` in either axis, clear the flag and resume normal snapshot updates.

This ensures the snapshot always reflects the last *user-chosen* center, never an intermediate rounding artifact from a smooth resize.

**Migration**: `ImagelikeContent.load()` must initialize the pane snapshot immediately after the pane is available (before any resize or scroll can fire), so the first resize event has valid dimensions to work from.

`ImagelikeContent` drops `prevWidth`, `prevHeight`, and the `scrollImage(…, dW/2, dH/2)` call from its `ResizeObserver` callback; replaces them with a call to `this._transform.onResize()` (or equivalent).  `Transform` wires the scroll listener via a new method called from `ImagelikeContent.load()`, and tears it down in `_detachListeners()`.
