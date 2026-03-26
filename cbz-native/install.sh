#!/usr/bin/env bash
# install.sh — Install the CBZ Viewer native messaging host (Linux / macOS).
#
# Platform directories used:
#   Linux :  package → ~/.local/  (via pip --user or pipx)
#            queue   → $XDG_CACHE_HOME/cbz-viewer/queue/   (default ~/.cache/…)
#            manifest → ~/.mozilla/native-messaging-hosts/
#   macOS :  package → ~/Library/  (via pip --user or pipx)
#            queue   → ~/Library/Caches/cbz-viewer/queue/
#            manifest → ~/Library/Application Support/Mozilla/NativeMessagingHosts/
#
# For Windows, use install.ps1 instead.
#
# Usage: ./install.sh [--break-system-packages]
#   --break-system-packages  passed through to pip3 on PEP 668 systems
#                            (Debian/Ubuntu 23+); required only when pipx is
#                            unavailable and pip3 --user refuses to install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="$SCRIPT_DIR/../native-shared"

# ── Detect OS ─────────────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)
    NM_HOSTS_DIR="$HOME/.mozilla/native-messaging-hosts"
    XDG_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
    QUEUE_DIR="$XDG_CACHE/cbz-viewer/queue"
    ;;
  Darwin)
    NM_HOSTS_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    QUEUE_DIR="$HOME/Library/Caches/cbz-viewer/queue"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    echo "For Windows, use install.ps1 instead." >&2
    exit 1
    ;;
esac

# ── Install Python package ────────────────────────────────────────────────────
# Installs cbz_native_host and cbz-open as console scripts.
# viewer-host-utils (local shared package) must be installed first so that pip
# can satisfy the dependency; pipx uses inject to add it to the isolated venv.
# Prefer pipx (isolated venv, works on all systems); fall back to pip3 --user.

BREAK_SYSTEM=0
for arg in "$@"; do
  [ "$arg" = "--break-system-packages" ] && BREAK_SYSTEM=1
done

PKG_SPEC="cbz-viewer-host @ file://$SCRIPT_DIR"
SHARED_SPEC="viewer-host-utils @ file://$SHARED_DIR"

if command -v pipx >/dev/null 2>&1; then
  # Install cbz-viewer-host without resolving viewer-host-utils from PyPI
  # (it's a local-only package), then inject it into the same isolated venv.
  pipx install --force --pip-args="--no-deps --no-cache-dir" "$PKG_SPEC"
  pipx inject cbz-viewer-host --pip-args="--no-cache-dir" "$SHARED_SPEC"
  echo "Installed package via pipx"
elif pip3 install --user --no-cache-dir "$SHARED_SPEC" "$PKG_SPEC"; then
  echo "Installed package via pip"
elif [ "$BREAK_SYSTEM" -eq 1 ]; then
  pip3 install --user --no-cache-dir --break-system-packages \
      "$SHARED_SPEC" "$PKG_SPEC"
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
HOST_BIN="$SCRIPTS_DIR/cbz_native_host"

if [ ! -f "$HOST_BIN" ]; then
  # Fallback: common default (also where pipx places its wrappers)
  HOST_BIN="$HOME/.local/bin/cbz_native_host"
fi
echo "Host binary → $HOST_BIN"

# ── Write native messaging manifest ──────────────────────────────────────────

mkdir -p "$NM_HOSTS_DIR"
cat > "$NM_HOSTS_DIR/cbz_viewer_host.json" <<JSON
{
  "name": "cbz_viewer_host",
  "description": "Native messaging host for the CBZ Viewer extension",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_extensions": ["cbz-viewer@xplat.github.io"]
}
JSON
echo "Installed manifest → $NM_HOSTS_DIR/cbz_viewer_host.json"

# ── Create queue directory ────────────────────────────────────────────────────

mkdir -p "$QUEUE_DIR"
echo "Queue dir → $QUEUE_DIR"

echo ""
echo "Done.  Load the cbz-extension/ directory as a temporary extension"
echo "in Firefox (about:debugging → Load Temporary Add-on → manifest.json)."
