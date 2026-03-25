#!/usr/bin/env bash
# install.sh — install the CBZ Viewer native messaging host (Linux / macOS)
#
# Installs:
#   - cbz_native_host.py  → platform data dir
#   - cbz-open            → ~/.local/bin/ or ~/bin/ (Linux) / /usr/local/bin/ (macOS)
#   - host manifest JSON  → Firefox native messaging hosts dir for this OS
#   - queue directory     → platform cache dir
#
# Platform directories used:
#   Linux :  host → ~/.local/share/cbz-viewer/
#            queue → $XDG_CACHE_HOME/cbz-viewer/queue/   (default ~/.cache/…)
#            manifest → ~/.mozilla/native-messaging-hosts/
#   macOS :  host → ~/Library/Application Support/cbz-viewer/
#            queue → ~/Library/Caches/cbz-viewer/queue/
#            manifest → ~/Library/Application Support/Mozilla/NativeMessagingHosts/
#
# For Windows, use install.ps1 instead.
#
# Run once after loading the extension. Re-run to update.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Detect OS ──────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux)
    MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
    INSTALL_DIR="$HOME/.local/share/cbz-viewer"
    XDG_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
    QUEUE_DIR="$XDG_CACHE/cbz-viewer/queue"
    ;;
  Darwin)
    MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    INSTALL_DIR="$HOME/Library/Application Support/cbz-viewer"
    QUEUE_DIR="$HOME/Library/Caches/cbz-viewer/queue"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    echo "For Windows, use install.ps1 instead." >&2
    exit 1
    ;;
esac

# ── Install host script ────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/cbz_native_host.py" "$INSTALL_DIR/cbz_native_host.py"
chmod +x "$INSTALL_DIR/cbz_native_host.py"
echo "Installed host: $INSTALL_DIR/cbz_native_host.py"

# ── Install cbz-open ───────────────────────────────────────────────────────────
if [[ "$OS" == "Darwin" ]]; then
  # macOS: use ~/.local/bin (same convention as Linux; no platform-specific
  # equivalent exists, and /usr/local/bin requires sudo on stock macOS)
  BIN_DIR="$HOME/.local/bin"
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "Note: $BIN_DIR is not in your PATH. Add it to use cbz-open from anywhere."
    echo "  Add to ~/.zshrc:  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
else
  # Linux: prefer ~/.local/bin (modern XDG), fall back to ~/bin
  if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
    BIN_DIR="$HOME/.local/bin"
  elif [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
    BIN_DIR="$HOME/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    echo "Note: $BIN_DIR is not in your PATH. Add it to use cbz-open from anywhere."
    echo "  Add to ~/.bashrc or ~/.zshrc:  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi
mkdir -p "$BIN_DIR"
cp "$SCRIPT_DIR/cbz-open" "$BIN_DIR/cbz-open"
chmod +x "$BIN_DIR/cbz-open"
echo "Installed command: $BIN_DIR/cbz-open"

# ── Write host manifest ────────────────────────────────────────────────────────
mkdir -p "$MANIFEST_DIR"
MANIFEST_PATH="$MANIFEST_DIR/cbz_viewer_host.json"

cat > "$MANIFEST_PATH" << JSON
{
  "name": "cbz_viewer_host",
  "description": "Native messaging host for the CBZ Viewer extension",
  "path": "$INSTALL_DIR/cbz_native_host.py",
  "type": "stdio",
  "allowed_extensions": ["cbz-viewer@xplat.github.io"]
}
JSON

echo "Installed manifest: $MANIFEST_PATH"

# ── Create queue directory ─────────────────────────────────────────────────────
mkdir -p "$QUEUE_DIR"
echo "Queue directory: $QUEUE_DIR"

echo ""
echo "Installation complete."
echo ""
echo "Usage:  cbz-open /path/to/comic.cbz [page]"
echo ""
echo "Firefox must be running with the CBZ Viewer extension installed."
