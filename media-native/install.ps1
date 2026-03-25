# install.ps1 — Install the Media Viewer native messaging host on Windows
#
# Installs the Python package (media_native_host + media-open console scripts)
# via pip, registers the native messaging host in the Windows registry so
# Firefox can find it, and creates the queue directory.
#
# Platform directories:
#   Package  → pip --user (scripts land in %APPDATA%\Python\PythonXY\Scripts\)
#   Queue    → %LOCALAPPDATA%\media-viewer\queue\
#   Manifest → %APPDATA%\media-viewer\media_viewer_host.json
#   Registry → HKCU\Software\Mozilla\NativeMessagingHosts\media_viewer_host
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [--break-system-packages]
#
# The optional --break-system-packages flag is passed through to pip on systems
# that enforce PEP 668 externally-managed environments (rare on Windows).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$BreakSystem = $args -contains '--break-system-packages'

# ── Locate Python ──────────────────────────────────────────────────────────────
$PyLauncher = (Get-Command py     -ErrorAction SilentlyContinue)?.Source
$PyExe      = (Get-Command python -ErrorAction SilentlyContinue)?.Source

if ($PyLauncher) {
    $PythonExe = $PyLauncher
    $PipArgs   = @('-m', 'pip')
} elseif ($PyExe) {
    $PythonExe = $PyExe
    $PipArgs   = @('-m', 'pip')
} else {
    Write-Error "Python not found.  Install Python 3 from https://www.python.org/ and re-run."
    exit 1
}
Write-Host "Using Python: $PythonExe"

# ── Install Python package via pip ────────────────────────────────────────────

$PkgSpec   = $ScriptDir   # local directory install
$InstallCmd = @($PythonExe) + $PipArgs + @(
    'install', '--user', '--no-cache-dir', $PkgSpec
)
if ($BreakSystem) {
    $InstallCmd += '--break-system-packages'
}

Write-Host "Installing package: $($InstallCmd -join ' ')"
& $InstallCmd[0] $InstallCmd[1..($InstallCmd.Count - 1)]
if ($LASTEXITCODE -ne 0) {
    Write-Error "pip install failed (exit $LASTEXITCODE)."
    exit 1
}
Write-Host "Package installed."

# ── Locate the installed host script ──────────────────────────────────────────
# pip --user on Windows installs console-script .exe wrappers into
# %APPDATA%\Python\PythonXY\Scripts\.  Ask Python where that is.

$ScriptsDir = & $PythonExe -c @"
import sysconfig, sys
# 'nt' user scheme on Windows
scheme = 'nt_user' if sys.platform == 'win32' else 'posix_user'
print(sysconfig.get_path('scripts', scheme))
"@
$ScriptsDir = $ScriptsDir.Trim()

$HostExe = Join-Path $ScriptsDir 'media_native_host.exe'
if (-not (Test-Path $HostExe)) {
    # Fallback: scripts may land alongside python.exe in some setups
    $HostExe = Join-Path (Split-Path $PythonExe) 'Scripts\media_native_host.exe'
}
if (-not (Test-Path $HostExe)) {
    Write-Error "Could not find media_native_host.exe after installation.  Looked in:`n  $ScriptsDir`n  $(Split-Path $PythonExe)\Scripts\"
    exit 1
}
Write-Host "Host binary: $HostExe"

# ── Directories ────────────────────────────────────────────────────────────────
$AppData      = $env:APPDATA
$LocalAppData = $env:LOCALAPPDATA

if (-not $AppData)      { Write-Error '%APPDATA% is not set.';      exit 1 }
if (-not $LocalAppData) { Write-Error '%LOCALAPPDATA% is not set.'; exit 1 }

$ManifestDir = Join-Path $AppData      'media-viewer'
$QueueDir    = Join-Path $LocalAppData 'media-viewer\queue'

# ── Write native messaging manifest ───────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null

$ManifestPath = Join-Path $ManifestDir 'media_viewer_host.json'
$Manifest = @{
    name               = 'media_viewer_host'
    description        = 'Native messaging host for the Media Viewer Firefox extension'
    path               = $HostExe
    type               = 'stdio'
    allowed_extensions = @('media-viewer@xplat.github.io')
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($ManifestPath, $Manifest)
Write-Host "Installed manifest: $ManifestPath"

# ── Register in Windows registry ───────────────────────────────────────────────
# Firefox reads HKCU\Software\Mozilla\NativeMessagingHosts\<name> (REG_SZ)
# where the default value is the full path to the manifest JSON.

$RegKey = 'HKCU:\Software\Mozilla\NativeMessagingHosts\media_viewer_host'
New-Item     -Path $RegKey -Force        | Out-Null
Set-ItemProperty -Path $RegKey -Name '(Default)' -Value $ManifestPath
Write-Host "Registry entry: $RegKey -> $ManifestPath"

# ── Create queue directory ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $QueueDir | Out-Null
Write-Host "Queue directory: $QueueDir"

Write-Host ""
Write-Host "Done.  Load the media-extension\ directory as a temporary extension"
Write-Host "in Firefox (about:debugging → Load Temporary Add-on → manifest.json)."
