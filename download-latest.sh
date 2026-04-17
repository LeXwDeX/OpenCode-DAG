#!/usr/bin/env bash
# =============================================================================
# download-latest.sh — Linux / macOS 下载最新 opencode 二进制（本仓库 fork）
#
# 行为：
#   - 上游：github.com/LeXwDeX/opencode（本仓库 fork，与 ./install REPO 默认值一致）
#   - 目标目录：<repo>/packages/opencode/<tag>/（而非 ~/.opencode/bin）
#   - 预先查询 GitHub API 拿到 latest tag，再把版本号拼进 INSTALL_DIR
#
# 用法：
#   bash ./download-latest.sh
#   FORCE=1 bash ./download-latest.sh            # 已存在则覆盖
#   OPENCODE_REPO=foo/bar bash ./download-latest.sh   # 临时切到其他 fork
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/install"
REPO="${OPENCODE_REPO:-LeXwDeX/opencode}"

if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "Error: official installer not found at ${INSTALL_SCRIPT}" >&2
    exit 1
fi

# 预查询 latest tag（install 脚本内部会再查一次——我们这里查是为了拼 INSTALL_DIR）
echo "[1/2] Resolving latest tag from github.com/${REPO}"
latest_tag=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
if [ -z "$latest_tag" ]; then
    echo "Error: failed to resolve latest tag from ${REPO}" >&2
    exit 1
fi
echo "      latest: ${latest_tag}"

TARGET_DIR="${SCRIPT_DIR}/packages/opencode/${latest_tag}"
if [ -f "${TARGET_DIR}/opencode" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "[ok] Already present: ${TARGET_DIR}/opencode (use FORCE=1 to re-download)"
    exit 0
fi
mkdir -p "$TARGET_DIR"

echo "[2/2] Invoking ./install with OPENCODE_REPO=${REPO} OPENCODE_INSTALL_DIR=${TARGET_DIR}"
OPENCODE_REPO="$REPO" OPENCODE_INSTALL_DIR="$TARGET_DIR" exec bash "$INSTALL_SCRIPT" "$@"
