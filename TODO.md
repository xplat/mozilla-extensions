# General

- The extensions have too much code duplication between them.  Making use of well-known python packages where applicable, and ones local to this project where not, we should factor out the main event loop and threading structure, directory and file location logic, and the installation (registration and directory creation) logic from the native components.  The installation scripts could be something in the repo root we can just give an appropriate directory argument to and it will install python code with pip/pipx as appropriate and ask *the code itself* to complete setup.  Or maybe they could actually load little sh/powershell files that define the appropriate details of the installation that differ between the extensions, either through variables or hook calls.  For the extension components, maybe the common pieces of the background scripts could be symlinked into the extension dirs and loaded as sub-scripts from within the browser, or if that won't work well for some permissions or efficiency reason, maybe use some simple JS build tooling (no very involved transpiling and definitely no minifying!).

# Media Viewer

- Since video was added, the loaded image blanks right away when a new image starts loading, and even before that, when an image first showed up it would often be squished into the shape of the previous image. This should be fixed, so the user always has something to look at and what they're looking at always makes sense.

- Currently when a file outside or partially outside the selector viewport becomes selected, the selector scrolls the minimal amount to make it fully visible.  Instead this file should become vertically centered in the selector viewport, giving the user better visibility of thumbnails/files around it and making scrolling less frequent.

- Images displayed as smaller than the viewport in one or both dimensions should be centered in the viewport in those dimension(s) regardless of scaling and zoom mode, while in dimensions bigger than the viewport there should not be empty space on either side.  Within these constraints, a view adjustment from scaling, rotation or flipping should disturb the position in image coordinates of the center of the viewport as little as possible.

- There should be a single, cross-tab setting for volume, balance, and mute, kept in storage and the viewer should check and apply this when starting audio playback or when it's playing and hears an appropriate message on the broadcast channel.

- If `p` is pressed in an image or the selector, whichever tab is (or last was, if playback hasn't ended) playing audio should pause/play.

- The media viewer should support playlists and background audio.  q should queue an item and select the next item (whether focused or in selector).  Q should cycle between normal view, audio queue, and video queue.  When you start the audio queue playing it should be played by the background script and if it pauses for a foreground play it should start back up when that's over.  The extension popup should display the status of the audio queue.  When nothing else of extended duration is an appropriate target, the global media keys should control the audio queue.  Also when you press 'q' on a directory, all the queueable items in the directory or in subdirectories named `(CD|Disc)\s*\d+` should be queued.

- Separate from mute, there should be a per-tab SILENT mode that treats all video files as if they had no audio and refuses to play audio files (but will queue them).

- All active pure-audio playback should pause while mute is on.  This is a separate state from ordinary pausing and the audio should resume when mute ends unless it would have been paused at that point already (e.g. a video with sound started playing, or a tab playing a video with sound exited SILENT mode).

- Subtitle support.  Subtitles are probably a project as large as the rest of video support combined, so this is its own item.  The mplayer subtitle keys to implement are: j/J (cycle subtitle track forward/backward), x/z (delay ±0.1 s), and r/t (position up/down — these are safe to use in video-mode overrides since rotation does not apply to video).  External subtitle files (.srt, .vtt, .ass) should be auto-loaded if present alongside the video file with the same base name.  The `<track>` element covers .vtt natively; .srt and .ass will need conversion or a JS parser.

- Color/image-quality adjustment keys for video.  mplayer uses 1/2 (contrast), 3/4 (brightness), 5/6 (hue), 7/8 (saturation).  In video-mode overrides the quick-zoom shortcuts (1–4) do not apply, so those digit keys are available.  The underlying mechanism is CSS `filter:` on the video element, or the VideoFrame API if finer control is needed.

- ffmpeg fallback thumbnailer.  The platform thumbnailer (Tumbler/Caja/qlmanage) is the primary source of video thumbnails, but when it cannot produce one (unsupported format, headless environment, etc.) ffmpeg should be used as a fallback: `ffmpeg -ss <offset> -i <file> -vframes 1 -f image2 pipe:1`.  A sensible seek offset is 10 % of duration (requires a probe step) or a fixed 5 s.  This belongs in `media-native/thumbnailers/` alongside the existing backends.
