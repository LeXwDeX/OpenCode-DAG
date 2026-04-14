#!/bin/sh
set -e

REPO="LeXwDeX/opencode"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY="opencode"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin)  OS="darwin" ;;
  Linux)   OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect arch
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64)  ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

NAME="opencode-${OS}-${ARCH}"

# Resolve version
if [ -n "$1" ]; then
  VERSION="$1"
  TAG="v${VERSION}"
else
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
  VERSION="${TAG#v}"
fi

if [ -z "$TAG" ]; then
  echo "Error: could not resolve latest version"
  exit 1
fi

echo "Installing ${BINARY} ${VERSION} (${OS}/${ARCH})..."

URL="https://github.com/${REPO}/releases/download/${TAG}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$OS" = "linux" ]; then
  curl -fsSL "${URL}/${NAME}.tar.gz" -o "${TMP}/archive.tar.gz"
  tar -xzf "${TMP}/archive.tar.gz" -C "$TMP"
else
  curl -fsSL "${URL}/${NAME}.zip" -o "${TMP}/archive.zip"
  unzip -q "${TMP}/archive.zip" -d "$TMP"
fi

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  chmod +x "${INSTALL_DIR}/${BINARY}"
else
  echo "Need sudo to install to ${INSTALL_DIR}"
  sudo mv "${TMP}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  sudo chmod +x "${INSTALL_DIR}/${BINARY}"
fi

echo "Installed ${BINARY} ${VERSION} to ${INSTALL_DIR}/${BINARY}"
${INSTALL_DIR}/${BINARY} --version 2>/dev/null || true
