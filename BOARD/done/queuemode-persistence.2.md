viewer-ui.js line ~66: `ui.queueMode` is documented "NOT persisted (resets on page load)" and lives in the `ui` object alongside other state. The audit notes this was always intended to be persisted — the non-persistence was an oversight.

`ui.queueMode` controls whether the queue panel is visible/active. It is toggled by user action and should survive navigation/reload like other UI state.
