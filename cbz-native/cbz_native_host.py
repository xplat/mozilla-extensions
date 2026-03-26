#!/usr/bin/env python3
"""
cbz_native_host.py — Native messaging host for the CBZ Viewer Firefox extension.

Serves local CBZ/ZIP files to the viewer over a loopback HTTP socket and
watches a platform queue directory for open requests from cbz-open.

The three-thread event loop, inotify/kqueue/RDCW directory watching, and the
4-byte-LE-prefixed JSON wire protocol are all provided by viewer_host_utils.

HTTP server:
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
Open requests produce {"event":"open","path":"...","page":N,"name":"..."}.
"""

import os, secrets, threading, urllib.parse
from http.server import HTTPServer

from viewer_host_utils import cache_dir, BaseViewerHandler, send_message, run_host

QUEUE_DIR = cache_dir('cbz-viewer') / 'queue'
BIND_HOST = '127.7.203.66'
TOKEN     = secrets.token_hex(64)   # 512 bits of entropy

# ── HTTP file server ───────────────────────────────────────────────────────────

class CBZHandler(BaseViewerHandler):

    def _dispatch(self, head_only):
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

        self._serve_range_file(file_path, 'application/zip', head_only)


def start_http_server():
    server = HTTPServer((BIND_HOST, 0), CBZHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]   # actual port assigned by OS

# ── Dispatch ───────────────────────────────────────────────────────────────────

def _handle_req(req):
    path = req.get('path', '')
    page = int(req.get('page', 1))
    if os.path.isfile(path) and (path.lower().endswith('.cbz') or path.lower().endswith('.zip')):
        send_message({
            'event': 'open',
            'path':  path,
            'page':  page,
            'name':  os.path.basename(path),
        })


def _handle_msg(msg):
    if msg is not None and msg.get('cmd') == 'ping':
        send_message({'status': 'pong'})


def main():
    run_host(TOKEN, QUEUE_DIR, start_http_server, _handle_req, _handle_msg)


if __name__ == '__main__':
    main()
