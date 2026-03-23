#!/usr/bin/env python3
"""
media-open — CLI tool to open a directory (or a specific image file within
a directory) in the Media Viewer Firefox extension.

Usage:
  media-open /path/to/directory
  media-open /path/to/image.jpg

The native host polls ~/.media-viewer/queue/ every ~0.5 s and opens the
viewer within that window.
"""

import sys, os, json, time, pathlib

QUEUE_DIR = pathlib.Path.home() / '.media-viewer' / 'queue'

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
