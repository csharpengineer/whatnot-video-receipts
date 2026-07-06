<#
.SYNOPSIS
    Packages the Whatnot Video Receipts extension for Chrome or Firefox.

.PARAMETER Target
    The target browser: "chrome" (default) or "firefox".

.EXAMPLE
    .\pack.ps1
    .\pack.ps1 -Target firefox
    .\pack.ps1 -Target chrome
#>

param(
    [ValidateSet("chrome", "firefox")]
    [string]$Target = "chrome"
)

$ErrorActionPreference = "Stop"

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

# Clean up stage
Remove-Item $stageDir -Recurse -Force

Write-Host ""
Write-Host "Packaged for $Target -> dist\$zipName"
