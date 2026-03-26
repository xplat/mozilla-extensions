# install.ps1 — Install the CBZ Viewer native messaging host (Windows).
# For Linux / macOS, use install.sh instead.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [--break-system-packages]
$PkgDir       = $PSScriptRoot
$PkgName      = 'cbz-viewer-host'
$HostBinName  = 'cbz_native_host'
$HostId       = 'cbz_viewer_host'
$HostDesc     = 'Native messaging host for the CBZ Viewer extension'
$AllowedExt   = 'cbz-viewer@xplat.github.io'
$AppName      = 'cbz-viewer'
$ExtensionDir = 'cbz-extension'
. "$PSScriptRoot\..\install-common.ps1"
