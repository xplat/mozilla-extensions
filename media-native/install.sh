#!/bin/sh
# install.sh — Install the Media Viewer native messaging host (Linux / macOS).
# For Windows, use install.ps1 instead.
# Usage: ./install.sh [--break-system-packages]
export PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME=media_viewer_host \
HOST_BIN_NAME=media_native_host \
HOST_ID=media_viewer_host \
HOST_DESC="Native messaging host for the Media Viewer Firefox extension" \
ALLOWED_EXT=media-viewer@xplat.github.io \
APP_NAME=media-viewer \
EXTENSION_DIR=media-extension \
sh "$PKG_DIR/../install-common.sh"
