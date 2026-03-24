"""Windows thumbnail backend using IShellItemImageFactory.

Accesses the Windows Shell thumbnail cache (and generates thumbnails on demand)
via SHCreateItemFromParsingName + IShellItemImageFactory::GetImage — the modern
client API that handles cache population internally without requiring direct
access to the thumbcache .db files.

The HBITMAP returned by GetImage is extracted to raw pixels with GDI
(GetDIBits) and converted to PNG bytes by Pillow, which are returned directly
to the caller.  No private file cache is created; the Windows Shell cache is
the sole persistent store.

COM is accessed through ctypes.windll only; no comtypes package is required.
Pillow is the sole external dependency.
"""

import ctypes
import ctypes.wintypes
import io
import os

from PIL import Image

from .xdg import XDGBackend, MIME_TYPES

_THUMB_SIZE = 128

# SIIGBF_RESIZETOFIT (0): scale the result to fit within the requested size.
# We do not set SIIGBF_BIGGERSIZEOK, so Windows will not hand back a larger
# cached entry that we would then have to resize ourselves.
_SIIGBF_RESIZETOFIT = 0x00000000

_S_OK = 0
_COINIT_APARTMENTTHREADED = 0x2

# ── Win32 API setup ──────────────────────────────────────────────────────────

_ole32   = ctypes.windll.ole32
_shell32 = ctypes.windll.shell32
_gdi32   = ctypes.windll.gdi32

_ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
_ole32.CoInitializeEx.restype  = ctypes.HRESULT
_ole32.CoUninitialize.argtypes = []
_ole32.CoUninitialize.restype  = None

_shell32.SHCreateItemFromParsingName.restype = ctypes.HRESULT


# ── GUID ─────────────────────────────────────────────────────────────────────

class _GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', ctypes.c_uint32),
        ('Data2', ctypes.c_uint16),
        ('Data3', ctypes.c_uint16),
        ('Data4', ctypes.c_uint8 * 8),
    ]


def _make_guid(s):
    """Parse '{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}' into a _GUID struct."""
    s   = s.strip('{}').replace('-', '')
    d4  = bytes.fromhex(s[16:32])
    return _GUID(int(s[0:8], 16), int(s[8:12], 16), int(s[12:16], 16),
                 (ctypes.c_uint8 * 8)(*d4))


_IID_IShellItem             = _make_guid('{43826D1E-E718-42EE-BC55-A1E261C37BFE}')
_IID_IShellItemImageFactory = _make_guid('{BCC18B79-BA16-442F-80C4-8A59C30C463B}')


# ── COM vtable helpers ────────────────────────────────────────────────────────

class _SIZE(ctypes.Structure):
    _fields_ = [('cx', ctypes.c_long), ('cy', ctypes.c_long)]


def _vt(punk, slot, restype, *argtypes):
    """Return a callable for the given COM vtable slot on the object at *punk*."""
    vtptr = ctypes.cast(ctypes.c_void_p(punk), ctypes.POINTER(ctypes.c_void_p)).contents
    vt    = ctypes.cast(vtptr, ctypes.POINTER(ctypes.c_void_p))
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vt[slot])


def _qi(punk, iid):
    """IUnknown::QueryInterface (vtable slot 0). Returns (HRESULT, ppv int)."""
    ppv = ctypes.c_void_p()
    hr  = _vt(punk, 0, ctypes.HRESULT,
               ctypes.POINTER(_GUID),
               ctypes.POINTER(ctypes.c_void_p))(
                   punk, ctypes.byref(iid), ctypes.byref(ppv))
    return hr, ppv.value


def _release(punk):
    """IUnknown::Release (vtable slot 2)."""
    if punk:
        _vt(punk, 2, ctypes.c_uint32)(punk)


def _get_image(factory, cx, cy, flags):
    """IShellItemImageFactory::GetImage (vtable slot 3).

    SIZE is passed by value as the first argument after *this*, matching the
    actual COM method signature.  Returns (HRESULT, HBITMAP int-handle).
    """
    hbm = ctypes.c_void_p()
    hr  = _vt(factory, 3, ctypes.HRESULT,
               _SIZE, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))(
                   factory, _SIZE(cx, cy), flags, ctypes.byref(hbm))
    return hr, hbm.value


# ── GDI: HBITMAP → PIL ───────────────────────────────────────────────────────

class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize',          ctypes.c_uint32),
        ('biWidth',         ctypes.c_int32),
        ('biHeight',        ctypes.c_int32),
        ('biPlanes',        ctypes.c_uint16),
        ('biBitCount',      ctypes.c_uint16),
        ('biCompression',   ctypes.c_uint32),
        ('biSizeImage',     ctypes.c_uint32),
        ('biXPelsPerMeter', ctypes.c_int32),
        ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed',       ctypes.c_uint32),
        ('biClrImportant',  ctypes.c_uint32),
    ]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', _BITMAPINFOHEADER)]


_BI_RGB = 0


def _hbitmap_to_pil(hbm):
    """Convert an HBITMAP handle to a PIL Image (RGBA). Returns None on failure.

    Uses two GetDIBits calls: the first (with a null pixel buffer) queries the
    bitmap dimensions; the second extracts top-down 32-bit BGRA pixels.  A
    temporary memory DC is required as the context for GetDIBits.
    """
    hdc = _gdi32.CreateCompatibleDC(None)
    if not hdc:
        return None
    try:
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        # First call (null buffer) fills in biWidth and biHeight.
        _gdi32.GetDIBits(hdc, hbm, 0, 0, None, ctypes.byref(bmi), 0)
        w = bmi.bmiHeader.biWidth
        h = abs(bmi.bmiHeader.biHeight)
        if w <= 0 or h <= 0:
            return None
        # Second call: request top-down 32-bit BGRA.
        bmi.bmiHeader.biBitCount    = 32
        bmi.bmiHeader.biCompression = _BI_RGB
        bmi.bmiHeader.biHeight      = -h    # negative → top-down scan order
        buf   = (ctypes.c_ubyte * (w * h * 4))()
        lines = _gdi32.GetDIBits(hdc, hbm, 0, h, buf, ctypes.byref(bmi), 0)
        if lines <= 0:
            return None
        return Image.frombytes('RGBA', (w, h), bytes(buf), 'raw', 'BGRA')
    except Exception:
        return None
    finally:
        _gdi32.DeleteDC(hdc)


# ── Backend ───────────────────────────────────────────────────────────────────

class WindowsBackend(XDGBackend):
    """Thumbnail backend for Windows using IShellItemImageFactory + GDI.

    Thumbnails are fetched from (or generated into) the Windows Shell cache
    via COM, converted to PNG bytes by Pillow, and returned directly.  No
    private file cache is written; the Shell manages its own thumbcache.db.
    """

    supports_preemptive_queueing = False
    _check_xdg_metadata          = False

    def thumb_path(self, file_path):
        """Windows thumbnails are served from memory; no file cache is used."""
        return None

    def is_failed(self, file_path):
        """No fail cache on Windows."""
        return False

    def request(self, file_path, timeout=30.0):
        """Fetch the thumbnail from the Windows Shell cache.
        Returns PNG bytes on success, None on failure."""
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in MIME_TYPES:
            return None

        # COM must be initialised on every thread before use.
        # S_FALSE (1) means already initialised on this thread — also fine.
        hr_init = _ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)
        if hr_init < 0:
            return None
        try:
            return self._fetch_png(file_path)
        except Exception:
            return None
        finally:
            _ole32.CoUninitialize()

    def _fetch_png(self, file_path):
        # 1. Create an IShellItem for the file.
        ppv = ctypes.c_void_p()
        hr  = _shell32.SHCreateItemFromParsingName(
            file_path, None,
            ctypes.byref(_IID_IShellItem), ctypes.byref(ppv),
        )
        if hr != _S_OK or not ppv.value:
            return None
        shell_item = ppv.value
        try:
            # 2. Query IShellItemImageFactory from the shell item.
            hr, factory = _qi(shell_item, _IID_IShellItemImageFactory)
            if hr != _S_OK or not factory:
                return None
            try:
                # 3. Request the thumbnail scaled to fit _THUMB_SIZE × _THUMB_SIZE.
                hr, hbm = _get_image(factory, _THUMB_SIZE, _THUMB_SIZE,
                                     _SIIGBF_RESIZETOFIT)
                if hr != _S_OK or not hbm:
                    return None
                try:
                    img = _hbitmap_to_pil(hbm)
                    if img is None:
                        return None
                    buf = io.BytesIO()
                    img.save(buf, 'PNG')
                    return buf.getvalue()
                finally:
                    _gdi32.DeleteObject(hbm)
            finally:
                _release(factory)
        finally:
            _release(shell_item)


def get_backend():
    """Return a WindowsBackend (Pillow availability is proven by the module import)."""
    return WindowsBackend()
