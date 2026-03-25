#!/usr/bin/env python3
"""
cbz_native_host.py — Native messaging host for the CBZ Viewer Firefox extension.

Runs two concurrent jobs:

JOB 1 — Queue watcher (main thread):
  Watches the platform queue directory for JSON files dropped by `cbz-open`.
  Uses inotify on Linux, kqueue on macOS, and falls back to polling elsewhere.
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

# ── Queue watcher (inotify / kqueue / polling fallback) ────────────────────────

class _QueueWatcher:
    """
    Watch a directory for new files using the best available kernel API.

      Linux  → inotify   (via ctypes / libc)
      macOS  → kqueue    (via Python's select module)
      other  → polling fallback (no fd)

    If .available is True, .fileno() returns an fd that becomes readable in
    select() when files appear in the watched directory.  Call .drain() after
    select() fires to consume the pending kernel events.  Call .close() to
    release OS resources when done.
    """

    def __init__(self, path: pathlib.Path):
        self._fd     = -1
        self._dir_fd = -1   # kqueue only: open fd for the watched directory
        self._kq     = None # kqueue object (macOS)
        if sys.platform == 'linux':
            self._setup_inotify(path)
        elif sys.platform == 'darwin':
            self._setup_kqueue(path)
        # Windows / other: leave _fd = -1, caller falls back to polling

    def _setup_inotify(self, path):
        try:
            import ctypes
            _libc = ctypes.CDLL(None, use_errno=True)
            fd = _libc.inotify_init()
            if fd < 0:
                return
            IN_CLOSE_WRITE = 0x00000008
            IN_MOVED_TO    = 0x00000080
            IN_CREATE      = 0x00000100
            mask = IN_CLOSE_WRITE | IN_MOVED_TO | IN_CREATE
            wd = _libc.inotify_add_watch(
                fd, str(path).encode(), ctypes.c_uint32(mask)
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

    @property
    def available(self):
        return self._fd >= 0

    def fileno(self):
        return self._fd

    def drain(self):
        """Consume pending kernel events so the fd does not stay readable."""
        if self._kq is not None:
            try:
                self._kq.control([], 8, 0)
            except OSError:
                pass
        elif self._fd >= 0:
            try:
                os.read(self._fd, 4096)
            except OSError:
                pass

    def close(self):
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
        self._kq = None

# ── Wire protocol ──────────────────────────────────────────────────────────────

def _read_message():
    """Read one native message from stdin (caller must ensure stdin is readable)."""
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

def _handle_msg(msg):
    if msg is not None and msg.get('cmd') == 'ping':
        send_message({"status": "pong"})

def main():
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    port = start_http_server()
    send_message({"event": "server", "port": port, "token": TOKEN})

    if sys.platform == 'win32':
        # Windows: select() does not work on pipes, so use a reader thread.
        import queue as _q
        _msgs = _q.Queue()

        def _reader():
            while True:
                m = _read_message()
                if m is None:
                    return
                _msgs.put(m)

        threading.Thread(target=_reader, daemon=True).start()

        while True:
            for req in check_queue():
                _handle_req(req)
            time.sleep(POLL_INTERVAL)
            try:
                while True:
                    _handle_msg(_msgs.get_nowait())
            except _q.Empty:
                pass

    else:
        # Unix: use select() on stdin + optional kernel file-watch fd.
        watcher    = _QueueWatcher(QUEUE_DIR)
        select_in  = [sys.stdin.buffer]
        if watcher.available:
            select_in.append(watcher.fileno())

        while True:
            ready, _, _ = select.select(select_in, [], [], POLL_INTERVAL)
            watch_fd    = watcher.fileno()

            if watcher.available and watch_fd in ready:
                # Kernel notified us: drain events and check queue immediately.
                watcher.drain()
                for req in check_queue():
                    _handle_req(req)
            elif not ready:
                # Timeout: polling fallback (also catches missed events).
                for req in check_queue():
                    _handle_req(req)

            if sys.stdin.buffer in ready:
                _handle_msg(_read_message())

if __name__ == '__main__':
    main()
