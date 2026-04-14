The else-branch of viewer.js's popstate handler directly manipulates selector internals; this logic should live in viewer-selector.js, driven by a state.js onLoad handler.
