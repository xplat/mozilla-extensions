In viewer.js:
- Line ~178: `selector.loadDir(...)` called without `await` in `init()`
- Line ~278: `selector.loadDir(...)` called without `await` in the popstate handler

The concern is ordering: `applyUiState()` or history-state application may run before the directory load resolves. The audit notes the race "goes the other way" — sort order state (from state.js) should resolve *before* loadDir starts sorting, so it would be bad if loadDir had to redo work.

See viewer-selector.js for `loadDir` implementation.
