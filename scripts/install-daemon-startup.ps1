# Registers a Startup-folder shortcut that auto-launches the local agent daemon
# at login (no admin required — the per-user Startup folder is enough).
# Run from executive-os/:  npm run agent:daemon:install
$ErrorActionPreference = "Stop"

$execOs = Split-Path -Parent $PSScriptRoot   # ...\executive-os
$vbs = Join-Path $execOs "scripts\start-daemon.vbs"

if (-not (Test-Path $vbs)) {
  Write-Error "Launcher not found: $vbs"
  exit 1
}

$startup = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startup "Zarlino Executive Daemon.lnk"

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$vbs`""
$lnk.WorkingDirectory = $execOs
$lnk.Description = "Zarlino Executive OS - local agent daemon (auto-start at login)"
$lnk.Save()

Write-Host "Installed startup entry: $lnkPath"
Write-Host "The daemon will start automatically at your next login. Start it now with:"
Write-Host "  npm run agent:daemon:start"
