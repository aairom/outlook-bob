# stop-electron-outlook.ps1 — Gracefully stop the Outlook Folder Extractor
# Run from any directory:  powershell -ExecutionPolicy Bypass -File scripts\stop-electron-outlook.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Find Electron processes spawned for this app ───────────────────────────────
# Match processes where the command line contains the electron-outlook app path.
# WMI is used so we can inspect the full command-line string, not just the exe name.
$processes = Get-CimInstance Win32_Process `
    -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -match "electron-outlook" }

if (-not $processes) {
    Write-Host "ℹ️   No Outlook Folder Extractor process is currently running." -ForegroundColor Yellow
    exit 0
}

Write-Host "🛑  Stopping Outlook Folder Extractor…" -ForegroundColor Cyan

foreach ($proc in $processes) {
    try {
        Write-Host "    Stopping PID: $($proc.ProcessId)" -ForegroundColor DarkGray
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Host "    ⚠️  Could not stop PID $($proc.ProcessId): $_" -ForegroundColor Yellow
    }
}

# ── Verify all stopped ─────────────────────────────────────────────────────────
Start-Sleep -Seconds 1

$remaining = Get-CimInstance Win32_Process `
    -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -match "electron-outlook" }

if (-not $remaining) {
    Write-Host "✅  Process stopped." -ForegroundColor Green
} else {
    Write-Host "⚠️  Some processes did not stop — forcing termination…" -ForegroundColor Yellow
    foreach ($proc in $remaining) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✅  Process force-stopped." -ForegroundColor Green
}
