Move popstate-driven selector state restoration into viewer-selector.js by registering a state.js `onLoad` handler there. viewer.js should not need to know about selector's internal history-restoration logic.

This likely means:
1. viewer-selector.js registers an `onLoad` callback with state.js that calls `setFromHistory()` (or equivalent) when state is loaded/restored.
2. The else-branch in viewer.js's popstate handler is removed or reduced to a generic state reload trigger.
