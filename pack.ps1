<#
.SYNOPSIS
    Packages the Whatnot Video Receipts extension for Chrome or Firefox.

.PARAMETER Target
    The target browser: "chrome" (default) or "firefox".

.PARAMETER Crx
    Chrome only. Also produce a signed .crx (for self-hosted/dashboard upload)
    using the private key at -KeyPath, in addition to the .zip.

.PARAMETER KeyPath
    Path to the private .pem used to sign the .crx. Defaults to the key
    checked out alongside this repo in ..\whatnot-video-receipts-keys.
    On the original dev machine this was:
    C:\Users\psiki\source\repos\whatnot-video-receipts-keys\...
    Must match the "key" already baked into manifest.json, or the packed
    .crx will get a different extension ID than what's currently
    installed/published.

.PARAMETER ChromePath
    Path to chrome.exe, used only when -Crx is passed. Defaults to the
    standard Chrome install location.

.EXAMPLE
    .\pack.ps1
    .\pack.ps1 -Target firefox
    .\pack.ps1 -Target chrome -Crx
#>

param(
    [ValidateSet("chrome", "firefox")]
    [string]$Target = "chrome",

    [switch]$Crx,

    [string]$KeyPath = (Join-Path $PSScriptRoot "..\whatnot-video-receipts-keys\whatnot-video-receipt-20260516-083255-private.pem"),

    [string]$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
)

$ErrorActionPreference = "Stop"

$defaultRelativeKeyPath = (Join-Path $PSScriptRoot "..\whatnot-video-receipts-keys\whatnot-video-receipt-20260516-083255-private.pem")
$legacyWindowsKeyPath   = "C:\Users\psiki\source\repos\whatnot-video-receipts-keys\whatnot-video-receipt-20260516-083255-private.pem"

if ($Crx -and $Target -ne "chrome") {
    throw "-Crx is only valid with -Target chrome"
}

if ($Crx -and -not (Test-Path $KeyPath) -and -not $PSBoundParameters.ContainsKey("KeyPath") -and (Test-Path $legacyWindowsKeyPath)) {
    $KeyPath = $legacyWindowsKeyPath
}

if ($Crx -and -not (Test-Path $KeyPath)) {
    throw "Private key not found. Checked path: $KeyPath. When -KeyPath is omitted, this script uses these default locations: $defaultRelativeKeyPath and $legacyWindowsKeyPath. Pass -KeyPath to point at the signing key."
}

if ($Crx -and -not (Test-Path $ChromePath)) {
    throw "chrome.exe not found at $ChromePath. Pass -ChromePath to point at your Chrome install."
}

# chrome.exe --pack-extension-key fails silently ("Failed to read private key")
# on paths containing "..", so resolve to a fully-qualified path up front.
if ($Crx) {
    $KeyPath = (Resolve-Path $KeyPath).Path
}

# Files to include in the package (relative to repo root)
$files = @(
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "early_content.js",
    "injected.js",
    "advanced.js",
    "chart.umd.min.js",
    "hls.min.js",
    "icon16.png",
    "icon48.png",
    "icon128.png"
)

$root     = $PSScriptRoot
$distDir  = Join-Path $root "dist"
$stageDir = Join-Path $distDir "stage"

# Read version from manifest
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version  = $manifest.version

$zipName = "whatnot-video-receipts-v$version-$Target.zip"
$zipPath = Join-Path $distDir $zipName

# Clean stage dir
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir | Out-Null

# Copy all files into stage
foreach ($file in $files) {
    $src = Join-Path $root $file
    if (-not (Test-Path $src)) {
        Write-Warning "Skipping missing file: $file"
        continue
    }
    Copy-Item $src (Join-Path $stageDir $file)
}

# Patch manifest for Firefox
if ($Target -eq "firefox") {
    $mPath = Join-Path $stageDir "manifest.json"
    $m = Get-Content $mPath -Raw | ConvertFrom-Json

    # Remove Chrome-specific key
    $m.PSObject.Properties.Remove("key")

    # Firefox doesn't support service workers — use event page (scripts array) instead
    $m.background = [PSCustomObject]@{ scripts = @("background.js") }

    # Add Firefox extension ID
    $geckoId = "whatnot-video-receipts@extension"
    $m | Add-Member -NotePropertyName "browser_specific_settings" -NotePropertyValue @{
        gecko = @{ id = $geckoId; strict_min_version = "128.0" }
    }

    # Write back without BOM
    $json = $m | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($mPath, $json, [System.Text.UTF8Encoding]::new($false))

    Write-Host "Firefox manifest patched (gecko.id = $geckoId, strict_min_version = 128.0)"
}

# Remove old zip if it exists
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Create the zip from stage contents
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zipPath)

Write-Host ""
Write-Host "Packaged for $Target -> dist\$zipName"

# Sign a .crx from the same stage contents
if ($Crx) {
    $crxName     = "whatnot-video-receipts-v$version-$Target.crx"
    $crxPath     = Join-Path $distDir $crxName
    $stageCrx    = "$stageDir.crx"
    $stagePem    = "$stageDir.pem"

    if (Test-Path $stageCrx) { Remove-Item $stageCrx -Force }

    & $ChromePath "--pack-extension=$stageDir" "--pack-extension-key=$KeyPath" | Out-Null

    # Wait for Chrome to finish writing the .crx (it runs and exits asynchronously)
    $waited = 0
    while (-not (Test-Path $stageCrx) -and $waited -lt 20) {
        Start-Sleep -Milliseconds 500
        $waited++
    }
    if (-not (Test-Path $stageCrx)) {
        throw "chrome.exe did not produce $stageCrx"
    }

    if (Test-Path $crxPath) { Remove-Item $crxPath -Force }
    Move-Item $stageCrx $crxPath

    # Chrome only writes a .pem here if $KeyPath didn't already exist; shouldn't happen, but don't leave stray keys in dist/
    if (Test-Path $stagePem) { Remove-Item $stagePem -Force }

    Write-Host "Signed        -> dist\$crxName"
}

# Clean up stage
Remove-Item $stageDir -Recurse -Force
