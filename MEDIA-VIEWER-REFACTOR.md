@claude You seem to have gotten stuck on this refactor before, so I will try to divide it into bite-sized pieces and help out wherever necessary.

The monolith that is viewer.js is going to be divided up:

- viewer-audio.js : implementation of the audio "baton" and media channel watcher, implementations of the global audio keys.
- viewer-ui.js : persistent UI state, the division into two panes, focus, fullscreen, global keymap.
- viewer-list.js : common elements of the selector and two queue lists.
- viewer-selector.js : the selector.
- viewer-audio-queue.js : the audio queue.
- viewer-video-queue.js : the video queue.
- viewer-queue-mgt.js : queue management helpers.
- viewer-media.js : common elements of media objects, error page.
- viewer-media-imagelike.js : common elements between media-gif and image.  Some of this might be structured as helpers so audio can use it for cover loading in the future, but there might not be anything complicated enough to need that.
- viewer-media-image.js : actual image
- viewer-media-gif.js : fake gif that is actually a video
- viewer-media-playable.js : common elements of media with a time dimension (audio and video), such as progress bar and management of a <MEDIA> element.
- viewer-media-audio.js : audio media
- viewer-media-video.js : normal video media
- viewer-media-queued-video.js : video media from queue
- viewer-content.js : content area helpers, empty content area.
- viewer.js : mainly just wiring stuff up.

Keys not handled by the global key handler will be redirected to the occupant of the focused pane.  "Q", "v", and "Z" will be global keys and "." for hidden will be relegated to a selector key, simplifying the logic.  ("." for single-frame will belong to video).  The content pane will have a current occupant and, when loading, a future occupant.  Keys for the content pane will be sent to the current occupant when not loading and swallowed when loading.

Each media object will have a name, used to detect when it's already loaded (gif and video objects for the same file will share a name).  Every media object associated with a file will know its own full path without consulting globals, and this will be included in the name, along with an appropriate prefix.  It will also know the name of the list object that loaded it.  Naming for video queue objects might get involved if we ever support queue editing, but for now we can name them using the index and last queue-clearing time.  The load process involves calling content.load(<media object>) at which point it will be checked for already being loaded.  If not, the future occupant will be set, the spinner will be revealed, and the media object will be requested to load itself.  In either case, we return to the caller, who assumes success, and may go on to do things like set focus to the content pane if it wants.

The actual process of loading will be handled by an async function.  The content pane will provide a method to request one of the children of the #image-pane to work on--if it's the already-visible one, the current occupant will be asked to surrender it.  If it's still visible after surrender, the #transition-cover will be displayed.  (Most surrenders will be a no-op, but video and audio might do the hiding themselves with a screenshot/cover pic, making #transition-cover unnecessary.)  There will also be a redirect method, to be used for media-gif purposes, which allows for a handoff of the future occupant spot without cancelling the load.  When loading finishes, the requested child will be revealed.  Images will preload with a throwaway <img> as presently, and won't request the transform-host until that's done loading, preventing an extended blank.

When in fullscreen mode, from now on, the list pane will be visible when focused, but will show *on top* of the content pane rather than resizing it.  When unfocused it will be invisible.  The transition will be sliding in/out from the left, and Q will always focus the list pane, except when switching back to the list that loaded the current (or future if loading) content element in fullscreen, in which case the content pane will be focused.

As much code as is reasonable will be shared between queue and selector lists, within the common list class, making them more consistent.  Unless a different behavior is specifically required for the queue UX, queues should behave like the selector.  The list elements should be cloned from an HTML5 <template> tag to separate code and styling as much as possible.  Also, the selector should remain loaded while offscreen, and shouldn't need to be recreated just from switching back from a queue.
