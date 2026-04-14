The guard cannot be removed — both factories and constructors are valid callers. Options for making it more robust:

- **try/catch**: wrap `new ErrClass(e)` in a try/catch; if it throws (e.g. called without `new` on a class), fall back to `ErrClass(e)`. Reliable but has overhead on the error path.
- **Convention**: require callers to wrap factories in a thin adapter or pass an explicit `{factory: fn}` / `{ctor: Cls}` tagged object — makes intent unambiguous at call sites.
- **Document and leave**: add a comment enumerating the known-safe caller forms (regular functions, arrow functions, classes) and note the bound-function limitation. Acceptable if bound functions are never used here in practice.
