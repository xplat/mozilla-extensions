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
| `http://127.7.203.98/media-file/`  | Fetch an image file |
| `http://127.7.203.98/media-dir/`   | Fetch a directory listing (JSON) |
| `http://127.7.203.98/media-thumb/` | Fetch a 128px thumbnail PNG |

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
* `GET /<token>/media-thumb/<encoded-absolute-path>` — return a 128×128 thumbnail PNG.
  Checks the XDG thumbnail cache (`~/.cache/thumbnails/normal/<md5>.png`) first.
  On a cache miss, generates via the platform thumbnail service and caches the result:
  Linux: Tumbler (`org.freedesktop.thumbnails.Thumbnailer1` D-Bus, via `dbus-python`
  or `dbus-send`); macOS: `qlmanage -t`.  Falls back to Pillow as a last resort.
  Returns `404` if no thumbnail can be produced.
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
  "zoomFit":         true,    // z — fit image to window vs. explicit scale
  "zoomReduceOnly":  true,    // ` — in fit mode, don't enlarge small images (-r flag)
  "recursive":       false,   // off by default (not an xzgv concept)
  "selectorVisible": true,    // Z — selector panel shown
  "showHidden":      false,   // . — show dotfiles
  "sortBy":          "name",  // s (selector) — "name" | "mtime" | "size"
  "thumbnails":      false,   // v — thumbnail grid vs. filename list
  "rotation":        0,       // r/R/N (viewer) — 0 | 90 | 180 | 270 degrees
  "mirror":          false,   // M (viewer) — mirror image horizontally (xzgv 'm')
  "flip":            false,   // F (viewer) — flip image vertically    (xzgv 'f')
  "scale":           1.0      // d/D/s/S/n (viewer) — scale factor when zoomFit=false
}
```

`history.pushState` is used when navigating to a new directory; `history.replaceState`
is used for all other state changes (selection within same dir, zoom, flip, etc.).

---

## Default UI State

The viewer starts as if launched with xzgv options **`-z -r`**:

* `-z` → `zoomFit: true` (zoom-to-fit enabled by default)
* `-r` → `zoomReduceOnly: true` (in zoom-to-fit mode, shrink images larger than the
  window but do **not** enlarge images smaller than the window — they are shown at 1:1)

Recursive directory listing defaults to **off** (`recursive: false`).  xzgv has no
equivalent concept (it only lists the current directory); recursive mode is an
extension-specific addition, toggled with the REC button.

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
┌───────────────┬─┬─────────────────────────────────────┐
│ /home/user/.. ││                                       │
├───────────────┤│         IMAGE DISPLAY                 │
│  > vacation/  ││                                       │
│    beach.jpg  ││        [image here]                   │
│    sunset.jpg ││                                       │
│    video.mp4  ││                                       │  ← greyed
│               ││                                       │
├───────────────┤│                                       │
│ REC HID NAME  ││                                       │
└───────────────┴┴─────────────────────────────────────┘
                ↑
           pane divider (drag to resize)
```

There is **no top bar**.  The selector pane has:

* A narrow **header** showing the current directory path.
* A scrollable **file list** (directories first, then files).
* A narrow **footer** with the REC / HID / sort-order toggle buttons.

A **pane divider** between the selector and image pane can be dragged to resize
the split.  Keyboard shortcuts `[` / `]` / `~` also narrow, widen, or reset the
split width.

The active pane is indicated by a coloured divider edge (selector focus) or an
inset ring on the image pane (viewer focus).  Keyboard focus switches with
`Tab` or `Escape`.

When `selectorVisible = false` (Z mode or browser fullscreen) the entire
selector pane and divider are hidden and the image pane fills the full width.

---

## Keyboard Focus Modes

The viewer has two keyboard focus modes, matching xzgv's modal design:

* **Selector focus** — keyboard controls the file list.
* **Viewer focus** — keyboard controls the displayed image.

`Tab` switches between modes.  `Escape` in viewer focus returns to selector
focus.  Clicking on a pane also switches focus to that pane.  Opening an image
file from the selector (Enter / Space) switches focus to viewer automatically.

## Keyboard Shortcuts

### Global (both focus modes)

| Key | Action |
|-----|--------|
| `Tab` | Switch focus between selector and image pane |
| `Escape` | Return to selector focus (from viewer focus) |
| `Z` | Toggle selector panel visibility |
| `f` | Toggle browser-level fullscreen (also hides selector; restores on exit) |
| `i` | Toggle file-info overlay (filename, size, mtime, dimensions) |
| `.` | Toggle visibility of hidden (dot) files |
| `v` | Toggle thumbnail grid / filename-list mode in selector (xzgv `v`) |
| `[` / `]` | Narrow / widen selector pane by 16 px (xzgv `[` / `]`) |
| `~` | Reset selector pane to default width (xzgv `~`) |

### Selector focus

| Key | Action |
|-----|--------|
| `↑` / `↓`  (or `k` / `j`) | Move selection up / down |
| `PgUp` / `PgDn` | Move selection by ~10 items |
| `Home` / `End` | Jump to first / last selectable item |
| `Enter` / `Space` | Open selected item (enter directory or view image) |
| `→` | Enter selected directory, or advance to next image |
| `←` / `Backspace` / `u` | Go to parent directory |
| `n` | Advance to next image |
| `b` / `p` | Go to previous image |
| `s` | Cycle sort order: name → mtime → size → name |
| `z` | Toggle zoom fit-to-window |
| `R` | Rescan current directory (xzgv `Ctrl-r`; `Ctrl-r` unavailable in browser) |

### Viewer focus — scrolling / panning

| Key | Action |
|-----|--------|
| `↑` `↓` `←` `→` | Scroll 100 px in that direction |
| `Ctrl`+`↑` `↓` `←` `→` | Scroll 10 px (fine control) |
| `PgUp` / `PgDn` | Scroll ~90 % of pane height |
| `-` / `=` | Scroll ~90 % of pane width left / right |
| `Home` | Jump to top-left of image |
| `End` | Jump to bottom-right of image |

### Viewer focus — image navigation

| Key | Action |
|-----|--------|
| `Space` | Next image |
| `b` / `p` | Previous image |

### Viewer focus — orientation

| Key | Action |
|-----|--------|
| `r` | Rotate 90° clockwise (xzgv `r`) |
| `R` | Rotate 90° counter-clockwise (xzgv `R`) |
| `N` | Restore normal orientation — reset rotation, mirror, and flip (xzgv `N`) |
| `M` | Mirror image horizontally — flip left/right (xzgv `m`, uppercased for consistency with `F`) |
| `F` | Flip image vertically — flip top/bottom (xzgv `f`, uppercased to avoid fullscreen conflict) |

### Viewer focus — zoom / scale

| Key | Action |
|-----|--------|
| `z` | Toggle fit-to-window mode (xzgv `z`) |
| `` ` `` | Toggle reduce-only fit (shrink large / keep small at 1:1) (replaces xzgv `Alt-r`) |
| `d` | Double current scale (xzgv `d`) |
| `D` | Halve current scale (xzgv `D`) |
| `s` | Increase scale one step (xzgv `s`) |
| `S` | Decrease scale one step (xzgv `S`) |
| `n` / `1` | Return to 1:1 actual size (xzgv `n`) |
| `2` / `3` / `4` | Quick zoom to 2×, 3×, 4× scale |

### Notes

* **`f` vs `Z`**: `Z` hides/shows the selector within the normal browser window.
  `f` requests browser-level fullscreen and hides the selector; on exit the
  selector is restored to the state `Z` had set.
* **`M` vs `F`**: xzgv's `m` = horizontal mirror; xzgv's `f` = vertical flip.
  Both are uppercased (`M`/`F`) for consistency; `f` would conflict with fullscreen.
* **Alt+ replacements**: xzgv's `Alt-r` (reduce-only) is mapped to `` ` ``.  Other
  Alt+ shortcuts either have equivalents (`Alt-n/s/d` sort → `s` key cycle) or are
  omitted (tagging, thumbnail management, dithering).
* **`v` (thumbnail toggle)**: xzgv's `v` cycled between large and small thumbnail
  sizes.  Here it toggles between a thumbnail grid (128px images, lazy-loaded
  via `media-thumb`) and the plain filename list.  State is persisted in history.
* **Removed from xzgv**: copy, move, rename, delete, tagging, thumbnail
  management, dithering / interpolation controls.
* **Removed**: `q` to quit — the browser provides adequate tab-close controls.
* **Mouse**: Left-click on the image pane switches to viewer focus.  Drag to
  pan (scroll) the image when not in fit-to-window mode.  Drag the pane divider
  to resize the selector/image split.

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
