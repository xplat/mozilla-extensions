"""host.py — common three-thread event-loop skeleton for native messaging hosts.

Both cbz_native_host and media_native_host share this structure:

  Thread 1 (queue-watcher) — watches a directory for open_*.json files and
    forwards them to the dispatch loop via a queue.Queue.
  Thread 2 (stdin-reader)  — reads native messages from stdin and forwards them.
  Main loop                — blocks on the queue and dispatches to callbacks.
    Ping/pong is handled automatically; the optional handle_msg_fn receives
    only non-ping messages.

Usage::

    from viewer_host_utils import BaseViewerHandler, run_host

    class MyHandler(BaseViewerHandler):
        def _dispatch(self, path_tail, head_only): ...

    def _handle_req(req): ...

    run_host('my-app', '127.7.203.x', MyHandler, _handle_req)
"""

import logging, secrets, threading, sys
import queue as _q
from .platform      import cache_dir
from .wire          import read_message, send_message
from .queue_watcher import QueueWatcher
from .queue         import check_queue
from .http          import ThreadedHTTPServer


def run_host(app_name, bind_host, handler_class, handle_req_fn,
             handle_msg_fn=None):
    """Start the native host's three-thread event loop and block until stdin closes.

    Automatically:
      - Opens a log file at cache_dir(app_name)/<app_name>_native_host.log
      - Creates the queue directory at cache_dir(app_name)/queue/
      - Generates a 512-bit token and sets handler_class.token
      - Starts a ThreadedHTTPServer on (bind_host, 0)
      - Sends {"event":"server","port":N,"token":"T"} to the extension
      - Handles ping → pong internally

    Platform-specific behavior:
      - On macOS: restricted loopback configuration forces binding to 127.0.0.1
        regardless of the requested bind_host. The actual bound address is
        available via server.server_address[0] after this function starts the server.

    Parameters
    ----------
    app_name       : str            — e.g. 'cbz-viewer'; drives cache dir + log name
    bind_host      : str            — loopback address for the HTTP server
    handler_class  : type           — BaseViewerHandler subclass
    handle_req_fn  : (dict) → None  — called for each open request from the queue
    handle_msg_fn  : optional (dict) → None — called for non-ping native messages
    """
    app_dir  = cache_dir(app_name)
    log_name = app_name.replace('-', '_') + '_native_host.log'
    log_path = app_dir / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(log_path),
        level=logging.WARNING,
        format='%(asctime)s %(levelname)-8s %(name)s: %(message)s',
        datefmt='%H:%M:%S',
    )

    queue_dir = app_dir / 'queue'
    queue_dir.mkdir(parents=True, exist_ok=True)

    token               = secrets.token_hex(64)   # 512 bits of entropy
    handler_class.token = token

    # Create an event that waits for the extension to register its origin for CORS
    origin_ready = threading.Event()
    handler_class.extension_origin = None
    handler_class.origin_ready     = origin_ready

    # macOS has restricted loopback configuration; always bind to 127.0.0.1 there
    if sys.platform == 'darwin':
        bind_host = '127.0.0.1'

    server = ThreadedHTTPServer((bind_host, 0), handler_class)
    threading.Thread(target=server.serve_forever, daemon=True,
                     name='http-server').start()
    host = server.server_address[0]
    port = server.server_address[1]

    send_message({'event': 'server', 'host': host, 'port': port, 'token': token})

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
            if item is not None and item.get('cmd') == 'register-origin':
                handler_class.extension_origin = item.get('origin')
                handler_class.origin_ready.set()
            elif item is not None and item.get('cmd') == 'ping':
                send_message({'status': 'pong'})
            elif handle_msg_fn is not None:
                handle_msg_fn(item)
