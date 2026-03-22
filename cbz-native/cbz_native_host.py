#!/usr/bin/env python3
"""
cbz_native_host.py — Native messaging host for the CBZ Viewer Firefox extension.

Runs two concurrent jobs:

JOB 1 — Queue watcher (main thread):
  Polls ~/.cbz-viewer/queue/ for JSON files dropped by `cbz-open`.
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

QUEUE_DIR     = pathlib.Path.home() / '.cbz-viewer' / 'queue'
POLL_INTERVAL = 0.5
BIND_HOST     = '127.7.203.66'
TOKEN         = secrets.token_hex(64)   # 512 bits entropy

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
        if not file_path.lower().endswith('.cbz'):
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
        self.send_header('Content-Length', str(len(data)))
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

def main():
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    port = start_http_server()
    send_message({"event": "server", "port": port, "token": TOKEN})

    while True:
        for req in check_queue():
            path = req.get('path', '')
            page = int(req.get('page', 1))
            if os.path.isfile(path) and path.lower().endswith('.cbz'):
                send_message({
                    "event": "open",
                    "path":  path,
                    "page":  page,
                    "name":  os.path.basename(path),
                })

        msg = read_message_nonblocking()
        if msg is None:
            continue
        if msg.get('cmd') == 'ping':
            send_message({"status": "pong"})

if __name__ == '__main__':
    main()
