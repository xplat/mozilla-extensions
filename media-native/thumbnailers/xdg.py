"""XDG thumbnail cache helpers shared across all thumbnail backends."""

import hashlib
import os
import pathlib
import urllib.parse

try:
    from PIL import Image as _PILImage
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False


# ── Cache directories ──────────────────────────────────────────────────────────

def _cache_home():
    raw = os.environ.get('XDG_CACHE_HOME', '').strip()
    return pathlib.Path(raw) if raw else pathlib.Path.home() / '.cache'


THUMB_DIR = _cache_home() / 'thumbnails' / 'normal'
FAIL_BASE = _cache_home() / 'thumbnails' / 'fail'


# ── MIME types for thumbnail-eligible files ────────────────────────────────────

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


# ── URI / path helpers ─────────────────────────────────────────────────────────

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


def xdg_thumb_path(file_path):
    """XDG 'normal' (128px) thumbnail cache path for an absolute file path."""
    uri = file_uri(file_path)
    md5 = hashlib.md5(uri.encode()).hexdigest()
    return THUMB_DIR / (md5 + '.png')


def is_thumb_valid(thumb_path, file_path):
    """True if the cached thumbnail is current for file_path."""
    try:
        file_mtime = int(os.path.getmtime(file_path))
        if _PIL_AVAILABLE:
            try:
                with _PILImage.open(str(thumb_path)) as img:
                    meta = int(img.text.get('Thumb::MTime', '0'))
                if meta > 0:
                    return meta >= file_mtime
            except Exception:
                pass
        return int(os.path.getmtime(str(thumb_path))) >= file_mtime
    except OSError:
        return False


def is_thumb_failed(file_path):
    """True if any XDG fail-cache entry exists for file_path."""
    if not FAIL_BASE.exists():
        return False
    uri      = file_uri(file_path)
    md5      = hashlib.md5(uri.encode()).hexdigest()
    filename = md5 + '.png'
    try:
        for subdir in FAIL_BASE.iterdir():
            if subdir.is_dir() and (subdir / filename).exists():
                return True
    except OSError:
        pass
    return False
