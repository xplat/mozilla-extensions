In viewer-list.js, four globals are used without documented sources (lines 77, 221, 266, 280):
- `setFocusMode` — used as a callback; defined in viewer-ui.js
- `mediaType` — currently in viewer.js (pos 18)
- `toProxyThumb` — currently in viewer.js (pos 18)
- `fmtSize` — currently in viewer.js (pos 18)

viewer-list.js is pos 4; viewer.js is pos 18 — these are safe as runtime callbacks but conceptually misplaced. All three non-focus functions operate on file metadata and naturally belong with the list.
