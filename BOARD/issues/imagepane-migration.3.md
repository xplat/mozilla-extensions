Requires a load order change in viewer.html: viewer-content.js must move earlier in the script list, before viewer-media-imagelike.js (currently pos 10). Audit all top-level uses of the migrated globals in earlier-loading files to confirm none are load-time references (only runtime/callback uses are safe).

Plan this carefully before touching — it is a cross-cutting change that will affect multiple files and the HTML load order simultaneously.
