#!/usr/bin/env python3
"""
media_native_host.py — Native messaging host for the Media Viewer Firefox extension.

Runs two concurrent jobs:

JOB 1 — Queue watcher (main thread):
  Watches the platform queue directory for JSON files dropped by `media-open`.
  Uses inotify on Linux, kqueue on macOS, and falls back to polling elsewhere.
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
        Returns a 128px thumbnail PNG.  Generation is delegated to the
        platform-appropriate backend (Tumbler on XFCE, qlmanage on macOS,
        Pillow as last resort).

    GET /<token>/media-queue-dir/<url-encoded-absolute-path>
        Pre-queues all images in the directory for background thumbnailing
        on backends that support it (e.g. Tumbler on XFCE).  Returns 204
        immediately; the queue call runs in a daemon thread.

On startup, sends {"event":"server","port":N,"token":"T"} so the extension
knows where to direct proxy requests.

Native messaging wire format: 4-byte LE length prefix + UTF-8 JSON.
"""

import sys, os, json, logging, struct, secrets, threading, time, pathlib, select, stat
import queue as _q
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

import thumbnailers
from thumbnailers import MIME_TYPES

# ── Platform-appropriate directories ───────────────────────────────────────────

def _platform_cache_dir(app_name):
    """Return the platform-appropriate user cache directory for app_name."""
    if sys.platform == 'darwin':
        return pathlib.Path.home() / 'Library' / 'Caches' / app_name
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA', '')
        return (pathlib.Path(base) if base else pathlib.Path.home()) / app_name
    # Linux / other POSIX: honour XDG_CACHE_HOME
    xdg = os.environ.get('XDG_CACHE_HOME', '').strip()
    return (pathlib.Path(xdg) if xdg else pathlib.Path.home() / '.cache') / app_name

_CACHE_DIR    = _platform_cache_dir('media-viewer')
QUEUE_DIR     = _CACHE_DIR / 'queue'
POLL_INTERVAL = 0.5
BIND_HOST     = '127.7.203.98'
TOKEN         = secrets.token_hex(64)   # 512 bits of entropy

IMAGE_EXTS = frozenset(MIME_TYPES)   # derived — MIME_TYPES is the single source of truth

# ── Queue watcher (inotify / kqueue / ReadDirectoryChangesW / polling) ─────────

class _QueueWatcher:
    """
    Watch a directory for new files.  Call .wait(timeout) to block until an
    event fires or the timeout expires, then scan the directory for new entries.

      Linux   → inotify via ctypes/libc
      macOS   → kqueue  via Python's select module
      Windows → ReadDirectoryChangesW via ctypes in a daemon thread
      other   → pure timeout (polling fallback)

    All OS resources are released on .close().
    """

    def __init__(self, path: pathlib.Path):
        self._fd      = -1    # inotify fd  (Linux)
        self._dir_fd  = -1    # kqueue: open fd for the watched directory
        self._kq      = None  # kqueue object (macOS)
        self._event   = None  # threading.Event signalled by RDCW thread (Windows)

        if sys.platform == 'linux':
            self._setup_inotify(path)
        elif sys.platform == 'darwin':
            self._setup_kqueue(path)
        elif sys.platform == 'win32':
            self._setup_rdcw(path)
        # other: all fields stay at defaults → pure sleep fallback

    # ── Setup ──────────────────────────────────────────────────────────────────

    def _setup_inotify(self, path):
        try:
            import ctypes
            _libc = ctypes.CDLL(None, use_errno=True)
            fd = _libc.inotify_init()
            if fd < 0:
                return
            # IN_MOVED_TO fires when a rename lands in the directory — exactly
            # what our atomic write (write .tmp then rename to .json) produces.
            # IN_CREATE fires on the initial creation of the .tmp file, before
            # any content is written, so we deliberately omit it.
            IN_MOVED_TO = 0x00000080
            wd = _libc.inotify_add_watch(
                fd, str(path).encode(), ctypes.c_uint32(IN_MOVED_TO)
            )
            if wd < 0:
                os.close(fd)
                return
            self._fd = fd
        except Exception:
            pass

    def _setup_kqueue(self, path):
        try:
            kq     = select.kqueue()
            dir_fd = os.open(str(path), os.O_RDONLY)
            ev     = select.kevent(
                dir_fd,
                filter=select.KQ_FILTER_VNODE,
                flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND,
            )
            kq.control([ev], 0)
            self._kq     = kq
            self._dir_fd = dir_fd
            self._fd     = kq.fileno()
        except Exception:
            pass

    def _setup_rdcw(self, path):
        try:
            import ctypes
            import ctypes.wintypes as _wt
            _k32 = ctypes.windll.kernel32

            GENERIC_READ               = 0x80000000
            FILE_SHARE_ALL             = 0x07
            OPEN_EXISTING              = 3
            FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
            FILE_NOTIFY_CHANGE_FILE_NAME = 0x0001
            INVALID_HANDLE_VALUE       = ctypes.c_void_p(-1).value

            hDir = _k32.CreateFileW(
                str(path),
                GENERIC_READ,
                FILE_SHARE_ALL,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
            if hDir == INVALID_HANDLE_VALUE or hDir is None:
                return

            ev = threading.Event()
            self._event = ev

            buf      = ctypes.create_string_buffer(4096)
            returned = _wt.DWORD(0)

            def _watch():
                try:
                    while True:
                        ok = _k32.ReadDirectoryChangesW(
                            hDir, buf, len(buf),
                            False,                           # bWatchSubtree
                            FILE_NOTIFY_CHANGE_FILE_NAME,    # dwNotifyFilter
                            ctypes.byref(returned),
                            None,                            # lpOverlapped
                            None,                            # lpCompletionRoutine
                        )
                        if ok:
                            ev.set()
                        else:
                            break  # handle closed or error
                finally:
                    _k32.CloseHandle(hDir)

            threading.Thread(target=_watch, daemon=True,
                             name='rdcw-watcher').start()
        except Exception:
            pass

    # ── Public API ─────────────────────────────────────────────────────────────

    def wait(self, timeout) -> bool:
        """Block until a directory-change event fires or *timeout* seconds pass.

        Returns True if a kernel event fired (caller should scan the queue
        directory) or if no kernel API is available (caller must poll).
        Returns False on a clean timeout when a kernel watcher is active
        (no scan needed — nothing has changed).
        """
        if self._event is not None:
            # Windows RDCW: Event.wait() returns True if set, False on timeout.
            fired = self._event.wait(timeout)
            self._event.clear()
            return fired
        elif self._kq is not None:
            # macOS kqueue: non-empty result means an event fired.
            try:
                return bool(self._kq.control([], 8, timeout))
            except OSError:
                return False
        elif self._fd >= 0:
            # Linux inotify: readable fd means an event fired; drain it.
            try:
                r, _, _ = select.select([self._fd], [], [], timeout)
                if r:
                    os.read(self._fd, 4096)
                return bool(r)
            except OSError:
                return False
        else:
            # No kernel API — sleep and tell the caller to poll every time.
            time.sleep(timeout)
            return True

    def close(self):
        """Release OS resources (kqueue and inotify fds; RDCW cleans itself up)."""
        if self._kq is not None:
            try: self._kq.close()
            except OSError: pass
        if self._dir_fd >= 0:
            try: os.close(self._dir_fd)
            except OSError: pass
        elif self._fd >= 0:
            try: os.close(self._fd)
            except OSError: pass
        self._fd = self._dir_fd = -1
        self._kq = self._event = None

# ── Wire protocol ──────────────────────────────────────────────────────────────

def _read_message():
    """Read one native message from stdin (blocking)."""
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
        data = thumbnailers.request(file_path)
        if data is not None:
            self.send_response(200)
            self.send_cors()
            self.send_header('Content-Type',   'image/png')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control',  'max-age=3600')
            self.end_headers()
            if not head_only:
                self.wfile.write(data)
            return
        self._error(404, 'No thumbnail available')

    # ── Directory pre-queue ────────────────────────────────────────────────

    def _serve_queue_dir(self, dir_path, head_only):
        if not os.path.isdir(dir_path):
            self._error(404, 'Not a directory')
            return
        threading.Thread(target=thumbnailers.queue_dir, args=(dir_path,),
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


# ── HTTP server ────────────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_http_server():
    server = ThreadedHTTPServer((BIND_HOST, 0), MediaHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]   # actual port assigned by OS

# ── Queue helpers ──────────────────────────────────────────────────────────────

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

# ── Logging ────────────────────────────────────────────────────────────────────

# stdout carries the native messaging wire protocol (4-byte-length-prefixed JSON)
# so logging must never go there.  stderr is silently discarded by Firefox for
# native messaging hosts.  Log to a file instead.
def _init_logging():
    log_path = _CACHE_DIR / 'media_native_host.log'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(log_path),
        level=logging.WARNING,
        format='%(asctime)s %(levelname)-8s %(name)s: %(message)s',
        datefmt='%H:%M:%S',
    )

# ── Main ───────────────────────────────────────────────────────────────────────

def _handle_req(req):
    validated = validate_open_request(req)
    if validated:
        send_message({
            'event': 'open',
            'dir':   validated['dir'],
            'file':  validated['file'],
        })

def _handle_msg(msg):
    if msg is not None and msg.get('cmd') == 'ping':
        send_message({'status': 'pong'})

def main():
    _init_logging()
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    watcher = _QueueWatcher(QUEUE_DIR)
    thumbnailers.init()
    port = start_http_server()
    send_message({'event': 'server', 'port': port, 'token': TOKEN})

    # Read stdin in a background thread on all platforms.
    # (select() on pipes is unreliable on Windows; a thread works everywhere.)
    msgs = _q.Queue()
    def _stdin_reader():
        while True:
            m = _read_message()
            if m is None:
                return
            msgs.put(m)
    threading.Thread(target=_stdin_reader, daemon=True, name='stdin-reader').start()

    # Startup scan: pick up any files already waiting in the queue.
    for req in check_queue():
        _handle_req(req)

    while True:
        # Only scan the queue when the watcher signals a change (or when no
        # kernel watcher is active and we fall back to periodic polling).
        # Avoid reading the directory on a plain timeout so that a queue on a
        # spinning disk is not woken up unnecessarily.
        if watcher.wait(POLL_INTERVAL):
            for req in check_queue():
                _handle_req(req)

        try:
            while True:
                _handle_msg(msgs.get_nowait())
        except _q.Empty:
            pass

if __name__ == '__main__':
    main()
