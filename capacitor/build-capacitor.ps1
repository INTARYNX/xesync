# Assemble capacitor/www/ from the shared web app + capacitor/bridge.src.js,
# then build the Android APK inside the podman container (see Containerfile).
#
# Unlike deploy.ps1, nothing needs single-file inlining here - Capacitor
# happily serves a normal multi-file www/ directory - so this only does the
# ROWING_DISPLAY marker substitution deploy.ps1 also does, then copies
# everything else through untouched.
#
# Usage:
#   cd capacitor
#   .\build-capacitor.ps1                # debug APK
#   .\build-capacitor.ps1 -Release        # release AAB, signed with keys/upload.keystore
#                                         # (see README.md - Play Console setup)

param(
    [switch]$Release,
    [switch]$SkipImageBuild
)

# Deliberately NOT $ErrorActionPreference = 'Stop': in Windows PowerShell
# 5.1, that also turns benign stderr chatter from native exes (npm, npx,
# podman, gradlew) into a terminating NativeCommandError even when the
# process exits 0. Every native call below is checked via $LASTEXITCODE
# instead; PowerShell cmdlets that must not fail silently pass their own
# -ErrorAction Stop.
$capDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root    = Split-Path -Parent $capDir
$www     = Join-Path $capDir 'www'
$utf8    = [System.Text.Encoding]::UTF8
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Read-Utf8($path)  { [IO.File]::ReadAllText($path, $utf8) }
function Write-Utf8NoBom($path, $content) { [IO.File]::WriteAllText($path, $content, $utf8NoBom) }

# ── 1. reset www/ FIRST ─────────────────────────────────────────────────────
# esbuild writes straight into www/bridge.js (step 2 below), so www/ must
# already be a clean, existing directory before that runs - otherwise this
# reset would delete the bridge.js esbuild just built, with nothing left to
# put it back (this bit the first run of this script).
Write-Host "Resetting www/..."
Remove-Item -Recurse -Force $www -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $www | Out-Null

# ── 2. bundle bridge.src.js -> www/bridge.js (needs npm deps installed once) ──
Write-Host "Building bridge.js (esbuild)..."
Push-Location $capDir
if (-not (Test-Path 'node_modules')) {
    npm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "npm install failed"; exit 1 }
}
npm run build:bridge
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "esbuild failed"; exit 1 }
Pop-Location

# ── 3. copy the rest of www/ ─────────────────────────────────────────────────
Write-Host "Assembling www/..."

# Shared modules, unchanged - bridge.js is NOT copied from root, we use the
# Capacitor one built above.
$sharedFiles = @(
    'app.css', 'state.js', 'view.js', 'api.js', 'debug.js',
    'ftms_integration.js', 'controller.js', 'debug_sim.js', 'config.js',
    'rowing_display.css', 'rowing_display.js', 'dialog.css',
    'SpaceGrotesk-Regular.ttf'
)
foreach ($f in $sharedFiles) {
    Copy-Item (Join-Path $root $f) (Join-Path $www $f) -Force -ErrorAction Stop
}

# app.html -> www/index.html: Capacitor requires index.html as the native
# shell's entry point (its `cap add android`/`cap sync` copy step hard-fails
# without one - hit this on the first real build). Inject rowing_display.html's
# <body> at the marker, plus its stylesheet <link> tags in <head> (kept as
# separate files, no inlining needed for a Capacitor www/ dir).
$rd = Read-Utf8 (Join-Path $root 'rowing_display.html')
$bodyMatch = [regex]::Match($rd, '(?s)<body[^>]*>(.*?)</body>')
if (-not $bodyMatch.Success) { Write-Error "Could not find <body> in rowing_display.html"; exit 1 }
$rowingContent = $bodyMatch.Groups[1].Value.Trim()

$app = Read-Utf8 (Join-Path $root 'app.html')
if ($app -notmatch '<!-- ROWING_DISPLAY -->') { Write-Error "<!-- ROWING_DISPLAY --> marker not found in app.html"; exit 1 }
$app = $app -replace '</head>', "<link rel=`"stylesheet`" href=`"rowing_display.css`">`n<link rel=`"stylesheet`" href=`"dialog.css`">`n</head>"
$app = $app -replace '<!-- ROWING_DISPLAY -->', $rowingContent
Write-Utf8NoBom (Join-Path $www 'index.html') $app

Write-Host "www/ assembled: $www"

# ── 4. build the Android APK inside podman ──────────────────────────────────
$image = 'xesync-android-build'
if (-not $SkipImageBuild) {
    Write-Host "Building container image ($image)..."
    podman build -t $image -f (Join-Path $capDir 'Containerfile') $capDir
    if ($LASTEXITCODE -ne 0) { Write-Error "podman build failed"; exit 1 }
}

# Named volumes so gradle/SDK caches survive between builds instead of
# re-downloading everything each run. xesync-android-home persists
# ~/.android (specifically debug.keystore) - without it every container run
# (--rm, throwaway filesystem) generates a NEW random debug signing key, so
# `adb install -r` starts failing with INSTALL_FAILED_UPDATE_INCOMPATIBLE
# on the very next build (hit this while iterating on device).
podman volume create xesync-gradle-cache | Out-Null
podman volume create xesync-android-home | Out-Null

# Release builds an AAB (bundleRelease) - what Play Store/fastlane actually
# want - signed via android/key.properties -> keys/upload.keystore (both
# gitignored). Debug still builds an installable APK for on-device testing.
if ($Release) {
    if (-not (Test-Path (Join-Path $capDir 'keys\upload.keystore'))) {
        Write-Error "keys/upload.keystore not found - see README.md to generate one before building -Release"
        exit 1
    }
    $variant = 'bundleRelease'
} else {
    $variant = 'assembleDebug'
}
$cmd = @"
set -e
cd /work/capacitor
if [ ! -d android ]; then npx cap add android; fi
npx cap sync android
cd android
./gradlew $variant
"@

Write-Host "Running Android build ($variant) in container..."
podman run --rm `
    -v "${root}:/work:Z" `
    -v "xesync-gradle-cache:/root/.gradle" `
    -v "xesync-android-home:/root/.android" `
    -w /work/capacitor `
    $image $cmd
if ($LASTEXITCODE -ne 0) { Write-Error "Android build failed"; exit 1 }

if ($Release) {
    $out = Join-Path $capDir 'android\app\build\outputs\bundle\release\app-release.aab'
    Write-Host "Build complete. AAB: $out"
} else {
    $apkDir = Join-Path $capDir 'android\app\build\outputs\apk'
    Write-Host "Build complete. APK(s) under: $apkDir"
}
