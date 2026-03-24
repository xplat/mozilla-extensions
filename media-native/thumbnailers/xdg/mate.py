"""Caja-based thumbnail backend for MATE.

MATE's file manager (Caja) defines a thumbnailer registry through small
INI-style .thumbnailer files in /usr/share/thumbnailers.  Each file lists
one or more MIME types and a command template to invoke.

Format:
    [Thumbnailer Entry]
    TryExec=/usr/bin/some-thumbnailer   # optional: skip if binary not found
    Exec=/usr/bin/some-thumbnailer %s %u %o
    MimeType=image/jpeg;image/png;video/*;

Format codes in Exec:
    %s  largest side in pixels (128 for the XDG 'normal' size)
    %u  URI of the input file
    %i  file path of the input file (alternative to %u used by some tools)
    %o  output file path (where to write the PNG thumbnail)
    %%  literal percent sign

An inotify watch on /usr/share/thumbnailers triggers a reload whenever a
.thumbnailer file is installed or removed.

Prefetch (queue_preemptive) is a no-op: running multiple thumbnailer
subprocesses speculatively is too expensive without a proper scheduler.
"""

import configparser
import ctypes
import os
import re
import select
import shlex
import shutil
import struct
import subprocess
import threading

from . import XDGBackend, MIME_TYPES, file_uri

_THUMBNAILERS_DIR   = '/usr/share/thumbnailers'
_THUMB_SIZE         = 128   # XDG 'normal' thumbnail size in pixels

# Only register handlers for MIME types we can actually request.
_SUPPORTED_MIMES    = frozenset(MIME_TYPES.values())
_SUPPORTED_PREFIXES = frozenset(m.split('/')[0] for m in MIME_TYPES.values())

# inotify event masks
_IN_CLOSE_WRITE = 0x00000008
_IN_CREATE      = 0x00000100
_IN_DELETE      = 0x00000200
_IN_MOVED_FROM  = 0x00000040
_IN_MOVED_TO    = 0x00000080
_WATCH_MASK     = (_IN_CLOSE_WRITE | _IN_CREATE | _IN_DELETE |
                   _IN_MOVED_FROM  | _IN_MOVED_TO)

_libc = ctypes.CDLL(None, use_errno=True)   # default C library (glibc on Linux)


class MateBackend(XDGBackend):

    def __init__(self):
        super().__init__()
        self._lock     = threading.Lock()
        self._handlers = {}   # mime_type / mime_prefix -> exec_str
        self._load_thumbnailers()
        self._start_watcher()

    # ── Public API ──────────────────────────────────────────────────────────

    def _generate(self, file_path, thumb, fail, timeout=30.0):
        """Run the appropriate thumbnailer for file_path.
        Returns PNG bytes on success, None on failure."""
        ext  = os.path.splitext(file_path)[1].lower()
        mime = MIME_TYPES.get(ext)
        if mime is None:
            return None

        with self._lock:
            exec_str = self._handlers.get(mime) or self._wildcard_exec(mime)
        if exec_str is None:
            return None

        thumb.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if _run_thumbnailer(exec_str, _THUMB_SIZE, file_path, thumb, timeout):
            return self._slurp(thumb)
        return None

    # queue_dir: inherited no-op from XDGBackend

    # ── Internal ────────────────────────────────────────────────────────────

    def _wildcard_exec(self, mime):
        """Return exec_str for a wildcard pattern like 'image/*'. Lock held."""
        prefix = mime.split('/')[0] + '/*'
        return self._handlers.get(prefix)

    def _load_thumbnailers(self):
        handlers = {}
        try:
            for entry in os.scandir(_THUMBNAILERS_DIR):
                if not entry.name.endswith('.thumbnailer'):
                    continue
                result = _parse_thumbnailer_file(entry.path)
                if result is None:
                    continue
                exec_str, mimes = result
                for m in mimes:
                    # Skip MIME types we can never request.
                    if m.endswith('/*'):
                        if m[:-2] not in _SUPPORTED_PREFIXES:
                            continue
                    elif m not in _SUPPORTED_MIMES:
                        continue
                    # Last-wins if multiple files claim the same MIME type.
                    handlers[m] = exec_str
        except OSError:
            pass
        with self._lock:
            self._handlers = handlers

    def _start_watcher(self):
        """Watch _THUMBNAILERS_DIR with inotify and reload on any change."""
        backend = self

        def _watcher():
            try:
                fd = _libc.inotify_init()
                if fd < 0:
                    return
                wd = _libc.inotify_add_watch(
                    fd,
                    _THUMBNAILERS_DIR.encode(),
                    ctypes.c_uint32(_WATCH_MASK),
                )
                if wd < 0:
                    os.close(fd)
                    return
                while True:
                    r, _, _ = select.select([fd], [], [], 300.0)
                    if not r:
                        continue
                    buf     = os.read(fd, 4096)
                    changed = False
                    offset  = 0
                    while offset + 16 <= len(buf):
                        _, _, _, name_len = struct.unpack_from('iIII', buf, offset)
                        offset += 16
                        name    = buf[offset:offset + name_len].rstrip(b'\x00')
                        offset += name_len
                        if name.endswith(b'.thumbnailer'):
                            changed = True
                    if changed:
                        backend._load_thumbnailers()
            except Exception:
                pass

        threading.Thread(target=_watcher, daemon=True,
                         name='mate-thumbnailer-watcher').start()


# ── Module-level helpers ────────────────────────────────────────────────────────

def _parse_thumbnailer_file(path):
    """Parse a .thumbnailer INI file.

    Returns (exec_str, [mime_type, ...]) or None if the file is invalid,
    missing mandatory fields, or TryExec points to a non-existent binary.
    """
    try:
        cfg = configparser.RawConfigParser()
        cfg.read(path, encoding='utf-8')
        sec = 'Thumbnailer Entry'
        if not cfg.has_section(sec):
            return None
        exec_str   = cfg.get(sec, 'Exec',     fallback='').strip()
        try_exec   = cfg.get(sec, 'TryExec',  fallback='').strip()
        mime_field = cfg.get(sec, 'MimeType', fallback='').strip()
        if not exec_str:
            return None
        if try_exec and not shutil.which(try_exec):
            return None
        mimes = [m.strip() for m in mime_field.split(';') if m.strip()]
        return exec_str, mimes
    except Exception:
        return None


def _build_command(exec_str, size, input_uri, input_path, output_path):
    """Split exec_str into tokens, then substitute format codes within each word.

    Splitting before substitution means paths with spaces are never broken
    across multiple arguments.  re.sub with a lambda handles all codes in
    one pass, including %% → % within a longer token.
    """
    codes = {'%%': '%', '%s': str(size), '%u': input_uri,
             '%i': input_path, '%o': output_path}
    return [re.sub(r'%%|%[suio]', lambda m: codes[m.group()], token)
            for token in shlex.split(exec_str)]


def _run_thumbnailer(exec_str, size, input_path, thumb_path, timeout):
    """Run the thumbnailer command. Returns True if the output PNG was written."""
    try:
        uri = file_uri(input_path)
        cmd = _build_command(exec_str, size, uri, input_path, str(thumb_path))
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
        )
        return result.returncode == 0 and thumb_path.exists()
    except Exception:
        return False


def get_backend():
    return MateBackend()
