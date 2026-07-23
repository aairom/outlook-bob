#!/usr/bin/env bash
# start-electron-outlook.sh — Build and launch the Outlook Folder Extractor
set -euo pipefail

create_desktop_launcher() {
    local desktop_dir="$HOME/Desktop"
    local launcher_path="$desktop_dir/Outlook Folder Extractor.command"
    local launcher_target="$SCRIPT_DIR/scripts/start-electron-outlook.sh"

    if [ ! -d "$desktop_dir" ]; then
        return
    fi
    if [ -f "$launcher_path" ]; then
        return
    fi

    cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
cd "$SCRIPT_DIR"
bash "$launcher_target"
EOF
    chmod +x "$launcher_path"
    echo "🖥️   Created desktop launcher: $launcher_path"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$SCRIPT_DIR/electron-outlook"
LOG_FILE="$APP_DIR/output/electron-outlook.log"
PID_FILE="$APP_DIR/output/electron-outlook.pid"

mkdir -p "$APP_DIR/output"
create_desktop_launcher

# ── Write anchor config so packaged app can find project root ─────────────────
# macOS open -a strips env vars; this file is the reliable alternative.
# We also copy .env and .bob/mcp.json into the anchor dir so the binary works
# even when launched by double-clicking (without running this script).
ANCHOR_DIR="$HOME/.config/outlook-bob"
mkdir -p "$ANCHOR_DIR"
printf '{"projectRoot":"%s"}\n' "$SCRIPT_DIR" > "$ANCHOR_DIR/config.json"
[ -f "$SCRIPT_DIR/.env" ]           && cp "$SCRIPT_DIR/.env"           "$ANCHOR_DIR/.env"
[ -f "$SCRIPT_DIR/.bob/mcp.json" ]  && cp "$SCRIPT_DIR/.bob/mcp.json"  "$ANCHOR_DIR/mcp.json"
echo "📌  Project root anchored → $ANCHOR_DIR/config.json"

# ── Guard: already running? ────────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "⚠️   Outlook Folder Extractor is already running (PID: $OLD_PID)."
        echo "    Stop it first with:  bash scripts/stop-electron-outlook.sh"
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# ── Prerequisites ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "❌  Node.js not found. Install it from https://nodejs.org (v18+)."
    exit 1
fi

# Install dependencies
if [ ! -d "$APP_DIR/node_modules" ]; then
    echo "📦  Installing dependencies (first run)…"
else
    echo "📦  Installing / verifying dependencies…"
fi
npm install --prefix "$APP_DIR"

# Download Electron binary if path.txt is missing
ELECTRON_PATH_FILE="$APP_DIR/node_modules/electron/path.txt"
if [ ! -f "$ELECTRON_PATH_FILE" ]; then
    echo "📥  Downloading Electron binary (first-time setup)…"
    (cd "$APP_DIR" && node node_modules/electron/install.js 2>&1) || true
fi

ELECTRON_DIST="$APP_DIR/node_modules/electron/dist"
ELECTRON_APP="$ELECTRON_DIST/Electron.app"

# Remove macOS quarantine so the unsigned dev binary can run
if [ -d "$ELECTRON_APP" ]; then
    xattr -rd com.apple.quarantine "$ELECTRON_APP" 2>/dev/null || true
fi

# ── Build TypeScript ───────────────────────────────────────────────────────────
echo "🔨  Building TypeScript…"
npm run build --prefix "$APP_DIR"

# ── Launch ─────────────────────────────────────────────────────────────────────
echo ""
echo "🚀  Launching Outlook Folder Extractor…"
echo ""

if [ -d "$ELECTRON_APP" ]; then
    # macOS: use `open -a` to launch the .app bundle properly so macOS initialises
    # the full Chromium/browser process context. Pass the app directory via
    # --args so Electron can find package.json → dist/main.js.
    # OUTLOOK_BOB_ROOT tells main.ts where to find .env and .bob/mcp.json
    # regardless of what cwd macOS assigns to the process.
    OUTLOOK_BOB_ROOT="$SCRIPT_DIR" open -a "$ELECTRON_APP" --args "$APP_DIR" > "$LOG_FILE" 2>&1 &
    LAUNCHER_PID=$!
    echo $LAUNCHER_PID > "$PID_FILE"
    echo "✅  Desktop window launched."
elif [ -f "$ELECTRON_DIST/electron" ]; then
    # Linux / non-macOS
    nohup "$ELECTRON_DIST/electron" "$APP_DIR" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "✅  Electron process started (PID: $(cat "$PID_FILE"))"
    echo "    Follow logs with:"
    echo "      tail -f $LOG_FILE"
else
    echo "❌  Electron binary not found in $ELECTRON_DIST"
    echo "    Run:  cd electron-outlook && node node_modules/electron/install.js"
    exit 1
fi

echo ""
echo "    Stop with:"
echo "      bash scripts/stop-electron-outlook.sh"
