#!/usr/bin/env python3
"""
cbz-open — open a local CBZ file in the CBZ Viewer Firefox extension.

Usage:
    cbz-open <file.cbz> [page]

Drops a small JSON request into the platform queue directory.  The native
messaging host (already running inside Firefox) picks it up promptly and
tells the extension to open the file.

  Linux  : $XDG_CACHE_HOME/cbz-viewer/queue/   (default ~/.cache/cbz-viewer/queue/)
  macOS  : ~/Library/Caches/cbz-viewer/queue/
  Windows: %LOCALAPPDATA%\cbz-viewer\queue\

Firefox must be running with the CBZ Viewer extension installed and active.
"""

import sys, os, time

from viewer_host_utils import cache_dir, enqueue_request

QUEUE_DIR = cache_dir('cbz-viewer') / 'queue'


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print('Usage: cbz-open <file.cbz> [page]', file=sys.stderr)
        sys.exit(0 if args else 1)

    path = os.path.realpath(args[0])
    page = 1
    if len(args) >= 2:
        try:
            page = max(1, int(args[1]))
        except ValueError:
            print(f'cbz-open: invalid page number: {args[1]!r}', file=sys.stderr)
            sys.exit(1)

    if not path.lower().endswith('.cbz') and not path.lower().endswith('.zip'):
        print(f'cbz-open: not a .cbz file: {path}', file=sys.stderr)
        sys.exit(1)
    if not os.path.isfile(path):
        print(f'cbz-open: file not found: {path}', file=sys.stderr)
        sys.exit(1)

    enqueue_request(QUEUE_DIR, {'path': path, 'page': page, 'ts': time.time()})
    print(f'Opening {os.path.basename(path)} (page {page})…')

if __name__ == '__main__':
    main()
