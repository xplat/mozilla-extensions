Move `mediaType`, `toProxyThumb`, and `fmtSize` from viewer.js into viewer-list.js (or a shared utility file if other scripts use them — verify with grep first).

For `setFocusMode`: this is the kind of dependency that should be injected via the `#ui` field (see list-ui-di issue). Once the `ui` persistent-state object is retired and `#ui` DI is wired up, `setFocusMode` can be accessed through that channel instead of as a bare global.
