# Media Viewer Extension — Specification

## Overview

A Firefox WebExtension (MV3) for viewing local image files, with a UI modelled on
[xzgv](https://sourceforge.net/projects/xzgv/).  A companion Python native messaging
host serves files and directory listings over a local HTTP socket.

---

## Architecture

### No `chrome.*` / `browser.*` in Viewer Pages

Viewer pages (including any frames or iframes) must **not** call any `chrome.*` or
`browser.*` APIs.  Such calls trigger the ExtensionPageContextChild component in Firefox,
which causes the viewer tab to close when the extension is reloaded/updated during
development.  All privileged operations go through the **background service worker**.

### Proxy URL Pattern

The viewer fetches resources via two stable *proxy* URL prefixes that never contain a
port or secret token:

| Prefix | Purpose |
|--------|---------|
| `http://127.7.203.98/media-file/` | Fetch an image file |
| `http://127.7.203.98/media-dir/`  | Fetch a directory listing (JSON) |

The background script intercepts `webRequest.onBeforeRequest` for both prefixes and
rewrites them to the real native-host HTTP server URL:

```
http://127.7.203.98:<random-port>/<512-bit-token>/<type>/<encoded-path>
```

Only requests whose `originUrl` or `documentUrl` begins with the extension's own
`moz-extension://` origin are allowed through; all others are cancelled.

The loopback address `127.7.203.98` (distinct from the CBZ viewer's `127.7.203.66`)
sits within the `127.0.0.0/8` loopback range on Linux/macOS, is unlikely to conflict
with other services, and prevents file paths leaking off the machine even if the
browser's redirect handling misbehaves.

### Native Messaging Host

The Python host (`media_native_host.py`) runs two concurrent jobs:

**Job 1 — Queue watcher (main thread)**

Polls `~/.media-viewer/queue/` every 0.5 s for JSON files written by the `media-open`
CLI tool.  Each file has the form:

```json
{ "dir": "/absolute/path/to/directory", "file": "image.jpg" }
```

`"file"` is optional (omit to open the directory with no image pre-selected).  On
finding a valid request the host sends an `open` event to the extension:

```json
{ "event": "open", "dir": "/absolute/path", "file": "image.jpg" }
```

**Job 2 — HTTP file server (background thread)**

Binds to `127.7.203.98:0` (OS-assigned random port).  Handles:

* `GET /<token>/media-file/<encoded-absolute-path>` — serve the file with correct
  `Content-Type`, supporting `Range` requests (HTTP 206).
* `GET /<token>/media-dir/<encoded-absolute-path>[?recursive=1]` — return a directory
  listing JSON object (see below).
* `OPTIONS` — CORS preflight.

On startup the host sends:

```json
{ "event": "server", "port": 12345, "token": "abc123..." }
```

**Wire format:** 4-byte little-endian length prefix + UTF-8 JSON (standard native
messaging protocol).

---

## Extension Structure

```
media-extension/
  manifest.json          MV3 manifest
  background.js          Service worker: proxy rewriting + native messaging
  viewer.html            Main viewer page
  viewer.js              Viewer UI logic (no chrome.* calls)
  viewer.css             Styling
  icons/                 16 / 48 / 128 px PNGs
media-native/
  media_native_host.py   Native messaging host
  media-open             CLI tool to open a directory/file
  media_viewer_host.json Native messaging manifest
  install.sh             Installation script
```

Extension ID: `media-viewer@xplat.github.io`
Native host name: `media_viewer_host`

---

## Viewer URL Format

Current directory and current file selection are encoded in the **visible URL** so the
tab is bookmarkable and shareable:

```
viewer.html?dir=file%3A%2F%2F%2Fhome%2Fuser%2Fpictures&file=sunset.jpg
```

Parameters:

| Param | Type | Description |
|-------|------|-------------|
| `dir` | `file://` URL | Absolute path of the current directory (required) |
| `file` | filename string | Currently viewed / selected file within `dir` (optional) |

All other UI state is stored in the **JSON object associated with the history entry**
(`history.state`) so it survives refresh and back/forward navigation without cluttering
the URL.

### History State Object

```jsonc
{
  "zoomFit":         true,   // z — fit image to window vs. 1:1
  "recursive":       true,   // r — include files from subdirectories
  "selectorVisible": true,   // Z — selector panel shown
  "showHidden":      false,  // . — show dotfiles
  "sortBy":          "name", // s — "name" | "mtime" | "size"
  "flip":            false   // F — mirror image horizontally
}
```

`history.pushState` is used when navigating to a new directory; `history.replaceState`
is used for all other state changes (selection within same dir, zoom, flip, etc.).

---

## Default UI State

The viewer starts as if launched with xzgv options **`-z -r`**:

* `-z` → `zoomFit: true` (zoom-to-fit enabled by default)
* `-r` → `recursive: true` (recursive directory listing enabled by default)

---

## Directory Listing JSON

The native host returns a JSON object wrapping a list of entry objects.  Single-letter
keys minimise wire size.

```jsonc
{
  "files": [
    // Readable image file
    { "u": "sunset.jpg",   "m": 1718000000, "s": 2457600 },

    // Subdirectory
    { "u": "vacation/",    "m": 1718100000, "s": 4096,   "t": "d" },

    // Unreadable file — "r" key present with value 0
    { "u": "private.png",  "m": 1718200000, "s": 1024,   "r": 0   },

    // Readable but not an image (video, document, etc.)
    // — no "t" key; viewer greys it out based on extension
    { "u": "movie.mp4",    "m": 1718300000, "s": 104857600 }
  ]
}
```

| Key | Type | Meaning |
|-----|------|---------|
| `u` | string | Filename (relative to requested directory).  Directories end with `/`. |
| `m` | integer | Modification time as a Unix timestamp (seconds).  **ctime and atime are not used.** |
| `s` | integer | File size in bytes. |
| `t` | string | File type.  `"d"` for directories.  Omitted for regular files. |
| `r` | integer | Readability flag.  Only present (value `0`) when the file **cannot** be read.  Omitted when the file is readable. |

In **recursive mode** (`?recursive=1`) the listing is flattened; subdirectory entries
are omitted and file `"u"` values are relative paths, e.g. `"vacation/beach.jpg"`.

---

## Displayed File Types

The viewer treats the following extensions as displayable (by the browser's native
image rendering):

`jpg`, `jpeg`, `png`, `gif`, `webp`, `avif`, `bmp`, `tiff`, `tif`, `svg`, `ico`

Files with other extensions are shown in the selector but **greyed out and
non-selectable** (same treatment as unreadable files).

---

## UI Layout

```
┌───────────────────────────────────────────────────────┐
│  [IMG]  /home/user/pictures    [REC][HID][NAME][FIT][Z]│  ← topbar
├───────────────┬───────────────────────────────────────┤
│  SELECTOR     │                                       │
│               │          IMAGE DISPLAY                │
│  ▸ vacation/  │                                       │
│  · beach.jpg  │         [image here]                  │
│  · sunset.jpg │                                       │
│  · video.mp4  │                                       │  ← greyed
│               │                                       │
└───────────────┴───────────────────────────────────────┘
```

* **Selector pane** (left, ~260 px wide): scrollable list of directory entries.
  Directories shown first (alphabetically), then files.  Unreadable or
  non-image files are shown dimmed and cannot be selected.
* **Image pane** (right, fills remaining space): displays the currently viewed image.
* **Top bar**: directory path, mode toggle buttons, keyboard hint.

When `selectorVisible = false` (Z mode or browser fullscreen) the selector pane is
hidden and the image pane fills the full width.

---

## Keyboard Shortcuts

### Navigation

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection up / down in selector |
| `↑` / `↓` (with `j`/`k` aliases) | Same |
| `→` | Enter selected directory, or show next image |
| `←` / `Backspace` / `u` | Go to parent directory |
| `Enter` / `Space` | Open selected item (enter dir or view image) |
| `n` | Next image |
| `p` | Previous image |
| `Home` | Select first item |
| `End` | Select last item |
| `PgUp` / `PgDn` | Scroll selector by one page |

### View

| Key | Action |
|-----|--------|
| `z` | Toggle zoom: fit-to-window ↔ 1:1 actual size |
| `Z` | Toggle selector panel visibility (separate state from `f`) |
| `f` | Toggle **browser-level fullscreen** + hide selector.  Exiting fullscreen restores the Z-mode selector state. |
| `F` | Flip image horizontally (mirror) |
| `i` | Toggle file info overlay (filename, size, mtime, dimensions) |

### Directory / Sorting

| Key | Action |
|-----|--------|
| `r` | Toggle recursive directory listing |
| `.` | Toggle visibility of hidden (dot) files |
| `s` | Cycle sort order: name → mtime → size → name |

### Misc

| Key | Action |
|-----|--------|
| `q` | Close tab |

### Notes

* **Removed from xzgv**: copy (`c`), move (`m`), rename (`n`), delete (`d`/`D`),
  dithering/interpolation controls.
* **Removed from xzgv**: explicit zoom-in / zoom-out steps (`+`/`-`) — the browser
  handles image rendering quality; only fit ↔ actual size toggle is provided.
* **`f` vs `Z`**: `Z` hides/shows the selector within the normal browser window.
  `f` requests *browser-level* fullscreen (equivalent to F11) and simultaneously
  hides the selector.  When the user presses `f` again or `Escape` to exit
  fullscreen, the selector is restored to whatever state `Z` had left it in.

---

## Metadata Notes

* **Only `mtime` is tracked** — ctime and atime are intentionally ignored.

---

## Shared Native Host (Future)

The CBZ viewer and Media viewer currently use separate native messaging hosts
(`cbz_viewer_host` and `media_viewer_host`).  A future refactor could merge them into a
single host that handles both extension IDs, reducing installation complexity.

---

## Installation

```bash
cd media-native
./install.sh
```

The script:
1. Copies `media_native_host.py` to `~/.local/share/media-viewer/`
2. Copies `media-open` to `~/.local/bin/` (or `~/bin/` as fallback)
3. Writes the native messaging manifest to the correct OS location
4. Creates `~/.media-viewer/queue/`

### CLI Usage

```bash
# Open a directory
media-open /home/user/pictures

# Open a specific file (pre-selects it in the viewer)
media-open /home/user/pictures/sunset.jpg
```
