#!/bin/sh
# install-common.sh — shared install logic for native messaging hosts.
#
# Source this file from a component's install.sh after setting:
#   PKG_DIR        absolute path to the component directory (contains pyproject.toml)
#   PKG_NAME       pip package name          e.g. cbz-viewer-host
#   HOST_BIN_NAME  installed binary name     e.g. cbz_native_host
#   HOST_ID        native messaging host ID  e.g. cbz_viewer_host
#   HOST_DESC      one-line manifest description
#   ALLOWED_EXT    extension ID              e.g. cbz-viewer@xplat.github.io
#   APP_NAME       app name for cache dirs   e.g. cbz-viewer
#   EXTENSION_DIR  extension subdirectory    e.g. cbz-extension
#
# Platform directories used:
#   Linux :  package  → ~/.local/             (via pip --user or pipx)
#            queue    → $XDG_CACHE_HOME/<APP_NAME>/queue/  (default ~/.cache/…)
#            manifest → ~/.mozilla/native-messaging-hosts/
#   macOS :  package  → ~/Library/            (via pip --user or pipx)
#            queue    → ~/Library/Caches/<APP_NAME>/queue/
#            manifest → ~/Library/Application Support/Mozilla/NativeMessagingHosts/
#
# For Windows, use the component's install.ps1 instead.
#
# Accepts optional argument:
#   --break-system-packages   passed to pip3 on PEP 668 systems
#                             (Debian/Ubuntu 23+); needed only when pipx is
#                             unavailable and pip3 --user refuses to install.

set -euo pipefail

_REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="$_REPO_ROOT/native-shared"

# ── Detect OS ─────────────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)
    NM_HOSTS_DIR="$HOME/.mozilla/native-messaging-hosts"
    XDG_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
    QUEUE_DIR="$XDG_CACHE/$APP_NAME/queue"
    ;;
  Darwin)
    NM_HOSTS_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    QUEUE_DIR="$HOME/Library/Caches/$APP_NAME/queue"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    echo "For Windows, use install.ps1 instead." >&2
    exit 1
    ;;
esac

# ── Install Python package ────────────────────────────────────────────────────
# viewer_host_utils (local shared package) must be installed alongside the
# component package.  For pipx, --preinstall is required since otherwise the
# local package cannot be found.
# For pip --user both packages are installed together in one invocation.

BREAK_SYSTEM=0
for arg in "$@"; do
  [ "$arg" = "--break-system-packages" ] && BREAK_SYSTEM=1
done

PKG_SPEC="$PKG_NAME @ file://$PKG_DIR"
SHARED_SPEC="viewer_host_utils @ file://$SHARED_DIR"

if command -v pipx >/dev/null 2>&1; then
  pip cache remove "$PKG_NAME"
  pip cache remove viewer_host_utils
  pipx install --force "$PKG_SPEC" --preinstall "$SHARED_SPEC"
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
HOST_BIN="$SCRIPTS_DIR/$HOST_BIN_NAME"

if [ ! -f "$HOST_BIN" ]; then
  # Fallback: common default (also where pipx places its wrappers).
  HOST_BIN="$HOME/.local/bin/$HOST_BIN_NAME"
fi
echo "Host binary → $HOST_BIN"

# ── Write native messaging manifest ──────────────────────────────────────────

mkdir -p "$NM_HOSTS_DIR"
cat > "$NM_HOSTS_DIR/${HOST_ID}.json" <<JSON
{
  "name": "$HOST_ID",
  "description": "$HOST_DESC",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_extensions": ["$ALLOWED_EXT"]
}
JSON
echo "Installed manifest → $NM_HOSTS_DIR/${HOST_ID}.json"

# ── Create queue directory ────────────────────────────────────────────────────

mkdir -p "$QUEUE_DIR"
echo "Queue dir → $QUEUE_DIR"

echo ""
echo "Done.  Load the $EXTENSION_DIR/ directory as a temporary extension"
echo "in Firefox (about:debugging → Load Temporary Add-on → manifest.json)."
