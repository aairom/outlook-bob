# start-electron-outlook.ps1 — Install requirements and launch the Outlook Folder Extractor
# Run from any directory:  powershell -ExecutionPolicy Bypass -File scripts\start-electron-outlook.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ──────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RootDir   = Split-Path -Parent $ScriptDir
$AppDir    = Join-Path $RootDir "electron-outlook"
$OutputDir = Join-Path $AppDir  "output"
$LogFile   = Join-Path $OutputDir "electron-outlook.log"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# ── Check Node.js ──────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌  Node.js not found. Install v18+ from https://nodejs.org and reopen this terminal." -ForegroundColor Red
    exit 1
}

$nodeVersion = node --version
Write-Host "✅  Node.js $nodeVersion detected." -ForegroundColor Green

# ── Ensure .env exists ─────────────────────────────────────────────────────────
$EnvFile        = Join-Path $RootDir ".env"
$EnvExampleFile = Join-Path $RootDir ".env.example"

if (-not (Test-Path $EnvFile)) {
    if (Test-Path $EnvExampleFile) {
        Copy-Item $EnvExampleFile $EnvFile
        Write-Host "📝  Created .env from .env.example." -ForegroundColor Yellow
        Write-Host "    Edit '$EnvFile' to set CLIENT_ID, EXCLUDED_DOMAIN, LOGIN_HINT, etc." -ForegroundColor Yellow
    } else {
        Write-Host "⚠️   No .env file found and .env.example is missing. Continuing with defaults." -ForegroundColor Yellow
    }
}

# ── Install npm dependencies ───────────────────────────────────────────────────
$NodeModules = Join-Path $AppDir "node_modules"
if (-not (Test-Path $NodeModules)) {
    Write-Host "📦  Installing npm dependencies…" -ForegroundColor Cyan
    Push-Location $AppDir
    npm install
    Pop-Location
    Write-Host "✅  Dependencies installed." -ForegroundColor Green
} else {
    Write-Host "✅  node_modules already present — skipping install." -ForegroundColor Green
}

# ── Build TypeScript ───────────────────────────────────────────────────────────
$MainJs = Join-Path $AppDir "dist\main.js"
if (-not (Test-Path $MainJs)) {
    Write-Host "🔨  Compiling TypeScript…" -ForegroundColor Cyan
    Push-Location $AppDir
    npm run build
    Pop-Location
    Write-Host "✅  Build complete." -ForegroundColor Green
} else {
    Write-Host "✅  dist\main.js already built — skipping compile." -ForegroundColor Green
}

# ── Locate Electron binary ─────────────────────────────────────────────────────
$ElectronBin = Join-Path $AppDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $ElectronBin)) {
    Write-Host "❌  electron.exe not found at: $ElectronBin" -ForegroundColor Red
    Write-Host "    Try running: cd '$AppDir' && npm install" -ForegroundColor Red
    exit 1
}

# ── Launch Electron in detached mode ──────────────────────────────────────────
Write-Host ""
Write-Host "🚀  Launching Outlook Folder Extractor…" -ForegroundColor Cyan

$process = Start-Process `
    -FilePath    $ElectronBin `
    -ArgumentList "`"$AppDir`"" `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError  $LogFile `
    -WindowStyle Hidden `
    -PassThru

Write-Host "✅  Desktop window opened (PID: $($process.Id))." -ForegroundColor Green
Write-Host ""
Write-Host "    Follow logs with:" -ForegroundColor DarkGray
Write-Host "      Get-Content -Wait '$LogFile'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    Stop with:" -ForegroundColor DarkGray
Write-Host "      powershell -ExecutionPolicy Bypass -File scripts\stop-electron-outlook.ps1" -ForegroundColor DarkGray
