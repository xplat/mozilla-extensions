"""queue.py — helpers for the file-based open-request queue.

The queue is a directory of JSON files named open_<ms>_<pid>.json.  Producers
write to a .tmp file then rename atomically so consumers never see partial data.
"""

import json, os, time, pathlib


def check_queue(queue_dir: pathlib.Path) -> list:
    """Return all pending open-request dicts from *queue_dir*, consuming them.

    Files are processed in sorted (chronological) order.  Any file that cannot
    be parsed is silently deleted so a corrupt entry never blocks the queue.
    """
    if not queue_dir.exists():
        return []
    reqs = []
    for f in sorted(queue_dir.glob('open_*.json')):
        try:
            reqs.append(json.loads(f.read_text()))
            f.unlink()
        except Exception:
            try:
                f.unlink()
            except Exception:
                pass
    return reqs


def enqueue_request(queue_dir: pathlib.Path, req: dict) -> None:
    """Write *req* as a JSON file into *queue_dir* atomically (write-then-rename).

    Creates *queue_dir* if it does not exist.
    """
    queue_dir.mkdir(parents=True, exist_ok=True)
    stem     = f'open_{int(time.time() * 1000)}_{os.getpid()}'
    tmp_file = queue_dir / f'{stem}.json.tmp'
    req_file = queue_dir / f'{stem}.json'
    tmp_file.write_text(json.dumps(req))
    tmp_file.replace(req_file)
