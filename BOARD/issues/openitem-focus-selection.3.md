Implement focus-loss hooks so that transitioning away from list focus automatically triggers `selectItem(-1)` (or equivalent deselection). This would allow `openItem` to simply call `setFocusMode('viewer')` and let the hook handle deselection, removing the explicit coupling.

Until hooks exist, at minimum document the intended sequencing with a comment.
