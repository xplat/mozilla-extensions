"""host.py — common three-thread event-loop skeleton for native messaging hosts.

Both cbz_native_host and media_native_host share this structure:

  Thread 1 (queue-watcher) — watches a directory for open_*.json files and
    forwards them to the dispatch loop via a queue.Queue.
  Thread 2 (stdin-reader)  — reads native messages from stdin and forwards them.
  Main loop                — blocks on the queue and dispatches to callbacks.

Usage::

    from viewer_host_utils import run_host

    def _handle_req(req): ...
    def _handle_msg(msg): ...

    run_host(TOKEN, QUEUE_DIR, start_http_server, _handle_req, _handle_msg)
"""

import threading
import queue as _q
from .wire import read_message, send_message
from .queue_watcher import QueueWatcher
from .queue import check_queue


def run_host(token, queue_dir, start_server_fn, handle_req_fn, handle_msg_fn,
             pre_start=None):
    """Start the native host's three-thread event loop and block until stdin closes.

    Parameters
    ----------
    token           : str          — 512-bit hex token for the local HTTP server
    queue_dir       : pathlib.Path — directory to watch for open_*.json requests
    start_server_fn : () → int     — starts the HTTP server, returns the bound port
    handle_req_fn   : (dict) → None — called for each open request from the queue
    handle_msg_fn   : (dict) → None — called for each incoming native message
    pre_start       : optional () → None — called first (logging init, thumbnailer
                      init, etc.) before the queue directory is created
    """
    if pre_start is not None:
        pre_start()
    queue_dir.mkdir(parents=True, exist_ok=True)
    port = start_server_fn()
    send_message({'event': 'server', 'port': port, 'token': token})

    work_q = _q.Queue()

    def _watcher():
        """Scan queue dir on kernel events (or periodically when polling)."""
        watcher = QueueWatcher(queue_dir)
        for req in check_queue(queue_dir):          # startup scan
            work_q.put(('open', req))
        while True:
            watcher.wait()                          # blocks until event (or POLL_INTERVAL)
            for req in check_queue(queue_dir):
                work_q.put(('open', req))

    def _stdin_reader():
        """Forward native messages from stdin to the work queue."""
        while True:
            m = read_message()
            if m is None:
                return
            work_q.put(('msg', m))

    threading.Thread(target=_watcher,      daemon=True, name='queue-watcher').start()
    threading.Thread(target=_stdin_reader, daemon=True, name='stdin-reader').start()

    while True:
        kind, item = work_q.get()   # blocks indefinitely; no periodic wakeups
        if kind == 'open':
            handle_req_fn(item)
        elif kind == 'msg':
            handle_msg_fn(item)
