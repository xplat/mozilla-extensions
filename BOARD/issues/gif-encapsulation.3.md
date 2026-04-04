Flagged in audit as requiring a complete refactor of how autoplay and auto-fullscreen work, and a rearrangement of the video class hierarchy. Needs online design discussion before implementation.

Key questions:
- Should GifContent extend PlayableContent (or a common base)?
- Should `_pendingAutoFS` / `_pendingQueuePlay` move into a shared base or be passed as parameters?
- How does the transition cover get invoked cleanly without direct global access?
