The queue localStorage layout should be split so queue content (the list of items) lives in its own
key, separate from the main queue state object.  Each queue (audio and video) gets a Change Sequence
Number (CSN) that increments whenever the item list itself changes (additions, removals, reordering)
but not on position-only updates (current index, playback state).

The CSN is stored in two places:
- The main queue state object (already polled / read by anyone who needs the full state).
- Every queue-change broadcast on the channel.

Any recipient — whether woken by a broadcast or by polling — compares the received CSN against its
cached CSN.  If they differ, the item list is stale and the recipient reloads it from the content key,
rerenders, and invalidates any index-based selection.  If CSNs match, only position/state fields need
updating, and a full rerender can be skipped.

This removes the need to rebuild the rendered queue on every event and makes the "did the list change?"
question answerable in O(1) without inspecting item arrays.
