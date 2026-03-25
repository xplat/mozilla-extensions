# install.ps1 — Install the CBZ Viewer native messaging host on Windows
#
# Installs:
#   - cbz_native_host.py   → %APPDATA%\cbz-viewer\
#   - cbz-open.py          → %APPDATA%\cbz-viewer\   (invoke with: py cbz-open.py)
#   - cbz-open.cmd         → %APPDATA%\cbz-viewer\   (wrapper; add dir to PATH)
#   - host manifest JSON   → %APPDATA%\cbz-viewer\cbz_viewer_host.json
#   - Registry entry       → HKCU\Software\Mozilla\NativeMessagingHosts\cbz_viewer_host
#   - Queue directory      → %LOCALAPPDATA%\cbz-viewer\queue\
#
# Run from the cbz-native\ directory (or any location; uses $PSScriptRoot).
# Requires Python 3 to be installed and on PATH (or available via the
# Python Launcher `py`).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = $PSScriptRoot

# ── Locate Python ──────────────────────────────────────────────────────────────
# Prefer the Python Launcher (py.exe, installed with official Python for Windows)
# so the correct version is selected automatically.  Fall back to python.exe.

$PyLauncher = (Get-Command py   -ErrorAction SilentlyContinue)?.Source
$PyExe      = (Get-Command python -ErrorAction SilentlyContinue)?.Source

if ($PyLauncher) {
    $PythonCmd = 'py'
    $PythonExe = $PyLauncher
} elseif ($PyExe) {
    $PythonCmd = 'python'
    $PythonExe = $PyExe
} else {
    Write-Error "Python not found.  Install Python 3 from https://www.python.org/ and re-run."
    exit 1
}
Write-Host "Using Python: $PythonExe"

# ── Directories ────────────────────────────────────────────────────────────────
$AppData      = $env:APPDATA
$LocalAppData = $env:LOCALAPPDATA

if (-not $AppData)      { Write-Error '%APPDATA% is not set.';      exit 1 }
if (-not $LocalAppData) { Write-Error '%LOCALAPPDATA% is not set.'; exit 1 }

$InstallDir = Join-Path $AppData      'cbz-viewer'
$QueueDir   = Join-Path $LocalAppData 'cbz-viewer\queue'

# ── Install host script ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Copy-Item -Force (Join-Path $ScriptDir 'cbz_native_host.py') `
          (Join-Path $InstallDir 'cbz_native_host.py')
Write-Host "Installed host: $InstallDir\cbz_native_host.py"

# ── Install cbz-open ───────────────────────────────────────────────────────────
# Copy the cbz-open script (same Python file, rename for clarity).
Copy-Item -Force (Join-Path $ScriptDir 'cbz-open') `
          (Join-Path $InstallDir 'cbz-open.py')

# Create a .cmd wrapper so `cbz-open` works from any Command Prompt / PowerShell
# once $InstallDir is added to PATH.
$CmdWrapper = "@echo off`r`n$PythonCmd `"%~dp0cbz-open.py`" %*`r`n"
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'cbz-open.cmd'), $CmdWrapper)
Write-Host "Installed command wrapper: $InstallDir\cbz-open.cmd"
Write-Host ""
Write-Host "  To use cbz-open from anywhere, add this directory to your PATH:"
Write-Host "    $InstallDir"
Write-Host "  (System → Advanced system settings → Environment Variables → Path)"

# ── Write native messaging manifest ───────────────────────────────────────────
# Firefox on Windows requires the manifest path to be registered in the registry.
# The manifest itself can live anywhere; we store it alongside the host script.

$HostScript  = Join-Path $InstallDir 'cbz_native_host.py'

# Create a .cmd launcher that Firefox will invoke as the "path" in the manifest.
# (Firefox on Windows passes the manifest "path" directly to CreateProcess, so
#  it must be an executable — .cmd files qualify.)
$LauncherPath = Join-Path $InstallDir 'cbz_native_host.cmd'
$LauncherContent = "@echo off`r`n$PythonCmd `"$HostScript`" %*`r`n"
[System.IO.File]::WriteAllText($LauncherPath, $LauncherContent)

$ManifestPath = Join-Path $InstallDir 'cbz_viewer_host.json'
$Manifest = @{
    name               = 'cbz_viewer_host'
    description        = 'Native messaging host for the CBZ Viewer extension'
    path               = $LauncherPath
    type               = 'stdio'
    allowed_extensions = @('cbz-viewer@xplat.github.io')
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($ManifestPath, $Manifest)
Write-Host "Installed manifest: $ManifestPath"

# ── Register in Windows registry ───────────────────────────────────────────────
# Firefox reads HKCU\Software\Mozilla\NativeMessagingHosts\<name> (REG_SZ)
# where the value is the full path to the manifest JSON.

$RegKey = 'HKCU:\Software\Mozilla\NativeMessagingHosts\cbz_viewer_host'
New-Item     -Path $RegKey -Force        | Out-Null
Set-ItemProperty -Path $RegKey -Name '(Default)' -Value $ManifestPath
Write-Host "Registry entry: $RegKey -> $ManifestPath"

# ── Create queue directory ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $QueueDir | Out-Null
Write-Host "Queue directory: $QueueDir"

Write-Host ""
Write-Host "Installation complete."
Write-Host ""
Write-Host "Usage:  cbz-open C:\path\to\comic.cbz [page]"
Write-Host "  (run from $InstallDir, or add that directory to PATH)"
Write-Host ""
Write-Host "Firefox must be running with the CBZ Viewer extension installed."
