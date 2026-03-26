#!/usr/bin/env bash
# install.sh — Install the CBZ Viewer native messaging host (Linux / macOS).
# For Windows, use install.ps1 instead.
# Usage: ./install.sh [--break-system-packages]
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME=cbz-viewer-host
HOST_BIN_NAME=cbz_native_host
HOST_ID=cbz_viewer_host
HOST_DESC="Native messaging host for the CBZ Viewer extension"
ALLOWED_EXT=cbz-viewer@xplat.github.io
APP_NAME=cbz-viewer
EXTENSION_DIR=cbz-extension
source "$PKG_DIR/../install-common.sh"
