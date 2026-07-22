# Creates a "Scriptorium" shortcut on the Desktop with the project icon.
# Run once from the repo:  powershell -ExecutionPolicy Bypass -File desktop\windows\Install-DesktopShortcut.ps1
$ErrorActionPreference = "Stop"
$Repo    = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Icon    = Join-Path $Repo "desktop\assets\scriptorium.ico"
$Launch  = Join-Path $Repo "desktop\windows\launch.ps1"
$Desktop = [Environment]::GetFolderPath("Desktop")
$Lnk     = Join-Path $Desktop "Scriptorium.lnk"

if (-not (Test-Path $Icon)) { python (Join-Path $Repo "desktop\make_icon.py") }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($Lnk)
$sc.TargetPath       = "powershell.exe"
$sc.Arguments        = "-NoProfile -ExecutionPolicy Bypass -File `"$Launch`""
$sc.WorkingDirectory = $Repo
$sc.IconLocation     = "$Icon,0"
$sc.Description      = "Scriptorium - research intelligence dashboard"
$sc.Save()
Write-Host "Created $Lnk" -ForegroundColor Green
