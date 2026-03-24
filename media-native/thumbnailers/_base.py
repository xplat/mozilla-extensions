"""Shared thumbnail-backend interface and platform-neutral constants."""


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


# ── Backend ─────────────────────────────────────────────────────────────────────

class Backend:
    """Minimal interface shared by all thumbnail backends.

    Concrete implementations either subclass XDGBackend (for backends that use
    an on-disk thumbnail cache) or implement request() directly (e.g.
    WindowsBackend, which delegates entirely to the Shell cache via COM).
    """

    available = True

    def request(self, file_path, timeout=30.0):
        """Return PNG bytes for file_path, or None on failure."""
        raise NotImplementedError

    def queue_dir(self, dir_path):
        """Scan dir_path and schedule unresolved images for background generation.
        Default is a no-op; override in backends that support preemptive queueing.
        """
