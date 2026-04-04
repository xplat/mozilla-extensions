viewer-content.js load()'s error handler calls content.load() on the module-level singleton global rather than this.load(), creating an unexpected dependency on the outer variable name.
