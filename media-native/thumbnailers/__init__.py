"""Platform-aware thumbnail generation for Linux desktops.

Public API used by media_native_host:

    init()                        detect desktop and start the right backend
    is_available() -> bool        True if a backend was successfully started
    request(file_path) -> bool    generate thumbnail; True when ready
    queue_preemptive(uris, mimes) background prefetch (no-op on some backends)
    thumb_path(file_path)         XDG 'normal' thumbnail path (pathlib.Path)
    is_valid(thumb_path, fp)      True if thumbnail is up-to-date for fp
    is_failed(fp)                 True if any XDG fail-cache entry exists
    file_uri(fp)                  GLib-compatible file:// URI for fp
"""

import os

from .xdg import (
    xdg_thumb_path  as thumb_path,
    is_thumb_valid  as is_valid,
    is_thumb_failed as is_failed,
    file_uri,
    MIME_TYPES,
)

_backend = None


def init():
    """Detect the running desktop environment and initialise the matching backend."""
    global _backend
    desktop = _detect_desktop()
    if desktop == 'xfce':
        try:
            import jeepney  # noqa: F401  # fast check before heavy import
            from . import xfce
            _backend = xfce.XfceBackend()
        except Exception:
            pass
    elif desktop == 'mate':
        try:
            from . import mate
            _backend = mate.MateBackend()
        except Exception:
            pass


def _detect_desktop():
    for var in ('XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION'):
        val = os.environ.get(var, '').upper()
        if 'XFCE' in val:
            return 'xfce'
        if 'MATE' in val:
            return 'mate'
    return None


def is_available():
    """True if a backend was successfully initialised."""
    return _backend is not None


def request(file_path):
    """Generate a thumbnail for file_path. Blocks until done or timed out.

    Returns True if the thumbnail is now available in the XDG cache.
    Returns False if generation failed or no backend is active.
    """
    return _backend.request(file_path) if _backend is not None else False


def queue_preemptive(uris, mimes):
    """Fire-and-forget background prefetch.

    uris  – list of file:// URIs
    mimes – parallel list of MIME type strings

    May be a no-op depending on the active backend.
    """
    if _backend is not None:
        _backend.queue_preemptive(uris, mimes)
