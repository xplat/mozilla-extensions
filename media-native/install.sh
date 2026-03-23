#!/usr/bin/env bash
# install.sh — Install the Media Viewer native messaging host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/share/media-viewer"
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

# ── Install Python host ───────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/media_native_host.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/media_native_host.py"
echo "Installed host → $INSTALL_DIR/media_native_host.py"

# ── Install CLI tool ──────────────────────────────────────────────────────────

if [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
elif [ -d "$HOME/bin" ]; then
  BIN_DIR="$HOME/bin"
else
  mkdir -p "$HOME/.local/bin"
  BIN_DIR="$HOME/.local/bin"
fi

cp "$SCRIPT_DIR/media-open" "$BIN_DIR/media-open"
chmod +x "$BIN_DIR/media-open"
echo "Installed CLI  → $BIN_DIR/media-open"

# ── Write native messaging manifest ──────────────────────────────────────────

mkdir -p "$NM_HOSTS_DIR"
sed "s|REPLACE_WITH_INSTALL_PATH|$INSTALL_DIR|g" \
    "$SCRIPT_DIR/media_viewer_host.json" \
    > "$NM_HOSTS_DIR/media_viewer_host.json"
echo "Installed manifest → $NM_HOSTS_DIR/media_viewer_host.json"

# ── Create queue directory ────────────────────────────────────────────────────

mkdir -p "$QUEUE_DIR"
echo "Queue dir → $QUEUE_DIR"

echo ""
echo "Done.  Load the media-extension/ directory as a temporary extension"
echo "in Firefox (about:debugging → Load Temporary Add-on → manifest.json)."
