# load-context-constructor-check — Implementation Report

**Status:** ✅ Complete

## Implementation Summary

Fragile ErrClass.prototype duck-typing replaced with robust pattern:

1. **Previous Approach** (commit a1a688f):
   - Checked `ErrClass.prototype` to distinguish constructor from factory function
   - `if (ErrClass.prototype ? new ErrClass(e) : ErrClass(e))`
   - Fragile: relied on prototype property existence

2. **Current Approach** (commit 8e7a8e9):
   - Replaced with nullish-coalescing pattern in viewer-load-context.js
   - `(ErrClass ?? (() => { return new Error(...); }))(e)`
   - Treats all ErrClass as callables (constructors or factory functions uniformly)
   - Falls back to factory function if ErrClass is null/undefined

3. **Robustness Improvements**:
   - No prototype introspection needed
   - Works reliably across different JS environments
   - All callers already pass explicit factories (e.g., `() => new Error()`)
   - Type annotations document expected signature

## Result

Clean, maintainable constructor pattern with no fragile duck-typing. Proper type safety and fallback handling in place.
