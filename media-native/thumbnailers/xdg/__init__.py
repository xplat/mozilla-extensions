"""XDG thumbnail cache backend: shared utilities, base class, and desktop detection.

Desktop environment is determined in priority order:

  1. XDG_CURRENT_DESKTOP  – spec-standard; split on ':', exact string match after
                            sanitisation, first supported entry wins.  If set at
                            all but no supported desktop is found, returns None
                            (caller treats this as "unsupported desktop" and falls
                            back to Pillow; the other variables are NOT consulted).

  2. XDG_SESSION_DESKTOP  – non-standard fallback; substring search across the
  3. DESKTOP_SESSION        available backend modules in this package.

Submodules (xfce.py, mate.py, …) each provide a get_backend() function and
a backend class that inherits XDGBackend.  Dynamic importlib dispatch means
no if-chains are needed here when new desktops are added.
"""

import hashlib
import importlib
import os
import pathlib
import re
import urllib.parse


# ── Cache root helpers ──────────────────────────────────────────────────────────

def _cache_home():
    raw = os.environ.get('XDG_CACHE_HOME', '').strip()
    return pathlib.Path(raw) if raw else pathlib.Path.home() / '.cache'


# ── MIME types for thumbnail-eligible files ─────────────────────────────────────

MIME_TYPES = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp':  'image/bmp',
    '.tiff': 'image/tiff',
    '.tif':  'image/tiff',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
}


# ── URI / path helpers ──────────────────────────────────────────────────────────

def file_uri(file_path):
    """Return a file:// URI using GLib-compatible percent-encoding.

    pathlib.Path.as_uri() encodes '+' as '%2B', but GLib/GIO (Nautilus,
    Tumbler, Caja, …) treats '+' as an allowed sub-delimiter in URI path
    components and leaves it bare.  Using different encoding produces a
    different MD5 and therefore a different XDG thumbnail cache key.
    The safe= set below matches GLib's behaviour (RFC 3986 sub-delimiters
    plus ':' '@' '/').
    """
    return 'file://' + urllib.parse.quote(file_path, safe="/:@!$&'()*+,;=")


# ── XDGBackend ──────────────────────────────────────────────────────────────────

class XDGBackend:
    """Base class for thumbnail backends that use an XDG-style on-disk cache.

    Subclasses must implement request().  Class-level overrides:

      cache_root            pathlib.Path or None.  None → use ~/.cache (or
                            $XDG_CACHE_HOME).  Set to a different root to keep
                            thumbnails in a separate directory (e.g. Pillow).

      _check_xdg_metadata   Set to False to skip PIL-based Thumb::MTime
                            validation.  Use this for backends whose native
                            tool does not embed XDG PNG extension blocks
                            (e.g. Darwin's qlmanage).
    """

    available                    = True
    supports_preemptive_queueing = False
    cache_root                   = None   # override as a class attribute in subclass
    _check_xdg_metadata          = True

    def __init__(self):
        if self._check_xdg_metadata:
            try:
                from PIL import Image as _PILImage
                self._pil = _PILImage
            except ImportError:
                self._pil = None
        else:
            self._pil = None

    # ── Cache path helpers ────────────────────────────────────────────────

    def _thumb_root(self):
        return self.cache_root if self.cache_root is not None else _cache_home()

    def thumb_path(self, file_path):
        """Return the cache path for the 'normal' (128 px) thumbnail of file_path."""
        uri = file_uri(file_path)
        md5 = hashlib.md5(uri.encode()).hexdigest()
        return self._thumb_root() / 'thumbnails' / 'normal' / (md5 + '.png')

    def is_valid(self, thumb_path, file_path):
        """True if the cached thumbnail is current for file_path."""
        try:
            file_mtime = int(os.path.getmtime(file_path))
            if self._pil is not None:
                try:
                    with self._pil.open(str(thumb_path)) as img:
                        meta = int(img.text.get('Thumb::MTime', '0'))
                    if meta > 0:
                        return meta >= file_mtime
                except Exception:
                    pass
            return int(os.path.getmtime(str(thumb_path))) >= file_mtime
        except OSError:
            return False

    def is_failed(self, file_path):
        """True if any XDG fail-cache entry exists for file_path."""
        fail_base = self._thumb_root() / 'thumbnails' / 'fail'
        if not fail_base.exists():
            return False
        uri      = file_uri(file_path)
        md5      = hashlib.md5(uri.encode()).hexdigest()
        filename = md5 + '.png'
        try:
            for subdir in fail_base.iterdir():
                if subdir.is_dir() and (subdir / filename).exists():
                    return True
        except OSError:
            pass
        return False

    # ── Backend interface ─────────────────────────────────────────────────

    def request(self, file_path, timeout=30.0):
        raise NotImplementedError

    def queue_preemptive(self, uris, mimes):
        """Default no-op.  Override in backends that support preemptive queueing."""


# ── Desktop detection ───────────────────────────────────────────────────────────

def _sanitize_name(name):
    """Strip non-alphanumeric characters and lowercase; safe as a module name."""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def _available_desktop_modules():
    """Return the stems of .py files in this package, excluding __init__."""
    pkg_dir = pathlib.Path(__file__).parent
    return [p.stem for p in sorted(pkg_dir.glob('[a-z]*.py'))]


def get_backend():
    """Return the best available XDG backend for the current desktop, or None.

    See module docstring for detection priority.
    """
    xdg_current = os.environ.get('XDG_CURRENT_DESKTOP', '')
    if xdg_current:
        for entry in xdg_current.split(':'):
            sanitized = _sanitize_name(entry)
            try:
                mod     = importlib.import_module(f'.{sanitized}', package=__name__)
                backend = mod.get_backend()
                if backend is not None:
                    return backend
            except ImportError:
                pass
        # XDG_CURRENT_DESKTOP was set; do not consult fallback variables.
        return None

    available = _available_desktop_modules()
    for var in ('XDG_SESSION_DESKTOP', 'DESKTOP_SESSION'):
        val = os.environ.get(var, '')
        if not val:
            continue
        val_upper = val.upper()
        for name in available:
            if name.upper() in val_upper:
                try:
                    mod     = importlib.import_module(f'.{name}', package=__name__)
                    backend = mod.get_backend()
                    if backend is not None:
                        return backend
                except ImportError:
                    pass

    return None
