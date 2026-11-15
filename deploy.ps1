# Deploy the static site (landing pages, workout-history iframe, analytics)
# to the remote server via SSH/SCP. app.html/rowing_display.* are NOT part of
# this: Capacitor bundles its own copy inside the APK (see
# capacitor/build-capacitor.ps1) and nothing - not the Capacitor app, not any
# page on this site - ever loads the server's app.html. That used to be
# AI2's WebViewer target; AI2 is retired (see ARCHITECTURE.md/README.md),
# so deploying a rowing-scene build here was dead weight.

# ── Load local config ─────────────────────────────────────────────────────────
$base       = $PSScriptRoot
$configFile = Join-Path $base 'deploy.config.ps1'
if (-not (Test-Path $configFile)) {
    Write-Error @"
Missing deploy.config.ps1. Create one in the project root with:

    `$SSH_USER   = 'your-user'
    `$SSH_HOST   = 'your.host'
    `$SSH_KEY    = "`$env:USERPROFILE\.ssh\id_rsa"
    `$REMOTE_DIR = '/path/on/server'
    `$SITE_URL   = 'https://your-site.example'

This file is gitignored so it stays local.
"@
    exit 1
}
. $configFile

# Validate required vars
foreach ($v in @('SSH_USER', 'SSH_HOST', 'SSH_KEY', 'REMOTE_DIR')) {
    if (-not (Get-Variable -Name $v -ValueOnly -ErrorAction SilentlyContinue)) {
        Write-Error "deploy.config.ps1 is missing required variable: `$v"
        exit 1
    }
}

# ── Assemble staging (dist/) ──────────────────────────────────────────────────

Write-Host "Assembling dist/..."
$dist = Join-Path $base 'dist'
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dist | Out-Null

# Site pages and assets (including subdirectories like favicon/)
Get-ChildItem (Join-Path $base 'site') | Copy-Item -Destination $dist -Recurse -Force

# Root-level assets: home.html is loaded in an iframe by the app (both the
# Capacitor-bundled copy and, historically, AI2's) for the workout-history
# view; analytics.html is its own standalone page; the rest are what those
# two need (config.js for apexHomeUrl-adjacent endpoints, home.css, the font
# it declares via @font-face). test_app.html is a leftover AI2 bridge-test
# page, harmless to keep around.
foreach ($asset in @('SpaceGrotesk-Regular.ttf', 'test_app.html', 'home.html', 'home.css', 'analytics.html', 'config.js')) {
    $src = Join-Path $base $asset
    if (Test-Path $src) { Copy-Item $src $dist }
}

# ── Deploy via SCP ────────────────────────────────────────────────────────────

Write-Host "Deploying to $SSH_USER@${SSH_HOST}:$REMOTE_DIR ..."

# Ensure remote directory exists
& ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new `
    "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_DIR" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "SSH failed (exit $LASTEXITCODE). Check your key and host."
    exit 1
}

# Upload contents of dist/ to remote dir. PowerShell does not glob-expand
# "*" for arguments handed to an external exe (unlike a POSIX shell), so
# scp used to receive the literal path "...\dist\*" and fail with "No such
# file or directory" - enumerate the top-level entries ourselves instead.
$distItems = Get-ChildItem -Path $dist | ForEach-Object { $_.FullName }
& scp -i $SSH_KEY -o StrictHostKeyChecking=accept-new -r @distItems `
    "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/"
if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP upload failed (exit $LASTEXITCODE)."
    exit 1
}

# Fix permissions so the web server can read all files and traverse directories
& ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new `
    "$SSH_USER@$SSH_HOST" "chmod -R a+rX $REMOTE_DIR"
if ($LASTEXITCODE -ne 0) {
    Write-Error "chmod failed (exit $LASTEXITCODE)."
    exit 1
}

Write-Host "Deploy complete!$(if ($SITE_URL) { ' ' + $SITE_URL })"

# ── Publish to GitHub ─────────────────────────────────────────────────────────

Write-Host "Publishing to GitHub..."
Push-Location $base
try {
    & git add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }

    # Skip commit if nothing staged
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host "No changes to commit."
    } else {
        $msg = 'deploy ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
        & git commit -m $msg
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

        & git push origin main
        if ($LASTEXITCODE -ne 0) { throw "git push failed" }

        Write-Host "Published: $msg"
    }
} catch {
    Write-Warning "GitHub publish failed: $_"
} finally {
    Pop-Location
}