"""Platform-aware thumbnail generation.

Public API used by media_native_host:

    init(backend=None)            detect OS/desktop and start the right backend;
                                  pass backend='pillow' (or any module name) to
                                  override auto-detection (e.g. if XDG is broken)
    is_available() -> bool        True if a real (non-null) backend was started
    request(file_path) -> bytes|None  fetch/generate thumbnail PNG bytes; None on failure
    queue_dir(dir_path)           background-queue all unresolved images in a directory
                                  (no-op on backends that don't support preemptive queueing)
    MIME_TYPES                    dict mapping file extension to MIME type string

Backend selection order (auto-detection):
  1. OS-specific module keyed on sys.platform:
       linux   → linux.py  → XDG desktop detection (Tumbler on XFCE, …)
       darwin  → darwin.py → qlmanage (Quick Look)
       win32   → win32.py  → IShellItemImageFactory via COM + GDI
  2. Pillow fallback, if no native backend found or available
  3. NullBackend – generates nothing but still serves any thumbnail already
     present in the XDG cache (e.g. one written by Nautilus or Tumbler)
"""

import importlib
import re
import sys

from ._base import Backend, MIME_TYPES
from .xdg import XDGBackend


# ── NullBackend ─────────────────────────────────────────────────────────────────

class _NullBackend(XDGBackend):
    """Returned when no real backend can be initialised.

    Cache-path helpers are inherited from XDGBackend, so any thumbnail already
    in the XDG cache (written by another tool) will still be served.
    _generate() always returns None, so no new thumbnails are produced.
    """
    available = False

    def _generate(self, file_path, thumb, fail, timeout=30.0):
        return None


# ── Module state ────────────────────────────────────────────────────────────────

_backend: Backend = _NullBackend()


# ── Initialisation ──────────────────────────────────────────────────────────────

def _sanitize_name(name):
    """Strip non-alphanumeric chars and lowercase; safe as a Python module name."""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def get_backend(explicit=None):
    """Return the best available backend instance; never returns None."""
    if explicit is not None:
        sanitized = _sanitize_name(explicit)
        try:
            mod = importlib.import_module(f'.{sanitized}', package=__name__)
            b   = mod.get_backend()
            if b is not None:
                return b
        except Exception:
            pass
        return _NullBackend()

    platform = _sanitize_name(sys.platform)
    try:
        mod = importlib.import_module(f'.{platform}', package=__name__)
        b   = mod.get_backend()
        if b is not None:
            return b
    except Exception:
        pass

    # No native backend found – try Pillow as a last resort before giving up.
    try:
        from . import pillow
        b = pillow.get_backend()
        if b is not None:
            return b
    except Exception:
        pass

    return _NullBackend()


def init(backend=None):
    """Detect the running environment and initialise the matching backend.

    backend – optional name of a specific backend module (e.g. 'pillow').
              Useful when native thumbnailing is available but misconfigured.
    """
    global _backend
    _backend = get_backend(explicit=backend)


# ── Public API ──────────────────────────────────────────────────────────────────

def is_available():
    """True if a real (non-null) backend was successfully initialised."""
    return _backend.available


def request(file_path):
    """Fetch or generate a thumbnail for file_path.
    Returns PNG bytes on success, None on failure."""
    return _backend.request(file_path)


def queue_dir(dir_path):
    """Scan dir_path and schedule unresolved images for background thumbnailing.

    Delegates to the active backend's queue_dir(); a no-op on backends that
    do not support preemptive queueing.
    """
    _backend.queue_dir(dir_path)
