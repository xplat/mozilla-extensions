## GifContent: injection gap resolution

GifContent does not extend PlayableContent and should not.  The globals it currently accesses
from viewer-media-playable.js are handled as follows:

- `_pendingAutoFS`: VideoContent resolves/clears this before handing off to GifContent — it
  does not apply to gif-like content, so Video cleans up after itself.
- `_stopActiveMedia`: not needed by GifContent — gif-like content has no audio, no HUD
  attachment, and lacks the usual event handlers that _stopActiveMedia is designed to tear down.
- `_pendingQueuePlay`: not relevant — queued videos must never gifify (see below), so this
  flag is never set in a context where GifContent would be created.
- `videoEl` and `_startTransitionCover`: deferred.  These should be owned by the content pane
  but cannot move there yet due to load order.  Leave as module globals for now.

Net result: GifContent's dependencies on viewer-media-playable.js globals are eliminated
without any injection plumbing, by moving cleanup responsibility to VideoContent pre-handoff.

## QueuedVideoContent: behaviours to suppress

- **No gifification**: the queue exists to watch videos; gifification would loop forever and
  stall queue progression.  QueuedVideoContent must not enter the gif path.
- **No self-fullscreen**: the queue is a curated experience — the viewer either wants fullscreen
  for the whole session or is suppressing it deliberately.  Auto-fullscreen should not fire.

Both of these are VideoContent behaviours that QueuedVideoContent must not inherit, which is
part of why QueuedVideoContent should not descend from VideoContent.

## Revised hierarchy

    VideoContentBase  (new shared base — common video element setup, playback, event wiring)
    ├── VideoContent          adds: gifification path, self-fullscreen
    └── QueuedVideoContent    adds: queue advancement; omits gif path and auto-fullscreen

Use class-attached event handlers in the base and subclasses rather than global ones.  This
interacts with self-cleaning-event-handlers, which provides a load-context mechanism for
shared-DOM handlers.

## Remaining open question

Where does VideoContentBase live?  Options:
- New file (viewer-media-video-base.js or similar).
- Absorbed into viewer-media-video.js alongside VideoContent.
- Absorbed into viewer-media-playable.js (if it belongs conceptually with PlayableContent).
