#!/usr/bin/env python3
"""
media-queue — add audio/video files to the Media Viewer queue from the command line.

Usage:
  media-queue [--play] /path/to/audio.mp3
  media-queue [--play] /path/to/video.mp4
  media-queue [--play] /path/to/directory    # all audio+video files, recursing
                                             # into CD/Disc subdirectories
  media-queue [--play] path [path ...]       # multiple files/directories
  media-queue --play                         # restart a finished queue from the top

Audio files go into the audio queue; video files into the video queue.
--play starts the audio queue playing; if the queue has just finished it
restarts from the beginning.  Paths are optional when --play is used alone.

  Linux  : $XDG_CACHE_HOME/media-viewer/queue/   (default ~/.cache/media-viewer/queue/)
  macOS  : ~/Library/Caches/media-viewer/queue/
  Windows: %LOCALAPPDATA%\\media-viewer\\queue\\
"""

import os, re, sys
import argparse
from pathlib import Path

from viewer_host_utils import cache_dir, enqueue_request

QUEUE_DIR = cache_dir('media-viewer') / 'queue'

_AUDIO_EXT = frozenset({
    '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.wav',
})
_VIDEO_EXT = frozenset({
    '.mp4', '.m4v', '.webm', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.3gp',
})
_DISC_RE = re.compile(r'^(CD|Disc)\s*\d+$', re.IGNORECASE)


def _media_type(name):
    ext = os.path.splitext(name)[1].lower()
    if ext in _AUDIO_EXT: return 'audio'
    if ext in _VIDEO_EXT: return 'video'
    return None


def _entry_filestat(entry, dir_url):
    """Build a filestat dict from a DirEntry for use as a queue item."""
    info = {'u': entry.name, 'p': dir_url}
    try:
        st = entry.stat(follow_symlinks=True)
        info['m'] = int(st.st_mtime)
        info['s'] = st.st_size
    except OSError:
        pass
    if not os.access(entry.path, os.R_OK):
        info['r'] = 0
    return info


def _file_filestat(file_path):
    """Build a filestat dict for a single absolute file path."""
    p = Path(file_path)
    dir_url = p.parent.as_uri() + '/'
    info = {'u': p.name, 'p': dir_url}
    try:
        st = p.stat()
        info['m'] = int(st.st_mtime)
        info['s'] = st.st_size
    except OSError:
        pass
    if not os.access(file_path, os.R_OK):
        info['r'] = 0
    return info


def _collect_dir(dir_path, audio_items, video_items):
    """Collect queued audio/video items from *dir_path*.

    Files are added in case-insensitive sorted order, matching the viewer's
    directory listing sort.  Subdirectories named like "CD 1", "Disc 2", etc.
    are recursed in disc-number order after the flat files, mirroring the
    viewer's Q-key queueing behaviour.
    """
    dir_url = Path(dir_path).as_uri() + '/'
    try:
        entries = sorted(os.scandir(dir_path), key=lambda e: e.name.lower())
    except OSError as exc:
        print(f'warning: {dir_path}: {exc}', file=sys.stderr)
        return

    disc_subdirs = []
    for entry in entries:
        if entry.is_file(follow_symlinks=True):
            mt = _media_type(entry.name)
            if mt == 'audio':
                audio_items.append(_entry_filestat(entry, dir_url))
            elif mt == 'video':
                video_items.append(_entry_filestat(entry, dir_url))
        elif entry.is_dir(follow_symlinks=True) and _DISC_RE.match(entry.name):
            disc_subdirs.append(entry)

    disc_subdirs.sort(key=lambda e: int(re.search(r'\d+', e.name).group()))
    for entry in disc_subdirs:
        _collect_dir(entry.path, audio_items, video_items)


def main():
    ap = argparse.ArgumentParser(
        prog='media-queue',
        description='Add audio/video files to the Media Viewer queue.',
    )
    ap.add_argument('--play', '-p', action='store_true',
                    help='start (or restart) the audio queue; paths are optional')
    ap.add_argument('paths', nargs='*', metavar='path',
                    help='files or directories to add to the queue')
    args = ap.parse_args()

    if not args.paths and not args.play:
        ap.error('provide at least one path, or use --play to restart a finished queue')

    audio_items, video_items = [], []
    error = False

    for raw in args.paths:
        target = os.path.realpath(raw)
        if os.path.isdir(target):
            _collect_dir(target, audio_items, video_items)
        elif os.path.isfile(target):
            mt = _media_type(os.path.basename(target))
            if mt is None:
                print(f'warning: {target}: not a supported audio/video type, skipping',
                      file=sys.stderr)
            elif mt == 'audio':
                audio_items.append(_file_filestat(target))
            else:
                video_items.append(_file_filestat(target))
        else:
            print(f'error: {raw}: no such file or directory', file=sys.stderr)
            error = True

    if error:
        sys.exit(1)

    if args.paths and not audio_items and not video_items:
        print('error: no supported audio/video files found', file=sys.stderr)
        sys.exit(1)

    enqueue_request(QUEUE_DIR, {
        'type':  'queue',
        'audio': audio_items,
        'video': video_items,
        'play':  args.play,
    })


if __name__ == '__main__':
    main()
