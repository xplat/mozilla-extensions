# loaddir-race — Closed: Not a Race

**Status:** ✅ Closed (investigated, no fix needed)

The original concern — that sort/filter state might not be ready when `loadDir` begins acting on it — does not hold up on inspection:

- The synchronous preamble of `loadDir` covers the UI with a loading state before any async work begins.  By the time the async continuation runs (where sort/filter state is actually needed), state.js will have resolved.
- Adding `await` at the two call sites (`init()` and the popstate handler) is structurally impossible: both callers are non-async callbacks that cannot propagate `await`.

The missing `await` is therefore not actionable and not a correctness issue.  The ordering guarantee can be noted in a comment in the code if desired, but does not require a tracked fix.
