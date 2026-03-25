#!/usr/bin/env python3
"""
cbz_native_host.py — Native messaging host for the CBZ Viewer Firefox extension.

Runs two concurrent jobs:

JOB 1 — Queue watcher (main thread):
  Watches the platform queue directory for JSON files dropped by `cbz-open`.
  Uses inotify on Linux, kqueue on macOS, ReadDirectoryChangesW on Windows,
  and falls back to polling when none is available.
  Sends {"event":"open","path":"...","page":N,"name":"..."} to the extension.

JOB 2 — HTTP file server (background thread):
  Binds to 127.7.203.66 (a fixed random loopback address — all of 127.0.0.0/8
  is loopback on Linux/macOS, this specific address is unlikely to conflict
  with anything, and file paths won't leak off the machine even if something
  goes wrong with the browser's redirect handling).
  Uses a 512-bit random token in every URL path to prevent other local
  processes from accessing files even if they can reach the socket.
  URL format: http://127.7.203.66:PORT/TOKEN/url-encoded-absolute-path
  Supports Range requests identically to HTTP/1.1.
  Sends CORS headers permitting requests from moz-extension:// origins.

On startup, sends {"event":"server","port":N,"token":"T"} as the first
native message so the extension knows where to direct the viewer.

Native messaging wire format: 4-byte LE length prefix + UTF-8 JSON.
"""

import sys, os, json, struct, secrets, threading, time, pathlib, select
import queue as _q
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

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

QUEUE_DIR     = _platform_cache_dir('cbz-viewer') / 'queue'
POLL_INTERVAL = 0.5
BIND_HOST     = '127.7.203.66'
TOKEN         = secrets.token_hex(64)   # 512 bits entropy

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

            GENERIC_READ           = 0x80000000
            FILE_SHARE_ALL         = 0x07
            OPEN_EXISTING          = 3
            FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
            FILE_NOTIFY_CHANGE_FILE_NAME = 0x0001
            INVALID_HANDLE_VALUE   = ctypes.c_void_p(-1).value

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
                            False,                          # bWatchSubtree
                            FILE_NOTIFY_CHANGE_FILE_NAME,   # dwNotifyFilter
                            ctypes.byref(returned),
                            None,                           # lpOverlapped
                            None,                           # lpCompletionRoutine
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

# ── HTTP file server ───────────────────────────────────────────────────────────

class CBZHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # silence access log

    def send_cors(self):
        origin = self.headers.get('Origin', '')
        if origin.startswith('moz-extension://') or origin.startswith('chrome-extension://'):
            self.send_header('Access-Control-Allow-Origin', origin)
        else:
            self.send_header('Access-Control-Allow-Origin', 'null')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Access-Control-Expose-Headers',
                         'Content-Range, Accept-Ranges, Content-Length')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_HEAD(self):
        self._serve(head_only=True)

    def do_GET(self):
        self._serve(head_only=False)

    def _serve(self, head_only):
        # Path: /TOKEN/url-encoded-absolute-file-path
        parts = self.path.split('/', 2)   # ['', TOKEN, encoded-path]
        if len(parts) < 3 or parts[1] != TOKEN:
            self._error(403, 'Forbidden')
            return

        try:
            file_path = urllib.parse.unquote(parts[2])
        except Exception:
            self._error(400, 'Bad path encoding')
            return

        if not os.path.isabs(file_path):
            file_path = '/' + file_path
        file_path = os.path.normpath(file_path)
        if not file_path.lower().endswith('.cbz') and not file_path.lower().endswith('.zip'):
            self._error(400, 'Not a .cbz file')
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
            except Exception:
                self._error(416, 'Range Not Satisfiable')
                return

        length = end - start + 1
        data = b''
        if not head_only:
            try:
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    data = f.read(length)
            except OSError as exc:
                self._error(500, str(exc))
                return

        self.send_response(206 if partial else 200)
        self.send_cors()
        self.send_header('Content-Type',   'application/zip')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges',  'bytes')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def _error(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_http_server():
    server = HTTPServer((BIND_HOST, 0), CBZHandler)
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
            try: f.unlink()
            except Exception: pass
    return reqs

# ── Main ───────────────────────────────────────────────────────────────────────

def _handle_req(req):
    path = req.get('path', '')
    page = int(req.get('page', 1))
    if os.path.isfile(path) and (path.lower().endswith('.cbz') or path.lower().endswith('.zip')):
        send_message({
            "event": "open",
            "path":  path,
            "page":  page,
            "name":  os.path.basename(path),
        })

def main():
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    watcher = _QueueWatcher(QUEUE_DIR)
    port = start_http_server()
    send_message({"event": "server", "port": port, "token": TOKEN})

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
                msg = msgs.get_nowait()
                if msg.get('cmd') == 'ping':
                    send_message({"status": "pong"})
        except _q.Empty:
            pass

if __name__ == '__main__':
    main()
