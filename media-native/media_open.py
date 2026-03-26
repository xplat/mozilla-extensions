#!/usr/bin/env python3
"""
media-open — CLI tool to open a directory (or a specific image file within
a directory) in the Media Viewer Firefox extension.

Usage:
  media-open /path/to/directory
  media-open /path/to/image.jpg

Drops a small JSON request into the platform queue directory.  The native
host picks it up promptly and opens the viewer.

  Linux  : $XDG_CACHE_HOME/media-viewer/queue/   (default ~/.cache/media-viewer/queue/)
  macOS  : ~/Library/Caches/media-viewer/queue/
  Windows: %LOCALAPPDATA%\media-viewer\queue\
"""

import sys, os, time

from thumbnailers import MIME_TYPES
from viewer_host_utils import cache_dir, enqueue_request

QUEUE_DIR = cache_dir('media-viewer') / 'queue'

_SUPPORTED_EXTS = frozenset(MIME_TYPES)  # derived — MIME_TYPES is the single source of truth

def usage():
    print('Usage: media-open /path/to/directory',     file=sys.stderr)
    print('       media-open /path/to/media-file.mp4', file=sys.stderr)
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        usage()

    target = os.path.realpath(sys.argv[1])

    if os.path.isdir(target):
        req = {'dir': target, 'file': ''}
    elif os.path.isfile(target):
        ext = os.path.splitext(target)[1].lower()
        if ext not in _SUPPORTED_EXTS:
            print(f'error: {target}: not a supported media type', file=sys.stderr)
            sys.exit(1)
        req = {'dir': os.path.dirname(target), 'file': os.path.basename(target)}
    else:
        print(f'error: {target}: no such file or directory', file=sys.stderr)
        sys.exit(1)

    enqueue_request(QUEUE_DIR, req)

if __name__ == '__main__':
    main()
