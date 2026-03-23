#!/usr/bin/env python3
"""
media_native_host.py — Native messaging host for the Media Viewer Firefox extension.

Runs two concurrent jobs:

JOB 1 — Queue watcher (main thread):
  Polls ~/.media-viewer/queue/ for JSON files dropped by `media-open`.
  Sends {"event":"open","dir":"...","file":"..."} to the extension.

JOB 2 — HTTP file/directory server (background thread):
  Binds to 127.7.203.98:0 (OS-assigned random port).

  URL format:
    GET /<token>/media-file/<url-encoded-absolute-path>
        Serves the image file with appropriate Content-Type.
        Supports Range requests (HTTP 206).

    GET /<token>/media-dir/<url-encoded-absolute-path>[?recursive=1]
        Returns a JSON directory listing:
          { "files": [{"u":..., "m":..., "s":..., "t":..., "r":...}, ...] }
        Keys: u=url/filename, m=mtime, s=size, t=type ("d" for dir),
              r=0 when unreadable (key absent when readable).
        With ?recursive=1 the listing is flattened; subdirs are omitted and
        file "u" values are relative paths (e.g. "subdir/photo.jpg").

    GET /<token>/media-thumb/<url-encoded-absolute-path>
        Returns a 128px XDG thumbnail PNG.  On Linux, generated on demand via
        a batched, signal-driven Tumbler D-Bus call.  Falls back to qlmanage
        (macOS) or Pillow (any platform).

    GET /<token>/media-queue-dir/<url-encoded-absolute-path>
        Pre-queues all images in the directory for background thumbnailing
        (Linux/Tumbler only).  Returns 204 immediately; the Tumbler Queue
        call runs in a daemon thread.

On startup, sends {"event":"server","port":N,"token":"T"} so the extension
knows where to direct proxy requests.

Native messaging wire format: 4-byte LE length prefix + UTF-8 JSON.
"""

import sys, os, json, struct, secrets, threading, time, pathlib, select, stat
import hashlib, tempfile, platform, subprocess
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

# Optional Pillow — last-resort thumbnail generator only.
try:
    from PIL import Image as _PILImage, PngImagePlugin as _PngInfo
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

PLATFORM = platform.system()   # 'Linux' | 'Darwin' | …

QUEUE_DIR     = pathlib.Path.home() / '.media-viewer' / 'queue'
POLL_INTERVAL = 0.5
BIND_HOST     = '127.7.203.98'
TOKEN         = secrets.token_hex(64)   # 512 bits of entropy

MIME_TYPES = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp':  'image/bmp',
    '.tiff': 'image/tiff',
    '.tif':  'image/tiff',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
}

IMAGE_EXTS = frozenset(MIME_TYPES)   # derived — MIME_TYPES is the single source of truth

# ── Wire protocol ──────────────────────────────────────────────────────────────

def read_message_nonblocking(timeout=POLL_INTERVAL):
    ready, _, _ = select.select([sys.stdin.buffer], [], [], timeout)
    if not ready:
        return None
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    if len(raw_msg) < msg_len:
        return None
    return json.loads(raw_msg.decode('utf-8'))

def send_message(msg):
    encoded = json.dumps(msg, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

# ── Directory listing ──────────────────────────────────────────────────────────

def entry_info(entry, rel_path):
    """Build a listing entry dict for a single DirEntry."""
    info = {'u': rel_path}
    try:
        st = entry.stat()   # follow symlinks to report target metadata
        info['m'] = int(st.st_mtime)
        info['s'] = st.st_size
        if stat.S_ISDIR(st.st_mode):
            info['t'] = 'd'
            info['u'] = rel_path.rstrip('/') + '/'
    except OSError:
        pass
    if not os.access(entry.path, os.R_OK):
        info['r'] = 0
    return info

def list_directory(dir_path, recursive=False):
    """Return a list of entry dicts for dir_path."""
    results = []

    def _scan(base, prefix):
        try:
            entries = sorted(os.scandir(base), key=lambda e: e.name.lower())
        except PermissionError:
            return
        for entry in entries:
            rel = prefix + entry.name if prefix else entry.name
            # Follow dir-symlinks only in non-recursive mode (avoids infinite loops
            # when recursing, while making symlinked dirs visible at the top level).
            if entry.is_dir(follow_symlinks=not recursive):
                if recursive:
                    _scan(entry.path, rel + '/')
                else:
                    results.append(entry_info(entry, rel + '/'))
            else:
                results.append(entry_info(entry, rel))

    _scan(dir_path, '')
    return results

# ── HTTP handler ───────────────────────────────────────────────────────────────

class MediaHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # silence access log

    def send_cors(self):
        origin = self.headers.get('Origin', '')
        if origin.startswith('moz-extension://') or origin.startswith('chrome-extension://'):
            self.send_header('Access-Control-Allow-Origin', origin)
        else:
            self.send_header('Access-Control-Allow-Origin', 'null')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Access-Control-Expose-Headers',
                         'Content-Range, Accept-Ranges, Content-Length')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_HEAD(self):
        self._dispatch(head_only=True)

    def do_GET(self):
        self._dispatch(head_only=False)

    def _dispatch(self, head_only):
        # Path: /<TOKEN>/<type>/<encoded-absolute-path>[?query]
        # Split off query string first.
        raw_path, _, query_str = self.path.partition('?')
        parts = raw_path.split('/', 3)   # ['', TOKEN, type, encoded-path]

        if len(parts) < 3 or parts[1] != TOKEN:
            self._error(403, 'Forbidden')
            return

        req_type = parts[2] if len(parts) > 2 else ''
        encoded  = parts[3] if len(parts) > 3 else ''

        try:
            file_path = urllib.parse.unquote(encoded)
        except Exception:
            self._error(400, 'Bad path encoding')
            return

        if not os.path.isabs(file_path):
            file_path = '/' + file_path
        file_path = os.path.normpath(file_path)

        if req_type == 'media-file':
            self._serve_file(file_path, head_only)
        elif req_type == 'media-dir':
            params     = urllib.parse.parse_qs(query_str)
            recursive  = '1' in params.get('recursive', [])
            self._serve_dir(file_path, recursive, head_only)
        elif req_type == 'media-thumb':
            self._serve_thumb(file_path, head_only)
        elif req_type == 'media-queue-dir':
            self._serve_queue_dir(file_path, head_only)
        else:
            self._error(400, 'Unknown request type')

    # ── File serving ───────────────────────────────────────────────────────

    def _serve_file(self, file_path, head_only):
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in IMAGE_EXTS:
            self._error(400, 'Not a supported image type')
            return
        if not os.path.isfile(file_path):
            self._error(404, 'File not found')
            return

        file_size = os.path.getsize(file_path)
        start, end, partial = 0, file_size - 1, False

        rng = self.headers.get('Range', '')
        if rng.startswith('bytes='):
            try:
                s, e = rng[6:].split('-', 1)
                start   = int(s) if s else file_size - int(e)
                end     = min(int(e) if e else file_size - 1, file_size - 1)
                partial = True
                if start > end or start < 0:
                    raise ValueError('invalid range')
            except Exception:
                self._error(416, 'Range Not Satisfiable')
                return

        length = end - start + 1
        data   = b''
        if not head_only:
            try:
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    data = f.read(length)
            except OSError as exc:
                self._error(500, str(exc))
                return

        mime = MIME_TYPES.get(ext, 'application/octet-stream')
        self.send_response(206 if partial else 200)
        self.send_cors()
        self.send_header('Content-Type',   mime)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges',  'bytes')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    # ── Directory listing ──────────────────────────────────────────────────

    def _serve_dir(self, dir_path, recursive, head_only):
        if not os.path.isdir(dir_path):
            self._error(404, 'Directory not found')
            return

        entries = list_directory(dir_path, recursive=recursive)
        body    = json.dumps({'files': entries}, separators=(',', ':')).encode('utf-8')

        self.send_response(200)
        self.send_cors()
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    # ── Thumbnail serving ──────────────────────────────────────────────────

    def _serve_thumb(self, file_path, head_only):
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in IMAGE_EXTS:
            self._error(400, 'Not a supported image type')
            return
        if not os.path.isfile(file_path):
            self._error(404, 'File not found')
            return

        thumb_path = _xdg_thumb_path(file_path)

        if thumb_path.exists() and _is_thumb_valid(thumb_path, file_path):
            self._send_png(thumb_path, head_only)
            return

        if _try_generate_thumbnail(file_path, thumb_path):
            self._send_png(thumb_path, head_only)
            return

        self._error(404, 'No thumbnail available')

    def _send_png(self, png_path, head_only):
        try:
            data = b'' if head_only else png_path.read_bytes()
            size = png_path.stat().st_size
        except OSError as exc:
            self._error(500, str(exc))
            return
        self.send_response(200)
        self.send_cors()
        self.send_header('Content-Type',   'image/png')
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control',  'max-age=3600')
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    # ── Directory pre-queue ────────────────────────────────────────────────

    def _serve_queue_dir(self, dir_path, head_only):
        if not os.path.isdir(dir_path):
            self._error(404, 'Not a directory')
            return
        if PLATFORM == 'Linux' and _tumbler_batcher is not None:
            threading.Thread(target=_prequeue_dir, args=(dir_path,),
                             daemon=True).start()
        self.send_response(204)
        self.send_cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── Error helper ───────────────────────────────────────────────────────

    def _error(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ── Thumbnail helpers ──────────────────────────────────────────────────────────

_THUMB_DIR       = pathlib.Path.home() / '.cache' / 'thumbnails' / 'normal'
_THUMB_FAIL_BASE = pathlib.Path.home() / '.cache' / 'thumbnails' / 'fail'


def _xdg_thumb_path(file_path):
    """Return the XDG 'normal' (128px) thumbnail cache path for an absolute file path."""
    uri = pathlib.Path(file_path).as_uri()
    md5 = hashlib.md5(uri.encode()).hexdigest()
    return _THUMB_DIR / (md5 + '.png')


def _is_thumb_valid(thumb_path, file_path):
    """Return True if the cached thumbnail is up-to-date for file_path."""
    try:
        file_mtime = int(os.path.getmtime(file_path))
        # Prefer the embedded Thumb::MTime tEXt chunk (XDG spec) when Pillow is available.
        if PIL_AVAILABLE:
            try:
                with _PILImage.open(str(thumb_path)) as img:
                    meta = int(img.text.get('Thumb::MTime', '0'))
                if meta > 0:
                    return meta >= file_mtime
            except Exception:
                pass
        # Fall back to comparing filesystem mtimes (works for qlmanage-generated thumbs too).
        return int(os.path.getmtime(str(thumb_path))) >= file_mtime
    except OSError:
        return False


def _is_thumb_failed(file_path):
    """Return True if any XDG fail-cache entry exists for file_path."""
    if not _THUMB_FAIL_BASE.exists():
        return False
    uri      = pathlib.Path(file_path).as_uri()
    md5      = hashlib.md5(uri.encode()).hexdigest()
    filename = md5 + '.png'
    try:
        for subdir in _THUMB_FAIL_BASE.iterdir():
            if subdir.is_dir() and (subdir / filename).exists():
                return True
    except OSError:
        pass
    return False


def _try_generate_thumbnail(file_path, thumb_path):
    """Generate a thumbnail using platform-appropriate tools. Returns True on success."""
    if PLATFORM == 'Linux':
        if _tumbler_batcher is not None and not _is_thumb_failed(file_path):
            uri = pathlib.Path(file_path).as_uri()
            if _tumbler_batcher.request(uri):
                return thumb_path.exists() and _is_thumb_valid(thumb_path, file_path)
        # Fall through to Pillow if batcher unavailable, Tumbler failed, or fail-cached.
    elif PLATFORM == 'Darwin':
        if _generate_via_qlmanage(file_path, thumb_path):
            return True
    # Last resort: Pillow (any platform).
    if PIL_AVAILABLE:
        return _generate_via_pillow(file_path, thumb_path)
    return False


# ── Linux: Tumbler via jeepney (batched, signal-driven) ───────────────────────
#
# Architecture:
#   ThumbnailBatcher collects incoming thumbnail requests over a short window
#   (BATCH_WINDOW seconds), then fires a single Tumbler Queue call for all of
#   them.  A separate daemon thread listens for Tumbler's Ready / Error /
#   Finished D-Bus signals and resolves the waiting per-URI slots.
#
#   Per-handle tracking (_handle_uris, _uri_handle, _handle_last_seen) is only
#   maintained for "live" batches (those with waiting threads).  Preemptive
#   directory-queue calls are fire-and-forget; their signals are silently
#   ignored.
#
#   Handles that produce no signal activity for HANDLE_TIMEOUT seconds are
#   garbage-collected lazily at the start of each _flush(), failing any
#   remaining waiting slots.  The timeout is intentionally long — its purpose
#   is to prevent state from bloating if Tumbler misbehaves, not to eagerly
#   report errors.

class _WaitSlot:
    __slots__ = ('event', 'success')
    def __init__(self):
        self.event   = threading.Event()
        self.success = False


class ThumbnailBatcher:
    BATCH_WINDOW   = 0.05   # seconds to collect requests before flushing
    HANDLE_TIMEOUT = 60.0   # seconds of signal inactivity before handle GC

    def __init__(self):
        self._lock             = threading.Lock()
        self._pending          = {}  # uri -> [_WaitSlot, ...]
        self._handle_uris      = {}  # handle -> set(uri)   [live batches only]
        self._uri_handle       = {}  # uri -> handle         [live batches only]
        self._handle_last_seen = {}  # handle -> float       [live batches only]
        self._timer            = None
        self._conn             = None   # jeepney proxy connection (lazy)
        self._conn_lock        = threading.Lock()

    # ── Public API ─────────────────────────────────────────────────────────

    def request(self, uri, timeout=8.0):
        """Add uri to the next live batch. Block until resolved or timeout. Returns bool."""
        with self._lock:
            slot = _WaitSlot()
            if uri in self._pending:
                self._pending[uri].append(slot)
            else:
                self._pending[uri] = [slot]
                if self._timer is None:
                    self._timer = threading.Timer(self.BATCH_WINDOW, self._flush)
                    self._timer.daemon = True
                    self._timer.start()
        slot.event.wait(timeout)
        return slot.success

    def queue_preemptive(self, uris, mimes):
        """Fire-and-forget: send uris to Tumbler with scheduler='background'."""
        self._tumbler_queue(uris, mimes, 'background')

    # ── Signal callbacks (called from listener thread) ─────────────────────

    def on_ready(self, handle, uris):
        with self._lock:
            if handle in self._handle_last_seen:
                self._handle_last_seen[handle] = time.monotonic()
            for uri in uris:
                self._uri_handle.pop(uri, None)
                if handle in self._handle_uris:
                    self._handle_uris[handle].discard(uri)
                self._resolve_uri(uri, True)

    def on_error(self, handle, failed_uris):
        with self._lock:
            if handle in self._handle_last_seen:
                self._handle_last_seen[handle] = time.monotonic()
            for uri in failed_uris:
                self._uri_handle.pop(uri, None)
                if handle in self._handle_uris:
                    self._handle_uris[handle].discard(uri)
                self._resolve_uri(uri, False)

    def on_finished(self, handle):
        with self._lock:
            # Any URIs still outstanding on this handle were never signalled — fail them.
            for uri in self._handle_uris.pop(handle, set()):
                self._uri_handle.pop(uri, None)
                self._resolve_uri(uri, False)
            self._handle_last_seen.pop(handle, None)

    # ── Internal ───────────────────────────────────────────────────────────

    def _flush(self):
        with self._lock:
            self._gc_stale_handles()
            # Only include URIs not already tracked by an in-flight live batch.
            batch_uris = [u for u in self._pending if u not in self._uri_handle]
            self._timer = None

        if not batch_uris:
            return

        mimes = [
            MIME_TYPES.get(
                os.path.splitext(urllib.parse.unquote(u[7:]))[1].lower(),
                'application/octet-stream')
            for u in batch_uris
        ]

        handle = self._tumbler_queue(batch_uris, mimes, 'default')

        with self._lock:
            if handle is None:
                # Queue call failed — resolve all waiting slots as False.
                for uri in batch_uris:
                    self._resolve_uri(uri, False)
                return
            # Register as a live batch.
            self._handle_uris[handle]      = set(batch_uris)
            self._handle_last_seen[handle] = time.monotonic()
            for uri in batch_uris:
                self._uri_handle[uri] = handle

    def _tumbler_queue(self, uris, mimes, scheduler):
        """Call Tumbler Queue via jeepney. Returns handle (int) or None on failure."""
        with self._conn_lock:
            try:
                from jeepney import DBusAddress, new_method_call  # type: ignore
                from jeepney.io.blocking import open_dbus_connection  # type: ignore
                if self._conn is None:
                    self._conn = open_dbus_connection(bus='SESSION')
                addr  = DBusAddress(
                    '/org/freedesktop/thumbnails/Thumbnailer1',
                    bus_name='org.freedesktop.thumbnails.Thumbnailer1',
                    interface='org.freedesktop.thumbnails.Thumbnailer1',
                )
                msg   = new_method_call(addr, 'Queue', 'asasssu',
                                        (uris, mimes, 'normal', scheduler, 0))
                reply = self._conn.send_and_get_reply(msg, timeout=10)
                return reply.body[0]
            except Exception:
                self._conn = None
                return None

    def _resolve_uri(self, uri, success):
        """Called with _lock held. Set result and wake all slots waiting on uri."""
        for slot in self._pending.pop(uri, []):
            slot.success = success
            slot.event.set()

    def _gc_stale_handles(self):
        """Called with _lock held. Fail and remove handles idle for HANDLE_TIMEOUT s."""
        now   = time.monotonic()
        stale = [h for h, t in self._handle_last_seen.items()
                 if now - t > self.HANDLE_TIMEOUT]
        for handle in stale:
            for uri in self._handle_uris.pop(handle, set()):
                self._uri_handle.pop(uri, None)
                self._resolve_uri(uri, False)
            del self._handle_last_seen[handle]


def _start_tumbler_signal_listener(batcher):
    """Start a daemon thread that receives Tumbler D-Bus signals and feeds batcher."""
    def _listener():
        try:
            from jeepney import DBusAddress, new_method_call   # type: ignore
            from jeepney import HeaderFields, MessageType       # type: ignore
            from jeepney.io.blocking import open_dbus_connection  # type: ignore

            conn = open_dbus_connection(bus='SESSION')

            match_str = (
                "type='signal',"
                "sender='org.freedesktop.thumbnails.Thumbnailer1',"
                "interface='org.freedesktop.thumbnails.Thumbnailer1',"
                "path='/org/freedesktop/thumbnails/Thumbnailer1'"
            )
            dbus_addr = DBusAddress(
                '/org/freedesktop/DBus',
                bus_name='org.freedesktop.DBus',
                interface='org.freedesktop.DBus',
            )
            conn.send_and_get_reply(
                new_method_call(dbus_addr, 'AddMatch', 's', (match_str,))
            )

            while True:
                msg = conn.recv_message()
                if msg.header.message_type != MessageType.signal:
                    continue
                member = msg.header.fields.get(HeaderFields.member)
                try:
                    if member == 'Ready':
                        handle, uris = msg.body
                        batcher.on_ready(handle, list(uris))
                    elif member == 'Error':
                        handle, failed_uris = msg.body[0], msg.body[1]
                        batcher.on_error(handle, list(failed_uris))
                    elif member == 'Finished':
                        batcher.on_finished(msg.body[0])
                except Exception:
                    pass
        except Exception:
            pass

    threading.Thread(target=_listener, daemon=True, name='tumbler-signals').start()


def _prequeue_dir(dir_path):
    """Scan dir_path and send a background Tumbler queue for uncached images."""
    if _tumbler_batcher is None:
        return

    uris        = []
    mimes       = []
    total_bytes = 0
    scanned     = 0
    deadline    = time.monotonic() + 0.15   # 150 ms effort cap

    try:
        entries = list(os.scandir(dir_path))
    except OSError:
        return

    for entry in entries:
        if time.monotonic() > deadline or scanned >= 2000:
            break
        scanned += 1

        if entry.is_dir(follow_symlinks=False):
            continue

        ext  = os.path.splitext(entry.name)[1].lower()
        mime = MIME_TYPES.get(ext)
        if mime is None:
            continue

        file_path = entry.path

        # Skip files that are already thumbnailed or known to fail.
        thumb_path = _xdg_thumb_path(file_path)
        if thumb_path.exists() and _is_thumb_valid(thumb_path, file_path):
            continue
        if _is_thumb_failed(file_path):
            continue

        uri  = pathlib.Path(file_path).as_uri()
        cost = len(uri) + len(mime)
        if total_bytes + cost > 65536:
            break

        uris.append(uri)
        mimes.append(mime)
        total_bytes += cost

    if uris:
        _tumbler_batcher.queue_preemptive(uris, mimes)


def _init_tumbler_batcher():
    """Initialise the global ThumbnailBatcher and its signal listener (Linux only)."""
    global _tumbler_batcher
    if PLATFORM != 'Linux':
        return
    try:
        import jeepney  # type: ignore  # noqa: F401
    except ImportError:
        return
    batcher = ThumbnailBatcher()
    _start_tumbler_signal_listener(batcher)
    _tumbler_batcher = batcher


_tumbler_batcher = None   # ThumbnailBatcher | None  (Linux + jeepney only)


# ── macOS: QuickLook via qlmanage ─────────────────────────────────────────────

def _generate_via_qlmanage(file_path, thumb_path):
    """Use qlmanage to generate a 128px thumbnail and cache it. Returns True on success."""
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            r = subprocess.run(
                ['qlmanage', '-t', '-s', '128', '-o', tmp_dir, file_path],
                capture_output=True, timeout=15,
            )
            if r.returncode != 0:
                return False
            candidates = [f for f in os.listdir(tmp_dir) if f.lower().endswith('.png')]
            if not candidates:
                return False
            src = os.path.join(tmp_dir, candidates[0])
            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(thumb_path.parent), suffix='.png')
            os.close(fd)
            try:
                import shutil
                shutil.copy2(src, tmp)
                os.replace(tmp, str(thumb_path))
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        return True
    except Exception:
        return False


# ── Fallback: Pillow ──────────────────────────────────────────────────────────

def _generate_via_pillow(file_path, thumb_path):
    """Generate a 128px XDG thumbnail via Pillow. Returns True on success."""
    try:
        with _PILImage.open(file_path) as img:
            img.thumbnail((128, 128))
            info = _PngInfo.PngInfo()
            info.add_text('Thumb::URI',   pathlib.Path(file_path).as_uri())
            info.add_text('Thumb::MTime', str(int(os.path.getmtime(file_path))))
            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(thumb_path.parent), suffix='.png')
            os.close(fd)
            try:
                img.save(tmp, 'PNG', pnginfo=info)
                os.replace(tmp, str(thumb_path))
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        return True
    except Exception:
        return False


# ── HTTP server ────────────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_http_server():
    server = ThreadedHTTPServer((BIND_HOST, 0), MediaHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]   # actual port assigned by OS

# ── Queue watcher ──────────────────────────────────────────────────────────────

def check_queue():
    if not QUEUE_DIR.exists():
        return []
    reqs = []
    for f in sorted(QUEUE_DIR.glob('open_*.json')):
        try:
            reqs.append(json.loads(f.read_text()))
            f.unlink()
        except Exception:
            try:
                f.unlink()
            except Exception:
                pass
    return reqs

def validate_open_request(req):
    dir_path = req.get('dir', '')
    if not dir_path or not os.path.isdir(dir_path):
        return None
    file_name = req.get('file', '')
    # If a specific file was requested, verify it exists in that directory.
    if file_name:
        full_path = os.path.join(dir_path, file_name)
        if not os.path.isfile(full_path):
            file_name = ''
    return {'dir': dir_path, 'file': file_name}

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    _init_tumbler_batcher()
    port = start_http_server()
    send_message({'event': 'server', 'port': port, 'token': TOKEN})

    while True:
        for req in check_queue():
            validated = validate_open_request(req)
            if validated:
                send_message({
                    'event': 'open',
                    'dir':   validated['dir'],
                    'file':  validated['file'],
                })

        msg = read_message_nonblocking()
        if msg is None:
            continue
        if msg.get('cmd') == 'ping':
            send_message({'status': 'pong'})

if __name__ == '__main__':
    main()
