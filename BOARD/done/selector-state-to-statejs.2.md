In viewer-selector.js:
- Lines 84–85, 94: reads `ui.sortBy` and `ui.showHidden` in `#sortItems` / `#filterItems`
- Line 142: mutates `ui.recursive` in `toggleRecursive`
- Line 149: mutates `ui.showHidden` in `toggleHidden`
- Line 157: mutates `ui.sortBy` in `cycleSortBy`

`ui` object defined in viewer-ui.js lines 52–67. The three properties (`recursive`, `showHidden`, `sortBy`) are plain mutable fields with no persistence. The toggle buttons that call these methods are currently in the DOM but their event-handler wiring location is unknown — needs verification.

Also related: `ui.queueMode` has the same problem but is tracked separately (queuemode-persistence).
