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


# ── Minimal 1×1 greyscale PNG for fail-cache entries ───────────────────────────

_MINIMAL_PNG = (
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
    b'\x08\x00\x00\x00\x00:~\x9bU\x00\x00\x00\nIDATx\x9cc`\x00\x00\x00\x02'
    b'\x00\x01\xe2!\xbc3\x00\x00\x00\x00IEND\xaeB`\x82'
)


# ── Backend ─────────────────────────────────────────────────────────────────────

class Backend:
    """Minimal interface shared by all thumbnail backends.

    Concrete implementations either subclass XDGBackend (for backends that
    use an on-disk thumbnail cache) or implement request() directly (e.g.
    WindowsBackend, which delegates entirely to the Shell cache via COM).
    """

    available                    = True
    supports_preemptive_queueing = False

    def request(self, file_path, timeout=30.0):
        """Return PNG bytes for file_path, or None on failure."""
        raise NotImplementedError

    def queue_dir(self, dir_path):
        """Scan dir_path and schedule unresolved images for background generation.
        Default is a no-op; override in backends that support preemptive queueing.
        """


# ── XDGBackend ──────────────────────────────────────────────────────────────────

class XDGBackend(Backend):
    """Base class for thumbnail backends that use an XDG-style on-disk cache.

    Subclasses must implement _generate().  Class-level overrides:

      cache_root            pathlib.Path or None.  None → use ~/.cache (or
                            $XDG_CACHE_HOME).  Set to a different root to keep
                            thumbnails in a separate directory (e.g. Pillow).

      _check_xdg_metadata   Set to False to skip PIL-based Thumb::MTime
                            validation.  Use this for backends whose native
                            tool does not embed XDG PNG extension blocks
                            (e.g. Darwin's qlmanage).
    """

    _APP_NAME = 'media-viewer'   # fail-cache subdirectory name

    cache_root          = None   # override as a class attribute in subclass
    _check_xdg_metadata = True

    def __init__(self):
        if self._check_xdg_metadata:
            try:
                from PIL import Image as _PILImage
                self._pil = _PILImage
            except ImportError:
                self._pil = None
        else:
            self._pil = None

    # ── Protected cache-path helpers ──────────────────────────────────────

    def _thumb_root(self):
        return self.cache_root if self.cache_root is not None else _cache_home()

    def _thumb_path(self, file_path):
        """Normal (128 px) cache path for file_path."""
        uri = file_uri(file_path)
        md5 = hashlib.md5(uri.encode()).hexdigest()
        return self._thumb_root() / 'thumbnails' / 'normal' / (md5 + '.png')

    def _fail_path(self, file_path):
        """Fail-cache entry path for file_path (under our app's subdirectory)."""
        uri = file_uri(file_path)
        md5 = hashlib.md5(uri.encode()).hexdigest()
        return self._thumb_root() / 'thumbnails' / 'fail' / self._APP_NAME / (md5 + '.png')

    def _is_valid(self, thumb, file_path):
        """True if the cached thumbnail at thumb is current for file_path."""
        try:
            file_mtime = int(os.path.getmtime(file_path))
            if self._pil is not None:
                try:
                    with self._pil.open(str(thumb)) as img:
                        meta = int(img.text.get('Thumb::MTime', '0'))
                    if meta > 0:
                        return meta >= file_mtime
                except Exception:
                    pass
            return int(os.path.getmtime(str(thumb))) >= file_mtime
        except OSError:
            return False

    def _is_failed(self, file_path):
        """True if any fail-cache entry exists for file_path."""
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

    def is_resolved(self, file_path):
        """True if file_path already has a valid success or failure cache entry.

        Used by backends with preemptive queueing (e.g. XfceBackend.queue_dir)
        to skip files that do not need background processing.
        """
        thumb = self._thumb_path(file_path)
        if thumb.exists() and self._is_valid(thumb, file_path):
            return True
        return self._is_failed(file_path)

    # ── Protected cache I/O helpers ───────────────────────────────────────

    def _slurp(self, thumb):
        """Return the bytes of a cache file. Returns None on I/O error."""
        try:
            return thumb.read_bytes()
        except OSError:
            return None

    def _cache_png(self, data, thumb):
        """Write PNG bytes to the cache file atomically. Failure is silent."""
        try:
            thumb.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            thumb.write_bytes(data)
        except Exception:
            pass

    def _cache_fail(self, fail_path):
        """Write a minimal fail-cache entry. Failure is silent."""
        try:
            fail_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fail_path.write_bytes(_MINIMAL_PNG)
        except Exception:
            pass

    # ── Public API ────────────────────────────────────────────────────────

    def request(self, file_path, timeout=30.0):
        """Return PNG bytes for file_path, generating if necessary.

        Checks the on-disk cache first; returns cached bytes on a hit.
        Calls _generate() on a cache miss.  Returns None if no thumbnail
        can be produced.
        """
        thumb = self._thumb_path(file_path)
        if thumb.exists() and self._is_valid(thumb, file_path):
            return self._slurp(thumb)
        if self._is_failed(file_path):
            return None
        return self._generate(file_path, thumb, self._fail_path(file_path), timeout)

    # ── Protected abstract ────────────────────────────────────────────────

    def _generate(self, file_path, thumb, fail, timeout):
        """Generate a thumbnail for file_path.

        thumb  – intended destination in the normal cache (may be None for
                 backends with no file cache, e.g. WindowsBackend).
        fail   – where to write a fail-cache entry if generation fails
                 permanently; call self._cache_fail(fail) to record it.

        Returns PNG bytes on success, None on failure.
        """
        raise NotImplementedError


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
