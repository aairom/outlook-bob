Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RootDir = Split-Path -Parent $ScriptDir
$AppDir = Join-Path $RootDir "electron-outlook"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm is required but was not found in PATH." -ForegroundColor Red
    exit 1
}

Write-Host "Building Outlook Folder Extractor release artifacts..." -ForegroundColor Cyan
Write-Host "App: $AppDir" -ForegroundColor DarkGray

Push-Location $AppDir
npm install
npm run pack:win
Pop-Location

Write-Host "Done. Installer output is in $AppDir\dist" -ForegroundColor Green
