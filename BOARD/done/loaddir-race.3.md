Ensure sort/filter state from state.js is fully initialized before `loadDir` begins acting on it. Options:
- `await` the loadDir call and verify nothing between the call and the await causes a problem
- Have loadDir internally wait on state initialization before proceeding
- Document the current ordering guarantee if one already exists and it is sufficient

Related: the entire popstate else-branch may be an encapsulation violation (see popstate-encapsulation issue) — resolving that may change the shape of this fix.
