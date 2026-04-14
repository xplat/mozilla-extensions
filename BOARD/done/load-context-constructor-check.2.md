viewer-load-context.js line ~53, inside `waitFor`. The guard `ErrClass.prototype ? … : …` is used to distinguish whether `ErrClass` is a constructor (class, called with `new`) or a factory (plain callable, called without `new`). Callers use both forms, so the guard is load-bearing.

The guard is unreliable in edge cases:
- Arrow functions have `prototype === undefined` (falsy) — treated as non-constructors, which is correct but accidental.
- Bound functions have no `prototype` — also accidental.
- Some transpiled classes may behave unexpectedly.
