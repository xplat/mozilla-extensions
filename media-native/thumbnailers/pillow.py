"""Pillow-based thumbnail backend (last-resort fallback).

This module is only activated automatically when no native OS/desktop backend
is found.  It may also be selected explicitly via init(backend='pillow') for
hosts where the native stack is misconfigured.

To avoid polluting the XDG thumbnail cache with thumbnails that lack proper
XDG PNG metadata, PillowBackend uses its own cache root parallel to ~/.cache:

    ~/.cache/thumbnails-pillow/thumbnails/normal/<md5>.png

Pillow is imported at module level so that an ImportError propagates cleanly
to the caller's importlib.import_module() call, making the fallback logic in
the root get_backend() straightforward.
"""

import io
import os

from PIL import Image

from .xdg import XDGBackend, MIME_TYPES, _cache_home

_THUMB_SIZE = 128


class PillowBackend(XDGBackend):
    supports_preemptive_queueing = False
    _check_xdg_metadata          = False  # we write our own PNGs without XDG metadata
    cache_root                   = _cache_home() / 'thumbnails-pillow'

    def _generate(self, file_path, thumb, fail, timeout=30.0):
        """Generate a thumbnail with Pillow.
        Returns PNG bytes on success, None on failure."""
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in MIME_TYPES:
            return None
        try:
            buf = io.BytesIO()
            with Image.open(file_path) as img:
                img.thumbnail((_THUMB_SIZE, _THUMB_SIZE))
                img.save(buf, 'PNG')
        except Exception:
            return None
        data = buf.getvalue()
        self._cache_png(data, thumb)   # writes to file and creates parent dirs
        return data


def get_backend():
    return PillowBackend()
