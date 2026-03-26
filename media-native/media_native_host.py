#!/usr/bin/env python3
"""
media_native_host.py — Native messaging host for the Media Viewer Firefox extension.

Serves local media files and directory listings to the viewer over a loopback
HTTP socket, generates thumbnails, and watches a platform queue directory for
open requests from media-open.

The three-thread event loop, inotify/kqueue/RDCW directory watching, and the
4-byte-LE-prefixed JSON wire protocol are all provided by viewer_host_utils.

HTTP server:
  Binds to 127.7.203.98:0 (OS-assigned random port).

  URL format:
    GET /<token>/media-file/<url-encoded-absolute-path>
        Serves the media file with appropriate Content-Type.
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
Open requests produce {"event":"open","dir":"...","file":"..."}.
"""

import sys, os, json, logging, secrets, threading, pathlib, stat
import urllib.parse
from http.server import HTTPServer
from socketserver import ThreadingMixIn

import thumbnailers
from thumbnailers import MIME_TYPES

from viewer_host_utils import cache_dir, BaseViewerHandler, send_message, run_host

_CACHE_DIR    = cache_dir('media-viewer')
QUEUE_DIR     = _CACHE_DIR / 'queue'
BIND_HOST     = '127.7.203.98'
TOKEN         = secrets.token_hex(64)   # 512 bits of entropy

_SERVABLE_EXTS = frozenset(MIME_TYPES)   # derived — MIME_TYPES is the single source of truth

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

class MediaHandler(BaseViewerHandler):

    def _dispatch(self, head_only):
        # Path: /<TOKEN>/<type>/<encoded-absolute-path>[?query]
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
            params    = urllib.parse.parse_qs(query_str)
            recursive = '1' in params.get('recursive', [])
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
        if ext not in _SERVABLE_EXTS:
            self._error(400, 'Not a supported image type')
            return
        if not os.path.isfile(file_path):
            self._error(404, 'File not found')
            return
        mime = MIME_TYPES.get(ext, 'application/octet-stream')
        self._serve_range_file(file_path, mime, head_only)

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
        if ext not in _SERVABLE_EXTS:
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

# ── HTTP server ────────────────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_http_server():
    server = ThreadedHTTPServer((BIND_HOST, 0), MediaHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]   # actual port assigned by OS

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


def _pre_start():
    _init_logging()
    thumbnailers.init()


def main():
    run_host(TOKEN, QUEUE_DIR, start_http_server, _handle_req, _handle_msg,
             pre_start=_pre_start)


if __name__ == '__main__':
    main()
