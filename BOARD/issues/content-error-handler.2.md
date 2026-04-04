viewer-content.js `load()`, around line 77. The error handler inside `load()` calls `content.load(…)` where `content` is the module-level singleton, rather than `this.load(…)`.

This creates an implicit dependency on the outer variable name and conflates the instance method with the singleton. Since `content` is in practice a singleton, this may never actually cause a bug — but it is misleading and fragile if the singleton assumption ever changes.
