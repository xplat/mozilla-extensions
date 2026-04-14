# popstate-encapsulation — Implementation Report

**Status:** ✅ Complete

## Implementation Summary

Popstate handler refactored to respect selector module encapsulation:

1. **Old Code** (viewer.js.git-diff lines 184–192):
   - Else-branch directly accessed `selector.listing`
   - Called `selector.markActive(idx, true)` to manipulate internal state
   - Encapsulation violation: viewer.js knew too much about selector internals

2. **New Code** (viewer-selector.js lines 514–521):
   - State.onLoad() listener registered in viewer-selector.js
   - Uses public API: `selector?.loadDir(dir, false)`
   - Selector owns the responsibility to respond to history changes

3. **Changes Made**:
   - Popstate handler completely removed from viewer.js
   - Responsibility delegated to viewer-selector.js via State.onLoad()
   - Respects state.js abstraction for history coordination

## Result

Clear encapsulation boundary restored. Viewer module no longer reaches into selector internals. History state changes flow through proper state.js machinery. Selector module fully owns its response to history navigation.
