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

On startup, sends {"event":"server","port":N,"token":"T"} so the extension
knows where to direct proxy requests.

Native messaging wire format: 4-byte LE length prefix + UTF-8 JSON.
"""

import sys, os, json, struct, secrets, threading, time, pathlib, select, stat
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

QUEUE_DIR     = pathlib.Path.home() / '.media-viewer' / 'queue'
POLL_INTERVAL = 0.5
BIND_HOST     = '127.7.203.98'
TOKEN         = secrets.token_hex(64)   # 512 bits of entropy

# Extensions served as image files (viewer can display these).
IMAGE_EXTS = frozenset([
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.avif', '.bmp', '.tiff', '.tif', '.svg', '.ico',
])

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
        st = entry.stat(follow_symlinks=False)
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
            if entry.is_dir(follow_symlinks=False):
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

    # ── Error helper ───────────────────────────────────────────────────────

    def _error(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_http_server():
    server = HTTPServer((BIND_HOST, 0), MediaHandler)
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
