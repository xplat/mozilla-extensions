# Media Extension viewer*.js — Code Quality Audit Summary

## Script load order (for reference)
```
1. state.js (module)
2. media-shared.js
3. viewer-ui.js
4. viewer-list.js
5. viewer-selector.js
6. viewer-audio.js
7. viewer-queue-mgt.js
8. viewer-load-context.js
9. viewer-media.js
10. viewer-media-imagelike.js
11. viewer-media-image.js
12. viewer-media-gif.js
13. viewer-media-playable.js
14. viewer-media-audio.js
15. viewer-media-video.js
16. viewer-media-queued-video.js
17. viewer-content.js
18. viewer.js
```

---

## CRITICAL BUGS

### viewer-list.js — `markActive` (lines 306–315) ✓ FIXED
- **Line 314 [syntax error]:** String literal `{ block: "center }` had a mismatched quote — closing `"` was missing. Fixed to `{ block: 'center' }`.

### viewer-list.js — `needsScroll` (lines 286–291) ✓ FIXED
- **Line 287 [bug]:** Method was declared `static needsScroll(item)` but accessed `this.#container`. Fixed by removing `static` (making it an instance method) and updating both call sites from `FileList.needsScroll(el)` to `this.needsScroll(el)`.

### viewer-media-image.js — static `import` in a classic script (line 22) ✓ FIXED
- **[syntax error, missed by inquisitors]:** `import { … } from './state.js'` is a syntax error in a classic script. Fixed by replacing with a dynamic `import('./state.js').then(…)`: the six state-slot `let` variables and `save` are declared at script top level and assigned inside the `.then()` callback; functions and the `ImageContent` class remain at top level and close over those bindings.

---

## ENCAPSULATION / ABSTRACTION VIOLATIONS

### viewer-content.js — `load` (lines ~77, ~94)
- **Line 94 [encapsulation]:** Accesses `ctx._cancelled` directly on a `LoadContext` instance. `LoadContext` should expose a public `isCancelled()` predicate instead of leaking a private field.
- **Line 77 [abstraction]:** Error handler inside `load()` calls `content.load(…)` on the module-level global instead of `this.load(…)`. Conflates the instance method with the global, and creates an unexpected dependency on the outer variable.

### viewer-media-gif.js — entire class (lines ~17–46)
- **[encapsulation]:** `GifContent` (pos 12) directly reads and writes `videoEl`, `_pendingAutoFS`, `_pendingQueuePlay`, `_startTransitionCover`, and `_stopActiveMedia` — all globals that logically belong to `viewer-media-playable.js` (pos 13). The class is reaching into a later file's internals. The dependency structure implies gif is a specialization of playable, but it is not in the class hierarchy; the coupling is purely through shared globals.
  - Note: the inquisitor incorrectly flagged these as load-time ReferenceErrors. They are inside method bodies executed at runtime (after all scripts have loaded). The real issue is the encapsulation violation.

### viewer-media-audio.js — `mediaEl`, `element` getters (lines 19–20)
- **[encapsulation]:** `AudioContent` exposes `audioEl` and `audioPlaceholderEl` via getters, but these are globals declared in `viewer-media-playable.js`. Whether they are intended as public interface or internal state of playable needs clarification; if internal, both the exposure and the usage are violations.

### viewer-selector.js — `loadDir` (lines 116–120)
- **[encapsulation]:** Directly manipulates `this.listing` (internal `FileList` state) rather than going through a method. Acceptable for a subclass, but undocumented.

---

## OUTDATED `ui.*` STATE VARIABLES

### viewer-selector.js
- **Lines 142, 149, 157 [outdated state]:** Directly mutates `ui.recursive`, `ui.showHidden`, and `ui.sortBy` in `toggleRecursive`, `toggleHidden`, and `cycleSortBy`. These should be stored in `state.js`.
- **Lines 84–85, 94 [outdated state]:** Reads `ui.sortBy` and `ui.showHidden` in `#sortItems` / `#filterItems`.

### viewer-ui.js — `ui` object (lines 52–67)
- **Line 66 [cross-cutting concern]:** `ui.queueMode` is documented "NOT persisted (resets on page load)" but lives in the same `ui` object as persisted state. Dual semantics in one object.

---

### viewer-media-imagelike.js → viewer-media-image.js (parent depends on child's globals)
- **[architectural debt]:** `viewer-media-imagelike.js` (pos 10) defines `ImagelikeContent`, the parent
  class of `ImageContent`. Its `handleKey` method calls `scrollImage()`, `scaleTo1()`, and
  `toggleZoom()` — functions defined in `viewer-media-image.js` (pos 11), the file that contains
  the child class. The parent's implementation depends on globals from the child's file. This is an
  inversion of the normal dependency direction and will become a hard blocker when either file is
  converted to a module, since modules cannot circularly import each other. Resolution requires either
  moving those functions up into imagelike or restructuring the class hierarchy.

## CROSS-CUTTING CONCERNS

### `activeMediaEl` — viewer-ui.js (lines 257, 306–307)
The name `activeMediaEl` appears in `viewer-ui.js`'s mouse drag handler and keydown dispatcher, `viewer-audio.js`'s media-channel message handler, and `viewer-media-playable.js`. Its role shifts across contexts: in the drag handler it is "the element whose time scrubber is being dragged"; in the audio system it is "the element currently holding the audio baton". These two meanings are not always the same element. This is exactly the cross-cutting concern flagged in the audit spec.

### viewer-selector.js — `openItem` (line 56 vs 62)
- **[cross-cutting]:** `openItem` calls `setFocusMode('viewer')` and then `showMediaFile()`, but also calls `this.selectItem(-1)` to deselect. The selection management and focus management are interleaved in one method without clear sequencing documentation.

---

## UNDECLARED / UNDOCUMENTED GLOBALS

### viewer-ui.js
- **Line 260, 262 [undeclared]:** Calls `playAndAnnounce(activeMediaEl)` and `_updateVideoControls()` in the mouse drag handler. `playAndAnnounce` is not listed in the file header and does not appear to be documented. (Same function is well-documented in `viewer-audio.js` where it is defined — the issue is the missing header entry in `viewer-ui.js`.)

### viewer.js
- **Lines 174, 271 [undeclared]:** `getUrlParams()` used in `init()` and the `popstate` handler with no documented source. Likely defined in `viewer-ui.js` — **verify**.
- **Line 262 [undeclared]:** `makeContentOccupant()` called in `showMediaFile()` with no documented source. Likely from `viewer-media.js` or `viewer-content.js` — **verify**.

### viewer-list.js
- **Lines 77, 221, 266, 280 [undeclared]:** `setFocusMode`, `mediaType`, `toProxyThumb`, `fmtSize` used without documented sources. `mediaType` and `toProxyThumb` are in `viewer.js`; `fmtSize` is likely in `media-shared.js`. All are safe (runtime callbacks) but none are in the file header.

### viewer-queue-mgt.js
- **Line 105 [undeclared + potential bug]:** Calls `_updateChannelWiring()`. This name is defined in `viewer-audio.js` (pos 6, earlier — OK), but the function at line 105 is inside `updateQueueChannelWiring` in queue-mgt — the inquisitor suspects this may be a typo or stale name from a refactor. **Verify the call target is correct.**
- **[false positive corrected]:** The inquisitor flagged `FileList` (used by `AudioQueueList` and `VideoQueueList`) as a forward-reference. It is not — `FileList` is defined in `viewer-list.js` (pos 4), which loads *before* `viewer-queue-mgt.js` (pos 7).

---

## FLAG-DRIVEN / SPLIT-PERSONALITY FUNCTIONS

*(These were missed by the inquisitors — caught on human review.)*

### viewer-ui.js — `'.'` key case in keydown dispatcher (lines ~302–312)
Depending on focus state / a flag, `'.'` either advances a video frame or toggles a selector mode. Two conceptually unrelated actions behind one key case — should be two dispatches.

### viewer-ui.js — global mouse handlers (lines 213–279)
The `mousemove` / `mouseup` handlers manage internal state of at least three other files (scrubber position, audio element, video controls) and do semantically different things depending on what kind of drag is in progress. Determining whether a mouseup was a drag or a click is one thing; inlining the full logical handlers for both the drag outcome and the click outcome inside the same handler is a separate concern and should be extracted.

---

## OTHER CODE SMELLS

### viewer-media-imagelike.js — `handleKey` (lines 18–77)
- **Lines 22, 24, 37, 41 [magic numbers]:** Scroll step of `100` (pixels) and viewport fraction `0.9` appear without named constants.
- **Lines 29, 33, 37, 41 [abstraction]:** Direct imperative DOM writes to `imagePaneEl.scrollLeft`, `scrollTop`, etc. rather than going through a scroll-state abstraction.
- **Line 61 [potential bug]:** Missing `e.preventDefault()` on the 'b' key (prevItem navigation) while all other navigation keys call it.
- **[code smell]:** 10+ case branches; could benefit from decomposition into named helpers.

### viewer-media-image.js
- **Lines 112–125 [code smell]:** Snapshot capture in `applyImageTransform` uses many underscore-prefixed temporaries (`_snapIPX`, `_snapIPY`, etc.) making the function hard to follow. Extract to a named helper.
- **Lines 303, 309 [code smell]:** Two `for` loops in `scaleStep` both use `i` as the loop variable. Not a bug (function scope, but let-scoped so they're separate), but misleading; rename the second.
- **Lines 412–414 [code smell]:** Three key cases ('2', '3', '4') in `handleKey` repeat the same three-line zoom-level pattern. Could be data-driven.

### viewer-load-context.js — `waitFor` (line 53)
- **[fragile detection]:** `ErrClass.prototype ? … : …` to distinguish constructors from callables is unreliable for arrow functions, bound functions, and some classes. A more robust guard would use `try/catch` around `new ErrClass(e)` or require callers to always pass a constructor.

### viewer-queue-mgt.js — `_onQueueStateUpdate` (line ~126)
- **[dead parameter]:** `prev` parameter declared but never referenced in the body. Suggests an incomplete refactor.

### viewer-media-gif.js — `load` (line 34)
- **[silent failure]:** `.catch(function() {})` swallows autoplay rejections without logging. Legitimate playback failures become invisible.

### viewer.js — `init` / popstate handler
- **Lines 178, 278 [potential race]:** `selector.loadDir()` appears to be async but is not awaited. If `applyUiState()` or subsequent history state application executes before the directory load resolves, UI state may be applied against stale data.
- **Lines 177, 180 [duplication]:** `selector.setFromHistory()` is called in both branches of a conditional in the `popstate` handler; could be hoisted before the branch.
- **Lines 216–219 [asymmetric error handling]:** Try-catch blocks in media element wiring log warnings but continue; if one of two connections fails, the other proceeds silently.

### viewer-list.js — constructor (line 32)
- **[dead field]:** `#ui` is set from the constructor parameter but never subsequently read. Dead code.

---

## FILES WITH NO SIGNIFICANT ISSUES

- **viewer-audio.js** — Clean. All forward-references are safe (inside event handlers). Audio-baton role is clearly separated from `activeMediaEl`. Good.
- **viewer-media.js** — Clean. Forward-references to specialization classes (`ImageContent`, etc.) are safe (deferred instantiation). `activeMediaEl` does not appear here.
- **viewer-media-video.js** — Clean. Minimal and well-scoped.
- **viewer-media-queued-video.js** — Clean. Good use of queue state override pattern.
- **viewer-load-context.js** — Nearly clean; one fragile guard (see above).

---

## PRIORITY RANKING

| Priority | File | Issue |
|---|---|---|
| P0 ✓ | viewer-list.js:314 | Syntax error (unclosed string) — fixed |
| P0 ✓ | viewer-list.js:286-291 | `static needsScroll` crashes on call — fixed (instance method) |
| P0 ✓ | viewer-media-image.js:22 | `import` in classic script — fixed (dynamic import) |
| P1 | viewer-ui.js:213-279 | Mouse handlers conflate drag-detection with multi-file state management |
| P1 | viewer-ui.js:302-312 | `'.'` key case does two unrelated things based on focus flag |
| P1 | viewer-content.js:94 | `ctx._cancelled` — private field access |
| P1 | viewer-media-gif.js | Encapsulation violation on viewer-media-playable internals |
| P1 | viewer-selector.js:142,149,157 | Outdated `ui.*` mutations |
| P1 | viewer.js:278 | Un-awaited async `loadDir()` in init — potential race |
| P2 | viewer-ui.js | Many undocumented forward-references in keydown dispatcher |
| P2 | viewer-queue-mgt.js:105 | Suspect `_updateChannelWiring()` call — verify target |
| P2 | viewer-media-imagelike.js:61 | Missing `e.preventDefault()` on 'b' key |
| P3 | viewer-media-image.js | Snapshot naming, loop variable shadowing, duplicated zoom cases |
| P3 | viewer-media-gif.js:34 | Silent `.catch(function() {})` |
| P3 | viewer-load-context.js:53 | Fragile constructor detection |
| P3 | viewer-queue-mgt.js:126 | Dead `prev` parameter |
| P3 | viewer-list.js:32 | Dead `#ui` field |
| deferred | viewer-media-imagelike.js | Parent class calls globals defined in child's file — blocks module conversion |
