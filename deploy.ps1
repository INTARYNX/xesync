# Build inline app.html, then deploy the full site to the remote server via SSH/SCP.

# ── Load local config ─────────────────────────────────────────────────────────
$configFile = Join-Path (Split-Path -Parent (Resolve-Path 'app.html')) 'deploy.config.ps1'
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

$base      = Split-Path -Parent (Resolve-Path 'app.html')
$utf8      = [System.Text.Encoding]::UTF8
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Read-Utf8($path) {
    return [IO.File]::ReadAllText($path, $utf8)
}

function Write-Utf8NoBom($path, $content) {
    [IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

function Get-Inlined($path) {
    if ($path -match '^https?://') {
        return (Invoke-WebRequest -Uri $path -UseBasicParsing).Content
    }
    if (-not [IO.Path]::IsPathRooted($path)) {
        $path = Join-Path $base $path
    }
    return Read-Utf8 $path
}

# ── Build deploy/app.html ─────────────────────────────────────────────────────

Write-Host "Reading rowing_display.html..."
$rd = Read-Utf8 (Join-Path $base 'rowing_display.html')

# Inline CSS <link> tags → collect as <style> blocks
$styles = [System.Collections.Generic.List[string]]::new()
$rd = [regex]::Replace($rd, '<link[^>]*href=[''"]([^''"]+)[''"][^>]*>', {
    $css = Get-Inlined $args[0].Groups[1].Value
    $styles.Add("<style>`n$css`n</style>")
    ''   # remove from body
}, 'IgnoreCase')

# Inline JS <script src> tags in rowing_display.html
$rd = [regex]::Replace($rd, '<script([^>]*)\s+src=[''"]([^''"]+)[''"][^>]*>\s*</script>', {
    $attrs = $args[0].Groups[1].Value
    $js = Get-Inlined $args[0].Groups[2].Value
    "<script$attrs>`n$js`n</script>"
}, 'IgnoreCase')

# Extract <body> content from rowing_display.html
$bodyMatch = [regex]::Match($rd, '(?s)<body[^>]*>(.*?)</body>')
if (-not $bodyMatch.Success) {
    Write-Error "Could not find <body> in rowing_display.html"
    exit 1
}
$rowingContent = $bodyMatch.Groups[1].Value.Trim()

Write-Host "Reading and processing app.html..."
$app = Read-Utf8 (Join-Path $base 'app.html')

if ($app -notmatch '<!-- ROWING_DISPLAY -->') {
    Write-Error "<!-- ROWING_DISPLAY --> marker not found in app.html"
    exit 1
}

# Inject rowing CSS into <head>
$rowingStyles = $styles -join "`n"
$app = $app -replace '</head>', "$rowingStyles`n</head>"

# Inject rowing HTML at marker
$app = $app -replace '<!-- ROWING_DISPLAY -->', $rowingContent

# Inline CSS <link> tags in app.html
$app = [regex]::Replace($app, '<link[^>]*href=[''"]([^''"]+\.css)[''"][^>]*>', {
    $css = Get-Inlined $args[0].Groups[1].Value
    "<style>`n$css`n</style>"
}, 'IgnoreCase')

# Inline JS <script src> tags in app.html
$app = [regex]::Replace($app, '<script([^>]*)\s+src=[''"]([^''"]+)[''"][^>]*>\s*</script>', {
    $attrs = $args[0].Groups[1].Value
    $js = Get-Inlined $args[0].Groups[2].Value
    "<script$attrs>`n$js`n</script>"
}, 'IgnoreCase')

# ── Assemble staging (dist/) ──────────────────────────────────────────────────

Write-Host "Assembling dist/..."
$dist = Join-Path $base 'dist'
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dist | Out-Null

# Site pages and assets
Copy-Item (Join-Path $base 'site\*') $dist -Recurse

# Write built app directly into dist/
Write-Utf8NoBom (Join-Path $dist 'app.html') $app
Write-Host "Build complete: $(Join-Path $dist 'app.html')"

# Root-level assets (app.css is inlined into app.html, no need to copy)
foreach ($asset in @('DotGothic16-Regular.ttf', 'test_app.html', 'home.html', 'home.css', 'config.js')) {
    $src = Join-Path $base $asset
    if (Test-Path $src) { Copy-Item $src $dist }
}

# debug_sim.js is inlined into app.html via the <script src> regex above

# ── Deploy via SCP ────────────────────────────────────────────────────────────

Write-Host "Deploying to $SSH_USER@${SSH_HOST}:$REMOTE_DIR ..."

# Ensure remote directory exists
& ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new `
    "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_DIR" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "SSH failed (exit $LASTEXITCODE). Check your key and host."
    exit 1
}

# Upload contents of dist/ to remote dir
& scp -i $SSH_KEY -o StrictHostKeyChecking=accept-new -r "$dist\*" `
    "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/"
if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP upload failed (exit $LASTEXITCODE)."
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