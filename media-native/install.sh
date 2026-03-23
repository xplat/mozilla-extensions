#!/usr/bin/env bash
# install.sh — Install the Media Viewer native messaging host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUEUE_DIR="$HOME/.media-viewer/queue"

# ── Detect OS ────────────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)
    NM_HOSTS_DIR="$HOME/.mozilla/native-messaging-hosts"
    ;;
  Darwin)
    NM_HOSTS_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# ── Install Python package ────────────────────────────────────────────────────
# This installs media_native_host and media-open as console scripts and pulls
# in jeepney (D-Bus client) as a dependency on Linux.
# Prefer pipx (isolated venv, works on all systems); fall back to pip3 --user.

if command -v pipx >/dev/null 2>&1; then
  pipx install --force "$SCRIPT_DIR"
  echo "Installed package via pipx"
else
  pip3 install --user "$SCRIPT_DIR" || \
  pip3 install --user --break-system-packages "$SCRIPT_DIR"
  echo "Installed package via pip"
fi

# ── Locate the installed host binary ─────────────────────────────────────────
# pip --user installs scripts to the user scripts directory; ask Python where
# that is to handle non-standard setups correctly.

SCRIPTS_DIR="$(python3 -c \
  'import sysconfig; print(sysconfig.get_path("scripts", "posix_user"))')"
HOST_BIN="$SCRIPTS_DIR/media_native_host"

if [ ! -f "$HOST_BIN" ]; then
  # Fallback: common default
  HOST_BIN="$HOME/.local/bin/media_native_host"
fi
echo "Host binary → $HOST_BIN"

# ── Write native messaging manifest ──────────────────────────────────────────

mkdir -p "$NM_HOSTS_DIR"
cat > "$NM_HOSTS_DIR/media_viewer_host.json" <<JSON
{
  "name": "media_viewer_host",
  "description": "Native messaging host for the Media Viewer Firefox extension",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_extensions": ["media-viewer@xplat.github.io"]
}
JSON
echo "Installed manifest → $NM_HOSTS_DIR/media_viewer_host.json"

# ── Create queue directory ────────────────────────────────────────────────────

mkdir -p "$QUEUE_DIR"
echo "Queue dir → $QUEUE_DIR"

echo ""
echo "Done.  Load the media-extension/ directory as a temporary extension"
echo "in Firefox (about:debugging → Load Temporary Add-on → manifest.json)."
