1. Reserve three state.js slots (Boolean or Enum as appropriate) for `recursive`, `showHidden`, `sortBy` — owned by viewer-selector.js.
2. Move toggle button event-handler wiring into viewer-selector.js.
3. Replace all `ui.recursive` / `ui.showHidden` / `ui.sortBy` reads and writes with the state.js interface.
4. Remove the three properties from the `ui` object in viewer-ui.js.

The buttons and their handlers should live in viewer-selector.js alongside the state they control.
