#!/usr/bin/env python3
"""
cbz_native_host.py — Native messaging host for the CBZ Viewer Firefox extension.

Serves local CBZ/ZIP files to the viewer over a loopback HTTP socket and
watches a platform queue directory for open requests from cbz-open.

HTTP server binds to 127.7.203.66 (a fixed random loopback address — all of
127.0.0.0/8 is loopback on Linux/macOS, this specific address is unlikely to
conflict with anything real, and file paths won't leak off the machine even if
something goes wrong with the browser's redirect handling).

URL format: http://127.7.203.66:PORT/TOKEN/url-encoded-absolute-path
Supports Range requests.  Sends CORS headers permitting moz-extension:// origins.

Token generation, queue directory setup, logging, server lifecycle, wire
protocol, and the three-thread event loop are all handled by viewer_host_utils.
"""

import os, urllib.parse

from viewer_host_utils import BaseViewerHandler, send_message, run_host

BIND_HOST = '127.7.203.66'

# ── HTTP file server ───────────────────────────────────────────────────────────

class CBZHandler(BaseViewerHandler):

    def _dispatch(self, path_tail, head_only):
        # path_tail: url-encoded absolute file path (token already validated)
        try:
            file_path = urllib.parse.unquote(path_tail)
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


def main():
    run_host('cbz-viewer', BIND_HOST, CBZHandler, _handle_req)


if __name__ == '__main__':
    main()
