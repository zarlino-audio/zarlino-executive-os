# Zarlino Executive OS - retire THIS machine as a host.
#
# Run this ONLY after the replacement instance is verified:
#   - daemon heartbeat fresh in the org registry
#   - WhatsApp bridge heartbeat fresh (doctor 'whatsapp.bridge' == OK)
#   - one WhatsApp round-trip works (message the business number; it replies)
#
# It stops the local daemon + WhatsApp bridge and removes their startup
# entries. With -Deregister it also removes this machine from the org registry.
# The OS keeps running in the cloud - this machine goes back to being normal.
#
# Usage:
#   .\retire-this-machine.ps1                    # dry run: prints the plan
#   .\retire-this-machine.ps1 -Execute           # stop services + startup entries
#   .\retire-this-machine.ps1 -Execute -Deregister

param(
  [switch]$Execute,
  [switch]$Deregister,
  [string]$AgentId = "local_daemon_01",
  [string]$ExecUrl = ""
)

$ErrorActionPreference = "Continue"
$OsDir = Split-Path -Parent $PSScriptRoot
if (-not $ExecUrl) {
  $ExecUrl = if ($env:EXEC_OS_URL) { $env:EXEC_OS_URL } else { "https://os.zarlinoaudio.com" }
}

$actions = New-Object System.Collections.Generic.List[string]
$actions.Add("Stop the daemon (node process running local-daemon.ts)")
$actions.Add("Stop the WhatsApp bridge (node process running whatsapp-bridge\index.mjs)")
$actions.Add("Remove startup entries: 'Zarlino Executive Daemon.lnk', 'Zarlino WhatsApp Bridge.lnk', 'Zarlino Remote Daemon.lnk'")
if ($Deregister) { $actions.Add("Deregister '$AgentId' from the org registry (DELETE $ExecUrl/api/org/agents/$AgentId)") }

Write-Host "Retirement plan for THIS machine ($env:COMPUTERNAME):"
$i = 1
foreach ($a in $actions) { Write-Host ("  {0}. {1}" -f $i, $a); $i++ }

if (-not $Execute) {
  Write-Host ""
  Write-Host "DRY RUN - nothing changed. Re-run with -Execute (and -Deregister to clean the registry)."
  Write-Host "Verify the replacement instance FIRST: fresh daemon heartbeat + a working WhatsApp round-trip."
  exit 0
}

# 1. stop the daemon
$stopScript = Join-Path $PSScriptRoot "stop-daemon.ps1"
if (Test-Path $stopScript) {
  & $stopScript
} else {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*local-daemon*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped daemon pid $($_.ProcessId)" }
}

# 2. stop the WhatsApp bridge
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*whatsapp-bridge*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped bridge pid $($_.ProcessId)" }

# 3. remove startup entries
$startup = [Environment]::GetFolderPath("Startup")
foreach ($name in @("Zarlino Executive Daemon.lnk", "Zarlino WhatsApp Bridge.lnk", "Zarlino Remote Daemon.lnk")) {
  $p = Join-Path $startup $name
  if (Test-Path $p) {
    Remove-Item $p -Force
    Write-Host "Removed startup entry: $name"
  } else {
    Write-Host "Not present: $name"
  }
}

# 4. deregister this machine from the org registry
if ($Deregister) {
  $devVars = Join-Path $OsDir ".dev.vars"
  $token = ""
  if (Test-Path $devVars) {
    $line = Get-Content $devVars | Where-Object { $_ -like "FOUNDER_AUTH_TOKEN=*" } | Select-Object -First 1
    if ($line) { $token = ($line -replace "^FOUNDER_AUTH_TOKEN=", "").Trim() }
  }
  if (-not $token) {
    Write-Warning "No FOUNDER_AUTH_TOKEN found in $devVars - skipping deregistration."
  } else {
    try {
      Invoke-RestMethod -Uri "$ExecUrl/api/org/agents/$AgentId" -Method Delete -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 30 | Out-Null
      Write-Host "Deregistered instance '$AgentId'."
    } catch {
      Write-Warning "Deregistration failed: $($_.Exception.Message)"
    }
  }
}

Write-Host ""
Write-Host "This machine is retired as a Zarlino host. The OS runs on in the cloud."
