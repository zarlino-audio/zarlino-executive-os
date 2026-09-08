# Removes the Startup-folder entry for the local agent daemon.
# Run from executive-os/:  npm run agent:daemon:uninstall
$ErrorActionPreference = "Stop"

$startup = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startup "Zarlino Executive Daemon.lnk"

if (Test-Path $lnkPath) {
  Remove-Item $lnkPath -Force
  Write-Host "Removed startup entry: $lnkPath"
} else {
  Write-Host "No startup entry found (nothing to remove)."
}
