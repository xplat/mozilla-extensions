## Interface addition to LoadContext (viewer-load-context.js)

Add two methods mirroring the DOM API:

    ctx.addEventListener(target, type, handler, options)
    ctx.removeEventListener(target, type, handler)

Internally LoadContext maintains a list of `{ target, type, handler, options }` records.
`addEventListener` appends a record and calls `target.addEventListener(type, handler, options)`.
`removeEventListener` finds the record, removes it, and calls the corresponding DOM removal.

## Lifecycle integration

At the end of both `surrender` and `cleanup` (whichever fires), LoadContext iterates its
remaining records and removes every handler that wasn't explicitly removed by the content
object.  The list is then cleared.

Because load context is already passed at `.load()` and serves as the activation token for
content pane methods, no new plumbing is required — content objects already have `ctx` in scope.

## Adoption scope

Only content objects that share DOM resources (primarily PlayableContent subclasses sharing
`videoEl`, and any content that attaches to the HUD or transition cover) are required to
migrate to `ctx.addEventListener`.  Content objects that own their DOM outright can continue
using direct calls, since their elements are destroyed at cleanup anyway.

## Testing note

The auto-removal can be verified by a unit test on LoadContext alone: attach a mock handler,
call the surrender/cleanup hook, assert the handler was removed without the content object
doing it explicitly.
