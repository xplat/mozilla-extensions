"""wire.py — Firefox native messaging wire protocol (4-byte LE length + UTF-8 JSON)."""

import sys, json, struct


def read_message():
    """Read one native message from stdin.  Returns None on EOF."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    if len(raw_msg) < msg_len:
        return None
    return json.loads(raw_msg.decode('utf-8'))


def send_message(msg: dict) -> None:
    """Write one native message to stdout."""
    encoded = json.dumps(msg, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
