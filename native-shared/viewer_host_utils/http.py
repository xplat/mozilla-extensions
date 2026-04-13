"""http.py — base HTTP request handler shared by both native messaging hosts.

Subclass BaseViewerHandler and implement _dispatch(path_tail, head_only).
run_host() sets handler_class.token before starting the server; _handle()
validates the token on every request and strips the /TOKEN/ prefix before
calling _dispatch, so subclasses never need to touch the token themselves.
"""

import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTP server that handles each request in its own daemon thread."""
    daemon_threads = True


class BaseViewerHandler(BaseHTTPRequestHandler):
    """Base handler: CORS, token validation, range-file serving, error responses.

    Class attributes set by run_host() before the server starts:
      token              — security token for validating requests
      extension_origin   — moz-extension://... origin (set by extension via register-origin)
      origin_ready       — threading.Event signaled when extension_origin is set

    Subclasses implement _dispatch(path_tail, head_only) where path_tail is
    self.path with the leading /TOKEN/ prefix already stripped and validated.
    """

    token = None   # set by run_host() before the server is created
    extension_origin = None   # set by extension via 'register-origin' message
    origin_ready = None   # threading.Event, signaled when extension_origin is set

    def log_message(self, fmt, *args):
        pass  # silence per-request stderr log

    def send_cors(self):
        if sys.platform == 'darwin':
            # macOS loopback restrictions cause cross-site redirects that reset Origin to null,
            # so registered origins won't be seen anyway. The token provides sufficient security.
            self.send_header('Access-Control-Allow-Origin', '*')
        elif self.extension_origin:
            # Use the origin that the extension registered via 'register-origin' message.
            self.send_header('Access-Control-Allow-Origin', self.extension_origin)
        # If not macOS and origin not registered, don't send CORS headers — let browser block.
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Access-Control-Expose-Headers',
                         'Content-Range, Accept-Ranges, Content-Length')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_HEAD(self):
        self._handle(head_only=True)

    def do_GET(self):
        self._handle(head_only=False)

    def _handle(self, head_only):
        # Path: /TOKEN/…  — validate the token, then dispatch.
        parts = self.path.split('/', 2)   # ['', TOKEN, rest]
        if len(parts) < 2 or parts[1] != self.token:
            self._error(403, 'Forbidden')
            return

        # Wait for extension to register its origin for CORS before responding.
        if self.origin_ready:
            self.origin_ready.wait()

        path_tail = parts[2] if len(parts) > 2 else ''
        self._dispatch(path_tail, head_only)

    def _dispatch(self, path_tail, head_only):
        """Override in subclass.  path_tail is self.path after the /TOKEN/ prefix."""
        raise NotImplementedError

    def _error(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_range_file(self, file_path: str, content_type: str,
                          head_only: bool) -> None:
        """Serve *file_path* with full HTTP Range support.

        The caller is responsible for validating that *file_path* exists and
        is an allowed type before calling this method.
        """
        file_size = os.path.getsize(file_path)
        start, end, partial = 0, file_size - 1, False

        rng = self.headers.get('Range', '')
        if rng.startswith('bytes='):
            try:
                s, e    = rng[6:].split('-', 1)
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

        self.send_response(206 if partial else 200)
        self.send_cors()
        self.send_header('Content-Type',   content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges',  'bytes')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.end_headers()
        if not head_only:
            self.wfile.write(data)
