#!/usr/bin/env python3
"""
cbz_native_host.py — Native messaging host for the CBZ Viewer Firefox extension.

Firefox keeps this process alive as long as the extension holds a native port
open (extension calls browser.runtime.connectNative at startup). The host does
two jobs:

JOB 1 — File watching (push):
  Polls ~/.cbz-viewer/queue/ for JSON request files dropped by `cbz-open`.
  When one appears, sends {"event":"open","path":"...","page":1} to Firefox.
  Firefox extension then initiates a chunked read (Job 2) to load the file.

JOB 2 — Chunked file reading (pull):
  Extension sends {"cmd":"read","path":"...","offset":0,"length":N}
  Host responds {"status":"chunk","offset":0,"length":N,"data":"<base64>"}
  Extension reassembles chunks into a Blob and opens the viewer.
  Native messaging has a ~1MB practical per-message limit in Firefox;
  we cap chunks at 768KB raw (1MB base64) to stay well clear.

  Before reading, the extension sends {"cmd":"stat","path":"..."} to get the
  file size and name, so it can show progress and allocate the buffer.

All messages use the WebExtensions native messaging wire format:
  [4 bytes little-endian length][UTF-8 JSON payload]

Errors always return {"status":"error","message":"..."}.
"""

import sys
import os
import json
import struct
import base64
import time
import pathlib
import threading
import select

QUEUE_DIR = pathlib.Path.home() / '.cbz-viewer' / 'queue'
POLL_INTERVAL = 0.5   # seconds between queue checks
CHUNK_MAX = 768 * 1024  # 768 KB raw → ~1 MB base64

# ── Wire protocol ─────────────────────────────────────────────────────────────

def read_message_nonblocking(timeout=POLL_INTERVAL):
    """
    Read one native message with a timeout, returning None on timeout.
    Uses select() so we can also wake up to check the queue.
    """
    ready, _, _ = select.select([sys.stdin.buffer], [], [], timeout)
    if not ready:
        return None
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None  # EOF
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

def send_error(message):
    send_message({"status": "error", "message": message})

# ── Queue watcher ─────────────────────────────────────────────────────────────

def check_queue():
    """Return list of pending request dicts, removing the files."""
    if not QUEUE_DIR.exists():
        return []
    requests = []
    for f in sorted(QUEUE_DIR.glob('open_*.json')):
        try:
            req = json.loads(f.read_text())
            f.unlink()
            requests.append(req)
        except Exception:
            try:
                f.unlink()
            except Exception:
                pass
    return requests

# ── Command handlers ──────────────────────────────────────────────────────────

def handle_stat(msg):
    path = msg.get('path', '')
    if not os.path.isabs(path):
        send_error('Path must be absolute: ' + path)
        return
    if not path.lower().endswith('.cbz'):
        send_error('Not a .cbz file: ' + path)
        return
    if not os.path.isfile(path):
        send_error('File not found: ' + path)
        return
    try:
        size = os.path.getsize(path)
        send_message({
            "status": "ok",
            "size": size,
            "name": os.path.basename(path),
        })
    except OSError as e:
        send_error(str(e))

def handle_read(msg):
    path = msg.get('path', '')
    offset = int(msg.get('offset', 0))
    length = min(int(msg.get('length', CHUNK_MAX)), CHUNK_MAX)
    if not os.path.isfile(path):
        send_error('File not found: ' + path)
        return
    try:
        with open(path, 'rb') as f:
            f.seek(offset)
            data = f.read(length)
        send_message({
            "status": "chunk",
            "offset": offset,
            "length": len(data),
            "data": base64.b64encode(data).decode('ascii'),
        })
    except OSError as e:
        send_error(str(e))

# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)

    while True:
        # Check for queued open requests from cbz-open
        for req in check_queue():
            path = req.get('path', '')
            page = int(req.get('page', 1))
            if os.path.isfile(path) and path.lower().endswith('.cbz'):
                send_message({
                    "event": "open",
                    "path": path,
                    "page": page,
                    "name": os.path.basename(path),
                    "size": os.path.getsize(path),
                })

        # Check for a command from the extension (with timeout so we loop back
        # to check the queue even when Firefox is quiet)
        msg = read_message_nonblocking(timeout=POLL_INTERVAL)
        if msg is None:
            # Timeout or EOF — check if stdin closed (Firefox shut down)
            if sys.stdin.buffer.read(0) == b'' and not select.select([sys.stdin.buffer], [], [], 0)[0]:
                # stdin still open, just nothing to read — continue polling
                pass
            continue

        cmd = msg.get('cmd')
        if cmd == 'stat':
            handle_stat(msg)
        elif cmd == 'read':
            handle_read(msg)
        elif cmd == 'ping':
            send_message({"status": "pong"})
        else:
            send_error('Unknown command: ' + str(cmd))

if __name__ == '__main__':
    main()
