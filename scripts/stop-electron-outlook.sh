#!/usr/bin/env bash
# stop-electron-outlook.sh — Gracefully stop the Outlook Folder Extractor
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$SCRIPT_DIR/electron-outlook"
PID_FILE="$APP_DIR/output/electron-outlook.pid"
PROCESS_PATTERN="electron.*electron-outlook"

echo "🛑  Stopping Outlook Folder Extractor…"

# ── Try PID file first ─────────────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "    Stopping PID: $PID"
        kill "$PID" 2>/dev/null || true
        sleep 1
        if kill -0 "$PID" 2>/dev/null; then
            echo "⚠️   Still running — forcing (SIGKILL)…"
            kill -9 "$PID" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
fi

# ── Also kill any stray Electron processes for this app ───────────────────────
PIDS=$(pgrep -f "$PROCESS_PATTERN" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    for STRAY in $PIDS; do
        echo "    Stopping stray PID: $STRAY"
        kill "$STRAY" 2>/dev/null || true
    done
fi

echo "✅  Outlook Folder Extractor stopped."
