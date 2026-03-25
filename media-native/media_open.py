#!/usr/bin/env python3
"""
media-open — CLI tool to open a directory (or a specific image file within
a directory) in the Media Viewer Firefox extension.

Usage:
  media-open /path/to/directory
  media-open /path/to/image.jpg

Drops a small JSON request into the platform queue directory.  The native
host picks it up within ~0.5 s and opens the viewer.

  Linux  : $XDG_CACHE_HOME/media-viewer/queue/   (default ~/.cache/media-viewer/queue/)
  macOS  : ~/Library/Caches/media-viewer/queue/
  Windows: %LOCALAPPDATA%\media-viewer\queue\
"""

import sys, os, json, time, pathlib


def _platform_cache_dir(app_name):
    """Return the platform-appropriate user cache directory for app_name."""
    if sys.platform == 'darwin':
        return pathlib.Path.home() / 'Library' / 'Caches' / app_name
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA', '')
        return (pathlib.Path(base) if base else pathlib.Path.home()) / app_name
    xdg = os.environ.get('XDG_CACHE_HOME', '').strip()
    return (pathlib.Path(xdg) if xdg else pathlib.Path.home() / '.cache') / app_name


QUEUE_DIR = _platform_cache_dir('media-viewer') / 'queue'

IMAGE_EXTS = frozenset([
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.avif', '.bmp', '.tiff', '.tif', '.svg', '.ico',
])

def usage():
    print('Usage: media-open /path/to/directory', file=sys.stderr)
    print('       media-open /path/to/image.jpg',  file=sys.stderr)
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        usage()

    target = os.path.realpath(sys.argv[1])

    if os.path.isdir(target):
        req = {'dir': target, 'file': ''}
    elif os.path.isfile(target):
        ext = os.path.splitext(target)[1].lower()
        if ext not in IMAGE_EXTS:
            print(f'error: {target}: not a supported image type', file=sys.stderr)
            sys.exit(1)
        req = {'dir': os.path.dirname(target), 'file': os.path.basename(target)}
    else:
        print(f'error: {target}: no such file or directory', file=sys.stderr)
        sys.exit(1)

    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    fname = QUEUE_DIR / f'open_{int(time.time() * 1000)}_{os.getpid()}.json'
    fname.write_text(json.dumps(req))

if __name__ == '__main__':
    main()
