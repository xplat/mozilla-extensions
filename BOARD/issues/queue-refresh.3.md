## Schema changes

Split each queue into two localStorage keys:

    media-audio-queue        { csn: <uint>, index, time }   — no items
    media-audio-queue-items  [ {u, p, …}, … ]
    media-video-queue        { csn: <uint>, index, time }
    media-video-queue-items  [ {u, p, …}, … ]

CSN starts at 0 and increments (wrapping at a safe integer limit) whenever `items` changes
(add, remove, reorder).  Index/time changes do not increment it.

## background.js (cross-tab owner)

- Maintain `_aq.csn` / `_vq.csn` in memory; increment on list mutations.
- On any list write, write the items key first, then the main key (so a reader that sees a new
  CSN can always find fresh items already in place).
- Include `csn` in all queue-change broadcasts alongside the other fields.
- `_aq` / `_vq` internal objects grow a `csn` field; init to 0.

## popup.js

- Cache the last-seen CSN per queue alongside the item list it rendered.
- On broadcast or poll: if received CSN ≠ cached CSN, reload items from
  `media-{audio,video}-queue-items`, rerender, update cached CSN.
- If CSNs match, only update index/time and skip rerender.

## viewer-queue-mgt.js

Same pattern as popup.js.  Additionally:
- On CSN change, invalidate any index-based selection state before rerendering.
- On CSN match, update position indicator only.

## Migration / compatibility

Old readers that don't know about the items key will silently get an empty `items` array (key
absent → undefined → fallback).  background.js should write the items key on startup even if
nothing changed, so the split keys are always present once the new code runs.
