# install-common.ps1 — shared install logic for Windows native messaging hosts.
#
# Dot-source this from a component install.ps1 after setting:
#   $PkgDir       absolute path to the component directory
#   $PkgName      pip package name          e.g. cbz-viewer-host
#   $HostBinName  installed binary name     e.g. cbz_native_host
#   $HostId       native messaging host ID  e.g. cbz_viewer_host
#   $HostDesc     one-line manifest description
#   $AllowedExt   extension ID              e.g. cbz-viewer@xplat.github.io
#   $AppName      app name for directories  e.g. cbz-viewer
#   $ExtensionDir extension subdirectory    e.g. cbz-extension
#
# Platform directories used:
#   Package  → pip --user  (%APPDATA%\Python\PythonXY\Scripts\)
#   Queue    → %LOCALAPPDATA%\<AppName>\queue\
#   Manifest → %APPDATA%\<AppName>\<HostId>.json
#   Registry → HKCU\Software\Mozilla\NativeMessagingHosts\<HostId>
#
# Accepts optional argument:
#   --break-system-packages   passed to pip on PEP 668 systems (rare on Windows)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# $PSScriptRoot here is the calling (wrapper) script's directory, so its
# parent is the repo root, which is where native-shared lives.
$SharedDir   = Join-Path (Split-Path -Parent $PSScriptRoot) 'native-shared'
$BreakSystem = $args -contains '--break-system-packages'

# ── Locate Python ──────────────────────────────────────────────────────────────
# Prefer the Python Launcher (py.exe) so the right version is selected
# automatically.  Fall back to python.exe.

$PyLauncher = (Get-Command py     -ErrorAction SilentlyContinue)?.Source
$PyExe      = (Get-Command python -ErrorAction SilentlyContinue)?.Source

if     ($PyLauncher) { $PythonExe = $PyLauncher }
elseif ($PyExe)      { $PythonExe = $PyExe }
else {
    Write-Error 'Python not found.  Install Python 3 from https://www.python.org/ and re-run.'
    exit 1
}
Write-Host "Using Python: $PythonExe"

# ── Install Python packages ────────────────────────────────────────────────────
# Install viewer-host-utils (local shared package) and the component package
# together in one pip invocation.  File URIs need forward slashes on Windows.

$PkgUri     = 'file:///' + ($PkgDir    -replace '\\', '/')
$SharedUri  = 'file:///' + ($SharedDir -replace '\\', '/')
$PkgSpec    = "$PkgName @ $PkgUri"
$SharedSpec = "viewer-host-utils @ $SharedUri"

$PipArgs = @('-m', 'pip', 'install', '--user', '--no-cache-dir', $SharedSpec, $PkgSpec)
if ($BreakSystem) { $PipArgs += '--break-system-packages' }

Write-Host 'Installing packages...'
& $PythonExe @PipArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "pip install failed (exit $LASTEXITCODE)."
    exit 1
}
Write-Host 'Packages installed.'

# ── Locate the installed host binary ──────────────────────────────────────────
# pip --user creates .exe wrappers in the user Scripts directory.
# Ask Python where that is to handle non-standard setups correctly.

$ScriptsDir = (& $PythonExe -c @'
import sysconfig, sys
scheme = 'nt_user' if sys.platform == 'win32' else 'posix_user'
print(sysconfig.get_path('scripts', scheme))
'@).Trim()

$HostExe = Join-Path $ScriptsDir "$HostBinName.exe"
if (-not (Test-Path $HostExe)) {
    # Fallback: some setups place scripts alongside python.exe
    $HostExe = Join-Path (Split-Path $PythonExe) "Scripts\$HostBinName.exe"
}
if (-not (Test-Path $HostExe)) {
    Write-Error "Could not find $HostBinName.exe after installation.  Looked in:`n  $ScriptsDir`n  $(Split-Path $PythonExe)\Scripts\"
    exit 1
}
Write-Host "Host binary: $HostExe"

# ── Directories ────────────────────────────────────────────────────────────────

$AppData      = $env:APPDATA
$LocalAppData = $env:LOCALAPPDATA

if (-not $AppData)      { Write-Error '%APPDATA% is not set.';      exit 1 }
if (-not $LocalAppData) { Write-Error '%LOCALAPPDATA% is not set.'; exit 1 }

$ManifestDir = Join-Path $AppData      $AppName
$QueueDir    = Join-Path $LocalAppData "$AppName\queue"

# ── Write native messaging manifest ───────────────────────────────────────────
# Firefox on Windows reads the manifest path from the registry; the manifest
# itself can live anywhere — we keep it alongside the queue directory parent.

New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null

$ManifestPath = Join-Path $ManifestDir "$HostId.json"
$Manifest = [ordered]@{
    name               = $HostId
    description        = $HostDesc
    path               = $HostExe
    type               = 'stdio'
    allowed_extensions = @($AllowedExt)
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($ManifestPath, $Manifest)
Write-Host "Installed manifest: $ManifestPath"

# ── Register in Windows registry ───────────────────────────────────────────────
# Firefox reads HKCU\Software\Mozilla\NativeMessagingHosts\<name> (REG_SZ)
# where the default value is the full path to the manifest JSON.

$RegKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostId"
New-Item         -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name '(Default)' -Value $ManifestPath
Write-Host "Registry entry: $RegKey -> $ManifestPath"

# ── Create queue directory ─────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $QueueDir | Out-Null
Write-Host "Queue directory: $QueueDir"

Write-Host ''
Write-Host "Done.  Load the $ExtensionDir\ directory as a temporary extension"
Write-Host 'in Firefox (about:debugging -> Load Temporary Add-on -> manifest.json).'
