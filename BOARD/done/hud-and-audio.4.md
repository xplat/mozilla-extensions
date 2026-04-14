# hud-and-audio — Implementation Report

**Status:** ✅ Complete

## Implementation Summary

Audio and HUD concerns cleanly separated with proper visible/audible split:

1. **Audio Separation** (viewer-audio.js):
   - Clean module handling cross-tab audio baton, A/V control helpers
   - No HUD display concerns
   - Exports pure control functions (mute, volume, balance, play/pause)
   - Event watchers (avSettingsWatcher) for settings changes
   - All forward-references safe (inside event handlers)

2. **HUD Concerns** (viewer-media-playable.js):
   - Controls display: `videoControlsEl`, `videoProgressEl`, `videoSeekFillEl`, `videoTimeEl`, `videoVolEl`
   - HUD update logic: `fmtTime()`, `_updateVideoControls()`, `toggleHudPin()`
   - Progress bar interaction (click-to-seek)
   - Integrates with A/V settings via avSettingsWatcher subscription

3. **Visible vs. Audible Split**:
   - **Visible** (HUD display): Owned by viewer-media-playable.js
   - **Audible** (audio control): Owned by viewer-audio.js
   - Clear separation: audio.js doesn't manipulate HUD, playable.js doesn't own audio state

4. **Audit Assessment**:
   - Audio module marked "Good" with clear role separation
   - activeMediaEl role properly understood in both contexts
   - No entanglement or conflated concerns

## Result

Audio and HUD properly separated. Visible concerns in playable module, audible concerns in audio module. Clean role boundaries with no hidden dependencies.
