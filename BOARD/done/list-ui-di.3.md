Defer until the `ui` persistent-state object is sufficiently cleaned up. Then:
1. Identify which `ui` methods/properties viewer-list.js actually needs (starting with `setFocusMode`).
2. Add `this.#ui.setFocusMode(…)` calls in place of bare `setFocusMode(…)` calls.
3. At that point `#ui` is no longer dead code and this issue is closed.
