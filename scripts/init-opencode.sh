#!/usr/bin/env bash
#
# Pre-initialize OpenCode environment (DB, plugins, migrations) so first launch is instant.
# Usage: ./init-opencode.sh [--opencode-path /path/to/opencode]
#
set -euo pipefail

# --- Args ---
OPENCODE_CMD="opencode"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --opencode-path) OPENCODE_CMD="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# --- Colors ---
step()  { printf '  \033[36m[*]\033[0m %s\n' "$*"; }
ok()    { printf '  \033[32m[✓]\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m[✗]\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m[!]\033[0m %s\n' "$*"; }
title() { printf '\n\033[1m%s\033[0m\n' "$*"; }

title "=== OpenCode Pre-Initialization ==="

# --- Step 1: Check bun ---
step "Checking bun..."
if ! command -v bun &>/dev/null; then
    fail "bun not found. Install from https://bun.sh"
    exit 1
fi
BUN_VERSION=$(bun --version)
BUN_MAJOR=$(echo "$BUN_VERSION" | cut -d. -f1)
if [[ "$BUN_MAJOR" -lt 1 ]]; then
    fail "bun version $BUN_VERSION is below 1.0"
    exit 1
fi
ok "bun $BUN_VERSION"

# --- Step 2: Config directory ---
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
step "Ensuring config directory: $CONFIG_DIR"
if [[ ! -d "$CONFIG_DIR" ]]; then
    mkdir -p "$CONFIG_DIR"
    ok "Created $CONFIG_DIR"
else
    ok "Already exists"
fi

# --- Step 3: Pre-install @opencode-ai/plugin ---
step "Installing @opencode-ai/plugin..."

INSTALL_DIRS=()
for name in .opencode .claude; do
    candidate="$(pwd)/$name"
    [[ -d "$candidate" ]] && INSTALL_DIRS+=("$candidate")
done
[[ ${#INSTALL_DIRS[@]} -eq 0 ]] && INSTALL_DIRS=("$CONFIG_DIR")

for dir in "${INSTALL_DIRS[@]}"; do
    step "  npm install in $dir"

    # Ensure .gitignore
    gitignore="$dir/.gitignore"
    if [[ ! -f "$gitignore" ]]; then
        printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n' > "$gitignore"
    fi

    if (cd "$dir" && npm install --save @opencode-ai/plugin) &>/dev/null; then
        ok "  Installed in $dir"
    else
        warn "  npm install failed in $dir"
    fi
done

# --- Step 4: Trigger DB init via opencode ---
step "Triggering DB initialization..."
if command -v "$OPENCODE_CMD" &>/dev/null; then
    ok "opencode found: $OPENCODE_CMD"
    step "Running 'opencode version' to trigger DB migration..."
    if "$OPENCODE_CMD" version &>/dev/null; then
        ok "DB initialization triggered"
    else
        warn "opencode version command failed, DB may init on first launch"
    fi
else
    warn "opencode not found at '$OPENCODE_CMD'. Skipping DB init."
    warn "DB will be initialized on first launch."
fi

# --- Step 5: WAL cleanup ---
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
[[ ! -d "$DATA_DIR" ]] && DATA_DIR="$CONFIG_DIR"

DB_PATH="$DATA_DIR/opencode.db"
WAL_PATH="${DB_PATH}-wal"

if [[ -f "$WAL_PATH" ]]; then
    WAL_SIZE=$(stat -c%s "$WAL_PATH" 2>/dev/null || stat -f%z "$WAL_PATH" 2>/dev/null || echo 0)
    if [[ "$WAL_SIZE" -gt 1048576 ]]; then
        step "WAL file is $((WAL_SIZE / 1048576)) MB, attempting checkpoint..."
        if command -v sqlite3 &>/dev/null; then
            if sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" &>/dev/null; then
                ok "WAL checkpoint complete"
            else
                warn "WAL checkpoint failed"
            fi
        else
            warn "sqlite3 not found, skipping WAL cleanup"
        fi
    else
        ok "WAL file is small ($((WAL_SIZE / 1024)) KB), no cleanup needed"
    fi
else
    ok "No WAL file to clean up"
fi

# --- Step 6: Verify ---
title "=== Verification ==="

ALL_OK=true

if [[ -f "$DB_PATH" ]]; then
    ok "Database exists: $DB_PATH"
else
    warn "Database not found (will be created on first launch)"
fi

PLUGIN_FOUND=false
for dir in "${INSTALL_DIRS[@]}"; do
    if [[ -d "$dir/node_modules/@opencode-ai/plugin" ]]; then
        ok "Plugin installed: $dir/node_modules/@opencode-ai/plugin"
        PLUGIN_FOUND=true
        break
    fi
done
if ! $PLUGIN_FOUND; then
    fail "Plugin @opencode-ai/plugin not found"
    ALL_OK=false
fi

title "=== Done ==="
if $ALL_OK; then
    ok "OpenCode pre-initialization complete!"
else
    warn "Completed with warnings. Check messages above."
fi
