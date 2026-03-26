"""queue_watcher.py — kernel-assisted directory watcher with polling fallback.

Supports inotify (Linux), kqueue (macOS), ReadDirectoryChangesW (Windows),
and a timed-sleep fallback for anything else.
"""

import sys, os, select, threading, time, pathlib

POLL_INTERVAL = 0.5   # seconds between scans when no kernel API is available


class QueueWatcher:
    """
    Watch a directory for new files.  Call .wait() to block until an event
    fires (kernel API) or one poll interval elapses (polling fallback), then
    scan the directory for new entries.

      Linux   → inotify via ctypes/libc
      macOS   → kqueue  via Python's select module
      Windows → ReadDirectoryChangesW via ctypes in a daemon thread
      other   → periodic sleep (polling fallback)

    All OS resources are released on .close().
    """

    def __init__(self, path: pathlib.Path):
        self._fd      = -1    # inotify fd  (Linux)
        self._dir_fd  = -1    # kqueue: open fd for the watched directory
        self._kq      = None  # kqueue object (macOS)
        self._event   = None  # threading.Event signalled by RDCW thread (Windows)

        if sys.platform == 'linux':
            self._setup_inotify(path)
        elif sys.platform == 'darwin':
            self._setup_kqueue(path)
        elif sys.platform == 'win32':
            self._setup_rdcw(path)
        # other: all fields stay at defaults → pure sleep fallback

    # ── Setup ──────────────────────────────────────────────────────────────────

    def _setup_inotify(self, path):
        try:
            import ctypes
            _libc = ctypes.CDLL(None, use_errno=True)
            fd = _libc.inotify_init()
            if fd < 0:
                return
            # IN_MOVED_TO fires when a rename lands in the directory — exactly
            # what our atomic write (write .tmp then rename to .json) produces.
            # IN_CREATE fires on the initial creation of the .tmp file, before
            # any content is written, so we deliberately omit it.
            IN_MOVED_TO = 0x00000080
            wd = _libc.inotify_add_watch(
                fd, str(path).encode(), ctypes.c_uint32(IN_MOVED_TO)
            )
            if wd < 0:
                os.close(fd)
                return
            self._fd = fd
        except Exception:
            pass

    def _setup_kqueue(self, path):
        try:
            kq     = select.kqueue()
            dir_fd = os.open(str(path), os.O_RDONLY)
            ev     = select.kevent(
                dir_fd,
                filter=select.KQ_FILTER_VNODE,
                flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND,
            )
            kq.control([ev], 0)
            self._kq     = kq
            self._dir_fd = dir_fd
            self._fd     = kq.fileno()
        except Exception:
            pass

    def _setup_rdcw(self, path):
        try:
            import ctypes
            import ctypes.wintypes as _wt
            _k32 = ctypes.windll.kernel32

            GENERIC_READ               = 0x80000000
            FILE_SHARE_ALL             = 0x07
            OPEN_EXISTING              = 3
            FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
            FILE_NOTIFY_CHANGE_FILE_NAME = 0x0001
            INVALID_HANDLE_VALUE       = ctypes.c_void_p(-1).value

            hDir = _k32.CreateFileW(
                str(path),
                GENERIC_READ,
                FILE_SHARE_ALL,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
            if hDir == INVALID_HANDLE_VALUE or hDir is None:
                return

            ev = threading.Event()
            self._event = ev

            buf      = ctypes.create_string_buffer(4096)
            returned = _wt.DWORD(0)

            def _watch():
                try:
                    while True:
                        ok = _k32.ReadDirectoryChangesW(
                            hDir, buf, len(buf),
                            False,                           # bWatchSubtree
                            FILE_NOTIFY_CHANGE_FILE_NAME,    # dwNotifyFilter
                            ctypes.byref(returned),
                            None,                            # lpOverlapped
                            None,                            # lpCompletionRoutine
                        )
                        if ok:
                            ev.set()
                        else:
                            break  # handle closed or error
                finally:
                    _k32.CloseHandle(hDir)

            threading.Thread(target=_watch, daemon=True,
                             name='rdcw-watcher').start()
        except Exception:
            pass

    # ── Public API ─────────────────────────────────────────────────────────────

    def wait(self):
        """Block until a directory-change event fires.

        With a kernel API (inotify / kqueue / RDCW) this blocks indefinitely
        and returns only when the OS delivers a notification, so the calling
        thread consumes no CPU and negligible RSS while idle.

        Without a kernel API the call sleeps for POLL_INTERVAL and returns,
        allowing the caller to scan the directory periodically.
        """
        if self._event is not None:
            # Windows RDCW: block until the watcher thread sets the event.
            self._event.wait()
            self._event.clear()
        elif self._kq is not None:
            # macOS kqueue: omitting the timeout blocks indefinitely.
            try:
                self._kq.control([], 8)
            except OSError:
                pass
        elif self._fd >= 0:
            # Linux inotify: None timeout blocks indefinitely; drain on wake.
            try:
                r, _, _ = select.select([self._fd], [], [], None)
                if r:
                    os.read(self._fd, 4096)
            except OSError:
                pass
        else:
            # No kernel API: sleep one poll interval, then let the caller scan.
            time.sleep(POLL_INTERVAL)

    def close(self):
        """Release OS resources (kqueue and inotify fds; RDCW cleans itself up)."""
        if self._kq is not None:
            try: self._kq.close()
            except OSError: pass
        if self._dir_fd >= 0:
            try: os.close(self._dir_fd)
            except OSError: pass
        elif self._fd >= 0:
            try: os.close(self._fd)
            except OSError: pass
        self._fd = self._dir_fd = -1
        self._kq = self._event = None
