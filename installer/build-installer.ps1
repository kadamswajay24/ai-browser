# ═══════════════════════════════════════════════════════════════════════════════
# AI Browser — Windows Installer Build Script
# Run this on Windows from the project root:
#   powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
#
# What it does:
#   1. Checks prerequisites (Node, NSIS)
#   2. Installs npm dependencies
#   3. Runs electron-builder to create the unpacked Windows app
#   4. Creates a placeholder LICENSE.txt if missing
#   5. Runs makensis to create AIBrowserSetup.exe
# ═══════════════════════════════════════════════════════════════════════════════

param(
    [string]$Version = "1.0.0",
    [switch]$SkipNsis        # set to skip NSIS step (just build the Electron app)
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

function Log($msg)  { Write-Host "  $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "═══════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  AI Browser Installer Builder v$Version" -ForegroundColor Magenta
Write-Host "═══════════════════════════════════════" -ForegroundColor Magenta
Write-Host ""

# ── 1. Check Node.js ──────────────────────────────────────────────────────────
Log "Checking Node.js..."
try {
    $nodeVer = node --version 2>&1
    Ok "Node.js $nodeVer"
} catch {
    Fail "Node.js not found. Install from https://nodejs.org (LTS version)"
}

# ── 2. Check npm ─────────────────────────────────────────────────────────────
Log "Checking npm..."
$npmVer = npm --version 2>&1
Ok "npm $npmVer"

# ── 3. Install dependencies ───────────────────────────────────────────────────
Log "Installing npm dependencies..."
Set-Location $Root
$result = npm install 2>&1
if ($LASTEXITCODE -ne 0) { Fail "npm install failed: $result" }
Ok "Dependencies installed"

# ── 4. Build Electron app (unpacked) ─────────────────────────────────────────
Log "Building Electron app (this takes 1-5 minutes)..."
$result = npx electron-builder --win --x64 --dir 2>&1   # --dir = unpacked only, faster
if ($LASTEXITCODE -ne 0) {
    Write-Host $result
    Fail "electron-builder failed"
}
Ok "Electron app built → dist\win-unpacked\"

# ── 5. Verify the built app exists ───────────────────────────────────────────
$appExe = Join-Path $Root "dist\win-unpacked\AI Browser.exe"
if (-not (Test-Path $appExe)) {
    Fail "Expected '$appExe' not found after build"
}
Ok "App binary: $appExe"

# ── 6. Create LICENSE.txt if missing ─────────────────────────────────────────
$licensePath = Join-Path $Root "LICENSE.txt"
if (-not (Test-Path $licensePath)) {
    @"
MIT License

Copyright (c) 2024 AI Browser

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"@ | Set-Content $licensePath
    Ok "Created LICENSE.txt"
}

if ($SkipNsis) {
    Warn "Skipping NSIS step (--SkipNsis flag set)"
    Write-Host ""
    Write-Host "  Electron app is ready at:" -ForegroundColor Green
    Write-Host "  $Root\dist\win-unpacked\" -ForegroundColor White
    exit 0
}

# ── 7. Find NSIS ─────────────────────────────────────────────────────────────
Log "Looking for NSIS (makensis.exe)..."

$nsisSearchPaths = @(
    "$env:ProgramFiles\NSIS\makensis.exe",
    "$env:ProgramFiles(x86)\NSIS\makensis.exe",
    "C:\NSIS\makensis.exe",
    (Get-Command makensis -ErrorAction SilentlyContinue)?.Source
)

$makensis = $null
foreach ($p in $nsisSearchPaths) {
    if ($p -and (Test-Path $p)) { $makensis = $p; break }
}

if (-not $makensis) {
    Warn "NSIS not found. Install NSIS 3.x from https://nsis.sourceforge.io/"
    Warn ""
    Warn "Required NSIS plugins (place in NSIS\Plugins\x86-unicode\):"
    Warn "  • InetC.dll   — https://nsis.sourceforge.io/InetC_plug-in"
    Warn "  • nsExec.dll  — included with NSIS"
    Warn "  • System.dll  — included with NSIS"
    Warn ""
    Warn "After installing NSIS and plugins, re-run this script."
    Warn ""
    Warn "Alternatively: use electron-builder's built-in NSIS (no extra plugins)."
    Warn "  Run:  npm run build   (produces dist\AIBrowserSetup.exe directly)"
    exit 0
}

Ok "Found NSIS: $makensis"

# ── 8. Check NSIS plugins ─────────────────────────────────────────────────────
$nsisDir    = Split-Path $makensis -Parent
$pluginDir  = Join-Path $nsisDir "Plugins\x86-unicode"
$inetcPath  = Join-Path $pluginDir "InetC.dll"

if (-not (Test-Path $inetcPath)) {
    Warn "InetC plugin missing at $inetcPath"
    Warn "Downloading InetC plugin automatically..."
    
    # Download InetC
    $inetcUrl  = "https://nsis.sourceforge.io/mediawiki/images/c/c5/Inetc.zip"
    $inetcZip  = "$env:TEMP\inetc.zip"
    $inetcTemp = "$env:TEMP\inetc"
    
    try {
        Invoke-WebRequest -Uri $inetcUrl -OutFile $inetcZip -UseBasicParsing
        Expand-Archive -Path $inetcZip -DestinationPath $inetcTemp -Force
        
        # Find the unicode dll
        $dll = Get-ChildItem -Path $inetcTemp -Filter "InetC.dll" -Recurse |
               Where-Object { $_.DirectoryName -like "*unicode*" } |
               Select-Object -First 1
        
        if ($dll) {
            New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
            Copy-Item $dll.FullName -Destination $inetcPath -Force
            Ok "InetC plugin installed"
        } else {
            Warn "Could not auto-install InetC. Install manually from:"
            Warn "https://nsis.sourceforge.io/InetC_plug-in"
        }
    } catch {
        Warn "Auto-download failed: $_"
        Warn "Install InetC manually from: https://nsis.sourceforge.io/InetC_plug-in"
    }
}

# ── 9. Compile NSIS installer ─────────────────────────────────────────────────
Log "Compiling NSIS installer..."
$nsiScript = Join-Path $PSScriptRoot "AIBrowser.nsi"
$outDir    = Join-Path $Root "dist"

Push-Location $PSScriptRoot
$result = & $makensis /V3 `
    /DAPP_VERSION=$Version `
    /DOUTDIR=$outDir `
    $nsiScript 2>&1
$code = $LASTEXITCODE
Pop-Location

if ($code -ne 0) {
    Write-Host $result
    Fail "makensis failed (exit code $code)"
}

$setupExe = Join-Path $PSScriptRoot "AIBrowserSetup.exe"
if (Test-Path $setupExe) {
    Move-Item $setupExe $outDir -Force
    $finalPath = Join-Path $outDir "AIBrowserSetup.exe"
} else {
    # electron-builder may have already placed it in dist/
    $finalPath = Join-Path $outDir "AIBrowserSetup.exe"
}

if (Test-Path $finalPath) {
    $size = [math]::Round((Get-Item $finalPath).Length / 1MB, 1)
    Write-Host ""
    Ok "═══════════════════════════════════════════"
    Ok "  AIBrowserSetup.exe built successfully!"
    Ok "  Path: $finalPath"
    Ok "  Size: ${size} MB"
    Ok "═══════════════════════════════════════════"
} else {
    Warn "Setup.exe not found at expected path. Check dist\ folder."
}
