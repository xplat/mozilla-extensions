"""Tumbler-based thumbnail backend for XFCE (and other desktops that run Tumbler).

Tumbler is the org.freedesktop.thumbnails.Thumbnailer1 D-Bus service created
for XFCE.  Requests are batched over a short window, sent to Tumbler in one
Queue call, then a signal-listener thread receives Ready / Error / Finished
events and wakes the waiting per-URI slots.

Per-handle tracking (_handle_uris, _uri_handle, _handle_last_seen) is only
maintained for "live" batches (those with waiting threads).  Preemptive
directory-queue calls are fire-and-forget; their signals are silently ignored.

Handles that produce no signal activity for HANDLE_TIMEOUT seconds are GC'd
lazily at the start of each _flush(), failing any remaining waiting slots.
The timeout is intentionally long — its purpose is to prevent state from
bloating if Tumbler misbehaves, not to eagerly report errors.
"""

import os
import threading
import time
import urllib.parse

import jeepney
from jeepney import DBusAddress, new_method_call, HeaderFields, MessageType
from jeepney.io.blocking import open_dbus_connection

from . import XDGBackend, MIME_TYPES, file_uri


class _WaitSlot:
    __slots__ = ('event', 'success')

    def __init__(self):
        self.event   = threading.Event()
        self.success = False


class XfceBackend(XDGBackend):
    BATCH_WINDOW             = 0.05   # seconds to collect requests before flushing
    HANDLE_TIMEOUT           = 60.0   # seconds of signal inactivity before handle GC
    supports_preemptive_queueing = True

    def __init__(self):
        super().__init__()
        self._lock             = threading.Lock()
        self._pending          = {}  # uri -> [_WaitSlot, ...]
        self._handle_uris      = {}  # handle -> set(uri)   [live batches only]
        self._uri_handle       = {}  # uri -> handle         [live batches only]
        self._handle_last_seen = {}  # handle -> float       [live batches only]
        self._timer            = None
        self._conn             = None
        self._conn_lock        = threading.Lock()
        _start_signal_listener(self)

    # ── Public API ──────────────────────────────────────────────────────────

    def request(self, file_path, timeout=30.0):
        """Queue file_path with Tumbler; block until Ready/Error/timeout."""
        uri = file_uri(file_path)
        with self._lock:
            slot = _WaitSlot()
            if uri in self._pending:
                self._pending[uri].append(slot)
            else:
                self._pending[uri] = [slot]
                if self._timer is None:
                    self._timer = threading.Timer(self.BATCH_WINDOW, self._flush)
                    self._timer.daemon = True
                    self._timer.start()
        slot.event.wait(timeout)
        return slot.success

    def queue_preemptive(self, uris, mimes):
        """Fire-and-forget: send uris to Tumbler with scheduler='background'."""
        self._tumbler_queue(uris, mimes, 'background')

    # ── Signal callbacks (called from listener thread) ──────────────────────

    def on_ready(self, handle, uris):
        with self._lock:
            if handle in self._handle_last_seen:
                self._handle_last_seen[handle] = time.monotonic()
            for uri in uris:
                self._uri_handle.pop(uri, None)
                if handle in self._handle_uris:
                    self._handle_uris[handle].discard(uri)
                self._resolve_uri(uri, True)

    def on_error(self, handle, failed_uris):
        with self._lock:
            if handle in self._handle_last_seen:
                self._handle_last_seen[handle] = time.monotonic()
            for uri in failed_uris:
                self._uri_handle.pop(uri, None)
                if handle in self._handle_uris:
                    self._handle_uris[handle].discard(uri)
                self._resolve_uri(uri, False)

    def on_finished(self, handle):
        with self._lock:
            # Any URIs still outstanding on this handle were never signalled.
            for uri in self._handle_uris.pop(handle, set()):
                self._uri_handle.pop(uri, None)
                self._resolve_uri(uri, False)
            self._handle_last_seen.pop(handle, None)

    # ── Internal ────────────────────────────────────────────────────────────

    def _flush(self):
        with self._lock:
            self._gc_stale_handles()
            batch_uris = [u for u in self._pending if u not in self._uri_handle]
            self._timer = None

        if not batch_uris:
            return

        mimes = [
            MIME_TYPES.get(
                os.path.splitext(urllib.parse.unquote(u[7:]))[1].lower(),
                'application/octet-stream')
            for u in batch_uris
        ]

        handle = self._tumbler_queue(batch_uris, mimes, 'default')

        with self._lock:
            if handle is None:
                for uri in batch_uris:
                    self._resolve_uri(uri, False)
                return
            self._handle_uris[handle]      = set(batch_uris)
            self._handle_last_seen[handle] = time.monotonic()
            for uri in batch_uris:
                self._uri_handle[uri] = handle

    def _tumbler_queue(self, uris, mimes, scheduler):
        """Call Tumbler Queue via a persistent jeepney connection.
        Returns the uint32 handle on success, or None on failure."""
        with self._conn_lock:
            try:
                if self._conn is None:
                    self._conn = open_dbus_connection(bus='SESSION')
                addr  = DBusAddress(
                    '/org/freedesktop/thumbnails/Thumbnailer1',
                    bus_name='org.freedesktop.thumbnails.Thumbnailer1',
                    interface='org.freedesktop.thumbnails.Thumbnailer1',
                )
                msg   = new_method_call(addr, 'Queue', 'asasssu',
                                        (uris, mimes, 'normal', scheduler, 0))
                reply = self._conn.send_and_get_reply(msg, timeout=10)
                return reply.body[0]
            except Exception:
                self._conn = None
                return None

    def _resolve_uri(self, uri, success):
        """Called with _lock held."""
        for slot in self._pending.pop(uri, []):
            slot.success = success
            slot.event.set()

    def _gc_stale_handles(self):
        """Called with _lock held."""
        now   = time.monotonic()
        stale = [h for h, t in self._handle_last_seen.items()
                 if now - t > self.HANDLE_TIMEOUT]
        for handle in stale:
            for uri in self._handle_uris.pop(handle, set()):
                self._uri_handle.pop(uri, None)
                self._resolve_uri(uri, False)
            del self._handle_last_seen[handle]


def _start_signal_listener(backend):
    """Start a daemon thread that receives Tumbler D-Bus signals."""
    def _listener():
        try:
            conn = open_dbus_connection(bus='SESSION')

            # No sender= filter: Tumbler is D-Bus-activated on demand.  If
            # AddMatch fires before the first Queue call activates Tumbler,
            # the daemon does not yet know its unique bus name, and a
            # sender=well-known-name filter would silently match nothing.
            match_str = (
                "type='signal',"
                "interface='org.freedesktop.thumbnails.Thumbnailer1',"
                "path='/org/freedesktop/thumbnails/Thumbnailer1'"
            )
            dbus_addr = DBusAddress(
                '/org/freedesktop/DBus',
                bus_name='org.freedesktop.DBus',
                interface='org.freedesktop.DBus',
            )
            conn.send_and_get_reply(
                new_method_call(dbus_addr, 'AddMatch', 's', (match_str,))
            )

            while True:
                msg = conn.recv_message()
                if msg.header.message_type != MessageType.signal:
                    continue
                member = msg.header.fields.get(HeaderFields.member)
                try:
                    if member == 'Ready':
                        handle, uris = msg.body
                        backend.on_ready(handle, list(uris))
                    elif member == 'Error':
                        handle, failed_uris = msg.body[0], msg.body[1]
                        backend.on_error(handle, list(failed_uris))
                    elif member == 'Finished':
                        backend.on_finished(msg.body[0])
                except Exception:
                    pass
        except Exception:
            pass

    threading.Thread(target=_listener, daemon=True, name='tumbler-signals').start()


def get_backend():
    return XfceBackend()
