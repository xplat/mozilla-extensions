#!/usr/bin/env bash
# install.sh — install the CBZ Viewer native messaging host
#
# Installs:
#   - cbz_native_host.py  → ~/.local/share/cbz-viewer/
#   - cbz-open            → ~/.local/bin/   (or ~/bin/ as fallback)
#   - host manifest JSON  → correct location for Firefox on Linux/macOS
#
# Run once after loading the extension. Re-run to update.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Detect OS ──────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux)
    # User-level Firefox native messaging host directory
    MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
    ;;
  Darwin)
    MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# ── Install host script ────────────────────────────────────────────────────────
INSTALL_DIR="$HOME/.local/share/cbz-viewer"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/cbz_native_host.py" "$INSTALL_DIR/cbz_native_host.py"
chmod +x "$INSTALL_DIR/cbz_native_host.py"
echo "Installed host: $INSTALL_DIR/cbz_native_host.py"

# ── Install cbz-open ───────────────────────────────────────────────────────────
# Prefer ~/.local/bin (modern XDG standard), fall back to ~/bin
if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  BIN_DIR="$HOME/.local/bin"
elif [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
  BIN_DIR="$HOME/bin"
else
  # Install to ~/.local/bin and warn
  BIN_DIR="$HOME/.local/bin"
  echo "Note: $BIN_DIR is not in your PATH. Add it to use cbz-open from anywhere."
  echo "  Add to ~/.bashrc or ~/.zshrc:  export PATH=\"\$HOME/.local/bin:\$PATH\""
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
  "allowed_extensions": ["cbz-viewer@extension"]
}
JSON

echo "Installed manifest: $MANIFEST_PATH"

# ── Create queue directory ─────────────────────────────────────────────────────
mkdir -p "$HOME/.cbz-viewer/queue"

echo ""
echo "Installation complete."
echo ""
echo "Usage:  cbz-open /path/to/comic.cbz [page]"
echo ""
echo "Firefox must be running with the CBZ Viewer extension installed."
