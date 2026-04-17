<#
.SYNOPSIS
    Pre-initialize OpenCode environment (DB, plugins, migrations) so first launch is instant.
.PARAMETER OpencodePath
    Path to the opencode executable. Defaults to 'opencode' on PATH.
#>
param(
    [Alias("opencode-path")]
    [string]$OpencodePath = "opencode"
)

$ErrorActionPreference = "Stop"

# --- Colors ---
function Write-Step  { param([string]$msg) Write-Host "  [*] $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [✓] $msg" -ForegroundColor Green }
function Write-Fail  { param([string]$msg) Write-Host "  [✗] $msg" -ForegroundColor Red }
function Write-Warn  { param([string]$msg) Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Title { param([string]$msg) Write-Host "`n$msg" -ForegroundColor White }

Write-Title "=== OpenCode Pre-Initialization ==="

# --- Step 1: Check bun ---
Write-Step "Checking bun..."
try {
    $bunVersion = & bun --version 2>&1
    $major = [int]($bunVersion -split '\.')[0]
    if ($major -lt 1) {
        Write-Fail "bun version $bunVersion is below 1.0"
        exit 1
    }
    Write-Ok "bun $bunVersion"
} catch {
    Write-Fail "bun not found. Install from https://bun.sh"
    exit 1
}

# --- Step 2: Config directory ---
$configDir = Join-Path $env:USERPROFILE ".config" "opencode"
Write-Step "Ensuring config directory: $configDir"
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    Write-Ok "Created $configDir"
} else {
    Write-Ok "Already exists"
}

# --- Step 3: Pre-install @opencode-ai/plugin ---
Write-Step "Installing @opencode-ai/plugin..."

# Check for .opencode directory in current project, or use config dir
$opencodeLocalDirs = @()
foreach ($name in @(".opencode", ".claude")) {
    $candidate = Join-Path (Get-Location) $name
    if (Test-Path $candidate) { $opencodeLocalDirs += $candidate }
}
if ($opencodeLocalDirs.Count -eq 0) {
    $opencodeLocalDirs = @($configDir)
}

foreach ($dir in $opencodeLocalDirs) {
    Write-Step "  npm install in $dir"
    try {
        Push-Location $dir

        # Ensure .gitignore exists so node_modules is ignored
        $gitignorePath = Join-Path $dir ".gitignore"
        if (-not (Test-Path $gitignorePath)) {
            Set-Content -Path $gitignorePath -Value "node_modules`npackage.json`npackage-lock.json`nbun.lock`n.gitignore"
        }

        & npm install --save "@opencode-ai/plugin" 2>&1 | Out-Null
        Write-Ok "  Installed in $dir"
    } catch {
        Write-Warn "  npm install failed in ${dir}: $_"
    } finally {
        Pop-Location
    }
}

# --- Step 4: Trigger DB init via opencode ---
Write-Step "Triggering DB initialization..."
$opencodeCmd = $OpencodePath
try {
    $null = & $opencodeCmd version 2>&1
    Write-Ok "opencode found: $opencodeCmd"

    Write-Step "Running 'opencode version' to trigger DB migration..."
    & $opencodeCmd version 2>&1 | Out-Null
    Write-Ok "DB initialization triggered"
} catch {
    Write-Warn "opencode not found at '$opencodeCmd'. Skipping DB init."
    Write-Warn "DB will be initialized on first launch."
}

# --- Step 5: WAL cleanup ---
$dataDir = Join-Path $env:USERPROFILE ".local" "share" "opencode"
if (-not (Test-Path $dataDir)) {
    # Fallback: some installs use config dir for data
    $dataDir = $configDir
}

$dbPath = Join-Path $dataDir "opencode.db"
$walPath = "$dbPath-wal"

if (Test-Path $walPath) {
    $walSize = (Get-Item $walPath).Length
    if ($walSize -gt 1MB) {
        Write-Step "WAL file is $('{0:N1}' -f ($walSize/1MB)) MB, attempting checkpoint..."
        try {
            $sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
            if ($sqlite) {
                & sqlite3 $dbPath "PRAGMA wal_checkpoint(TRUNCATE);" 2>&1 | Out-Null
                Write-Ok "WAL checkpoint complete"
            } else {
                Write-Warn "sqlite3 not found, skipping WAL cleanup"
            }
        } catch {
            Write-Warn "WAL checkpoint failed: $_"
        }
    } else {
        Write-Ok "WAL file is small ($('{0:N0}' -f ($walSize/1KB)) KB), no cleanup needed"
    }
} else {
    Write-Ok "No WAL file to clean up"
}

# --- Step 6: Verify ---
Write-Title "=== Verification ==="

$allOk = $true

# Check DB
if (Test-Path $dbPath) {
    Write-Ok "Database exists: $dbPath"
} else {
    Write-Warn "Database not found (will be created on first launch)"
}

# Check plugin
$pluginFound = $false
foreach ($dir in $opencodeLocalDirs) {
    $pluginPath = Join-Path $dir "node_modules" "@opencode-ai" "plugin"
    if (Test-Path $pluginPath) {
        Write-Ok "Plugin installed: $pluginPath"
        $pluginFound = $true
        break
    }
}
if (-not $pluginFound) {
    Write-Fail "Plugin @opencode-ai/plugin not found"
    $allOk = $false
}

Write-Title "=== Done ==="
if ($allOk) {
    Write-Ok "OpenCode pre-initialization complete!"
} else {
    Write-Warn "Completed with warnings. Check messages above."
}
