viewer-queue-mgt.js, `_onQueueStateUpdate`, around line ~126. The function signature includes a `prev` parameter that is never referenced in the function body. The audit suggests it may have been needed before the queue became a FileList with its own concept of "active item" separate from queue state.

Grep: `_onQueueStateUpdate` in viewer-queue-mgt.js; check call sites to see what argument is passed as `prev`.
