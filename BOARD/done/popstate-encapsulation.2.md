In viewer.js, the popstate handler (around line ~278) has an else-branch that calls `selector.setFromHistory()`. The audit notes the entire else-branch is an encapsulation violation — viewer.js should not be managing selector internal state in response to popstate.

Also: `selector.setFromHistory()` is called in both branches of a conditional (lines ~177, ~180), which could be hoisted — but the real fix is moving this logic out of viewer.js entirely.

Related to loaddir-race: the shape of this fix may affect how/whether loadDir needs to be awaited.
