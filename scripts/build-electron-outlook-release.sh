#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/electron-outlook"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH."
  exit 1
fi

echo "Building Outlook Folder Extractor release artifacts..."
echo "App: $APP_DIR"

npm install --prefix "$APP_DIR"
npm run pack:mac --prefix "$APP_DIR"

echo "Done. Installer output is in $APP_DIR/dist"
