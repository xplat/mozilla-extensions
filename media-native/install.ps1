# install.ps1 — Install the Media Viewer native messaging host (Windows).
# For Linux / macOS, use install.sh instead.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [--break-system-packages]
$PkgDir       = $PSScriptRoot
$PkgName      = 'media_viewer_host'
$HostBinName  = 'media_native_host'
$HostId       = 'media_viewer_host'
$HostDesc     = 'Native messaging host for the Media Viewer Firefox extension'
$AllowedExt   = 'media-viewer@xplat.github.io'
$AppName      = 'media-viewer'
$ExtensionDir = 'media-extension'
. "$PSScriptRoot\..\install-common.ps1"
