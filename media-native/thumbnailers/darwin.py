"""macOS thumbnail backend using qlmanage.

qlmanage is the command-line interface to macOS Quick Look.  It generates
thumbnails but does not embed XDG PNG extension blocks (Thumb::MTime, etc.),
so metadata-based validity checks via Pillow are skipped (_check_xdg_metadata
= False).  Freshness is determined by file-mtime comparison alone.
"""

import os
import pathlib
import shutil
import subprocess
import tempfile

from .xdg import XDGBackend, file_uri  # noqa: F401 – file_uri re-exported for callers

_THUMB_SIZE = 128


class DarwinBackend(XDGBackend):
    supports_preemptive_queueing = False
    _check_xdg_metadata          = False  # qlmanage doesn't embed XDG metadata blocks

    def request(self, file_path, timeout=30.0):
        """Generate a thumbnail via qlmanage. Returns True if the cache entry was written."""
        thumb = self.thumb_path(file_path)
        thumb.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory() as tmp:
            try:
                result = subprocess.run(
                    ['qlmanage', '-t', '-s', str(_THUMB_SIZE), '-o', tmp, file_path],
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    timeout=timeout,
                )
            except Exception:
                return False
            if result.returncode != 0:
                return False
            # qlmanage names the output file after the input basename, optionally
            # with an extra extension appended (.png, .jpeg, or .jpg).
            base = os.path.basename(file_path)
            for suffix in ('.png', '.jpeg', '.jpg', '.png.png'):
                src = pathlib.Path(tmp) / (base + suffix)
                if src.exists():
                    try:
                        shutil.move(str(src), str(thumb))
                    except OSError:
                        return False
                    return thumb.exists()
        return False


def get_backend():
    if shutil.which('qlmanage') is None:
        return None
    return DarwinBackend()
