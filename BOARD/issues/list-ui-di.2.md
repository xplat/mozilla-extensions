viewer-list.js constructor (line ~32): `#ui` is assigned from the constructor parameter but never subsequently read anywhere in the class. It was presumably added in anticipation of dependency injection but no uses were ever added.

The `ui` object in viewer-ui.js currently mixes persisted state, non-persisted state, and utility methods. Once those are cleaned up (see selector-state-to-statejs, queuemode-persistence), `#ui` can be put to use for injecting things like `setFocusMode`.
