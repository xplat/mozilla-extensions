viewer-selector.js `openItem`, around lines 56 and 62. The method calls `setFocusMode('viewer')` and `showMediaFile()`, but also calls `this.selectItem(-1)` to deselect the current item. Focus management and selection management are interleaved without clear sequencing or documentation.

The audit notes that if focus-loss hooks were implemented properly, losing list focus would trigger deselection automatically — making the explicit `selectItem(-1)` call unnecessary.
