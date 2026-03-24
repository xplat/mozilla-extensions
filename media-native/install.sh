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
#
# Usage: ./install.sh [--break-system-packages]
#   --break-system-packages  passed through to pip3 on PEP 668 systems
#                            (Debian/Ubuntu 23+); required only when pipx is
#                            unavailable and pip3 --user refuses to install.

BREAK_SYSTEM=0
for arg in "$@"; do
  [ "$arg" = "--break-system-packages" ] && BREAK_SYSTEM=1
done

PKG_SPEC="media-viewer-host @ file://$SCRIPT_DIR"

if command -v pipx >/dev/null 2>&1; then
  pipx install --force "$PKG_SPEC"
  echo "Installed package via pipx"
elif pip3 install --user "$SCRIPT_DIR"; then
  echo "Installed package via pip"
elif [ "$BREAK_SYSTEM" -eq 1 ]; then
  pip3 install --user --break-system-packages "$SCRIPT_DIR"
  echo "Installed package via pip (--break-system-packages)"
else
  echo "" >&2
  echo "pip3 install --user failed.  If this system uses an externally-managed" >&2
  echo "Python environment (PEP 668 / Debian / Ubuntu 23+), re-run with:" >&2
  echo "" >&2
  echo "  $0 --break-system-packages" >&2
  echo "" >&2
  exit 1
fi

# ── Locate the installed host binary ─────────────────────────────────────────
# pip --user installs scripts to the user scripts directory; ask Python where
# that is to handle non-standard setups correctly.

SCRIPTS_DIR="$(python3 -c \
  'import sysconfig; print(sysconfig.get_path("scripts", "posix_user"))')"
HOST_BIN="$SCRIPTS_DIR/media_native_host"

if [ ! -f "$HOST_BIN" ]; then
  # Fallback: common default (also where pipx places its wrappers)
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
