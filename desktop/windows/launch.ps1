# Scriptorium launcher - boots services and opens the dashboard.
# Called by the desktop shortcut; also fine to run directly.
# No Docker: storage is a local SQLite file (data/scriptorium.db).
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Repo

if (-not (Test-Path ".env")) {
  Write-Warning ".env missing - copying .env.example. Add your ANTHROPIC_API_KEY."
  Copy-Item ".env.example" ".env"
}

if (-not (Test-Path "data\scriptorium.db")) {
  Write-Host "Scriptorium: first run - creating data/scriptorium.db..." -ForegroundColor Cyan
  pnpm --filter @scriptorium/api db:push
}

Write-Host "Scriptorium: starting API + dashboard (pnpm dev)..." -ForegroundColor Cyan
# Start-Process on the bare "pnpm" name (a .cmd shim on Windows, not a real
# .exe) silently dies within ~1s under -WindowStyle Minimized instead of
# running dev - same class of issue as the documented `claude` CLI shim
# gotcha. Routing through cmd.exe /c (a real executable) avoids it.
$dev = Start-Process cmd.exe -ArgumentList "/c","pnpm","dev" -WorkingDirectory $Repo -PassThru -WindowStyle Minimized

# Wait for the dashboard to answer, then open the browser. First boot (cold
# tsx/vite start) can take longer than a warm one, hence the generous budget.
$deadline = (Get-Date).AddSeconds(120)
do {
  Start-Sleep -Seconds 2
  try { $ok = (Invoke-WebRequest "http://localhost:5173" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
  catch { $ok = $false }
} until ($ok -or (Get-Date) -gt $deadline)

if (-not $ok) {
  Write-Warning "Dashboard didn't respond within 120s - it may still be starting. Check the minimized pnpm window (PID $($dev.Id))."
}

Start-Process "http://localhost:5173"
Write-Host "Scriptorium is up. Close the minimized pnpm window (PID $($dev.Id)) to stop." -ForegroundColor Green
