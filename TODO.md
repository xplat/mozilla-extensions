# Media Viewer

## Done

- Audio files now have the progress bar always displayed, not just on hover.

- Image blanking/squishing on navigation is fixed: a preload + `visibility:hidden`
  swap keeps the old image visible until the new one is decoded; `applyImageTransform()`
  runs before the image is revealed, preventing squishing.  Image↔media mode
  transitions use a `#transition-cover` overlay (snaps opaque, fades out on reveal)
  so old content stays visible until new content is ready rather than going blank.

- When a file becomes selected it is now scrolled to the vertical center of the
  selector viewport (`scrollIntoView({ block: 'center' })`), giving better context
  around the selection and reducing scroll frequency.

- Volume, balance, and mute are now a single cross-tab setting: values are persisted
  in `localStorage` and broadcast on the `media-viewer` channel as `av-settings`
  messages.  Any tab adjusting A/V settings immediately syncs all other tabs.
  Volume uses perceptual (dB) steps of ±1.5 dB per keypress, displayed as dB,
  with a floor at −40 dB before snapping to silence.

- `p` now works globally: in image mode or the selector it asks whichever other
  tab is playing to toggle pause via a `pause-toggle` broadcast.  `9`/`0`/`(`/`)`/`m`
  are also truly global — they adjust the shared A/V settings and broadcast even
  when no local media is active.

- Color/quality adjustment keys for video: 1/2 (contrast), 3/4 (brightness),
  5/6 (hue-rotate), 7/8 (saturation) via CSS `filter:` on the video element.
  Filter resets to defaults when a new file is opened.

- In scroll mode, images smaller than the viewport are centred (via `margin:auto`
  on `#transform-host` inside a flex scroll container); images larger than the
  viewport scroll from the edge with no empty space.  On zoom, rotate, mirror,
  and flip the viewport centre is preserved by tracking the centre as a fraction
  of the display bounding box and restoring the scroll after the transform.
  (Exact for scale changes; visual-space approximation for rotations.)

## Pending

- The media viewer should support playlists and background audio.  q should queue an item and select the next item (whether focused or in selector).  Q should cycle between normal view, audio queue, and video queue.  When you start the audio queue playing it should be played by the background script and if it pauses for a foreground play it should start back up when that's over.  The extension popup should display the status of the audio queue.  When nothing else of extended duration is an appropriate target, the global media keys should control the audio queue.  Also when you press 'q' on a directory, all the queueable items in the directory or in subdirectories named `(CD|Disc)\s*\d+` should be queued.  Files should also be queueable directly from the command line.

- Separate from mute, there should be a per-tab SILENT mode that treats all video files as if they had no audio and refuses to play audio files (but will queue them).

- All active pure-audio playback should pause while mute is on.  This is a separate state from ordinary pausing and the audio should resume when mute ends unless it would have been paused at that point already (e.g. a video with sound started playing, or a tab playing a video with sound exited SILENT mode).

- Subtitle support.  Subtitles are probably a project as large as the rest of video support combined, so this is its own item.  The mplayer subtitle keys to implement are: j/J (cycle subtitle track forward/backward), x/z (delay ±0.1 s), and r/t (position up/down — these are safe to use in video-mode overrides since rotation does not apply to video).  External subtitle files (.srt, .vtt, .ass) should be auto-loaded if present alongside the video file with the same base name.  The `<track>` element covers .vtt natively; .srt and .ass will need conversion or a JS parser.

- ffmpeg fallback thumbnailer.  The platform thumbnailer (Tumbler/Caja/qlmanage) is the primary source of video thumbnails, but when it cannot produce one (unsupported format, headless environment, etc.) ffmpeg should be used as a fallback: `ffmpeg -ss <offset> -i <file> -vframes 1 -f image2 pipe:1`.  A sensible seek offset is 10 % of duration (requires a probe step) or a fixed 5 s.  This belongs in `media-native/thumbnailers/` alongside the existing backends.
