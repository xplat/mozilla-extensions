# Media Viewer

## Pending

- The media viewer should support playlists and background audio.  q should queue an item and select the next item (whether focused or in selector).  Q should cycle between normal view, audio queue, and video queue.  When you start the audio queue playing it should be played by the background script and if it pauses for a foreground play it should start back up when that's over.  The extension popup should display the status of the audio queue.  When nothing else of extended duration is an appropriate target, the global media keys should control the audio queue.  Also when you press 'q' on a directory, all the queueable items in the directory or in subdirectories named `(CD|Disc)\s*\d+` should be queued.  Files should also be queueable directly from the command line.

- Should autoplay run off the 'playable' event instead of the ones it runs off now?

- Separate from mute, there should be a per-tab SILENT mode that treats all video files as if they had no audio and refuses to play audio files (but will queue them).

- All active pure-audio playback should pause while mute is on.  This is a separate state from ordinary pausing and the audio should resume when mute ends unless it would have been paused at that point already (e.g. a video with sound started playing, or a tab playing a video with sound exited SILENT mode).

- Subtitle support.  Subtitles are probably a project as large as the rest of video support combined, so this is its own item.  The mplayer subtitle keys to implement are: j/J (cycle subtitle track forward/backward), x/z (delay ±0.1 s), and r/t (position up/down — these are safe to use in video-mode overrides since rotation does not apply to video).  External subtitle files (.srt, .vtt, .ass) should be auto-loaded if present alongside the video file with the same base name.  The `<track>` element covers .vtt natively; .srt and .ass will need conversion or a JS parser.

- ffmpeg fallback thumbnailer.  The platform thumbnailer (Tumbler/Caja/qlmanage) is the primary source of video thumbnails, but when it cannot produce one (unsupported format, headless environment, etc.) ffmpeg should be used as a fallback: `ffmpeg -ss <offset> -i <file> -vframes 1 -f image2 pipe:1`.  A sensible seek offset is 10 % of duration (requires a probe step) or a fixed 5 s.  This belongs in `media-native/thumbnailers/` alongside the existing backends.
