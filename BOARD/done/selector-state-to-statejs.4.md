# selector-state-to-statejs — Implementation Report

**Status:** ✅ Complete

## Implementation Summary

Three mutable UI properties migrated from ui.js to state.js with full persistence:

1. **State Registration** (viewer-selector.js lines 33–35):
   - `hRecursive = State.reserve(State.Hidden, 'recursive', State.Boolean, false)`
   - `hShowHidden = State.reserve(State.Hidden, 'showHidden', State.Boolean, false)`
   - `hSortBy = State.reserve(State.Hidden, 'sortBy', State.Enum('name', 'mtime', 'size'), 'name')`

2. **Toggle Handlers** (viewer-selector.js lines 276–312):
   - `toggleRecursive()`, `toggleHidden()`, `cycleSortBy()` all call `hXxx.set()`/`hXxx.get()` and `State.save()`

3. **Button Event Wiring** (viewer-selector.js lines 525–527):
   - All three buttons now wired with click handlers in viewer-selector.js

4. **Cleanup** (viewer-ui.js):
   - Three properties completely removed from UIState class
   - File now reserves only: `hSelectorVisible`, `hThumbnails`, `hQueueMode`

## Result

Selector owns and persists its own filter state. UIState no longer entangled with selector concerns. Properties survive reload via localStorage.
