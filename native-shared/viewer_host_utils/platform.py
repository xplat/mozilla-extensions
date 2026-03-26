"""platform.py — platform-appropriate directory helpers."""

import sys, os, pathlib


def cache_dir(app_name: str) -> pathlib.Path:
    """Return the platform-appropriate user cache directory for *app_name*.

      Linux / other POSIX : $XDG_CACHE_HOME/<app_name>  (default ~/.cache/<app_name>)
      macOS               : ~/Library/Caches/<app_name>
      Windows             : %LOCALAPPDATA%\\<app_name>
    """
    if sys.platform == 'darwin':
        return pathlib.Path.home() / 'Library' / 'Caches' / app_name
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA', '')
        return (pathlib.Path(base) if base else pathlib.Path.home()) / app_name
    # Linux / other POSIX: honour XDG_CACHE_HOME
    xdg = os.environ.get('XDG_CACHE_HOME', '').strip()
    return (pathlib.Path(xdg) if xdg else pathlib.Path.home() / '.cache') / app_name
