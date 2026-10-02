# Zarlino Executive OS - Instance Provisioner (canonical kit)
#
# Turns any Windows machine into a full Zarlino runtime instance:
#   1. verifies git + node (installs via winget when missing)
#   2. clones/updates the Executive OS repo
#   3. writes .dev.vars (you type the secrets on THIS machine; never printed)
#   4. installs npm dependencies (FULL install - the daemon runs through tsx)
#   5. optionally clones the Zarlino plugins repo (build/render tools)
#   6. installs the WhatsApp bridge (founder channel): restart-loop launcher +
#      auto-start. With -BridgeSessionZip the linked session moves from another
#      machine WITHOUT scanning a QR again.
#   7. installs the daemon launcher (restart-loop + auto-start at login)
#   8. registers this machine as its own instance id in the org registry
#   9. starts everything and VERIFIES the heartbeats end-to-end
#
# This is the script the downloadable ZarlinoInstanceSetup.exe runs (published
# at https://zarlinoaudio.com/instance/). Any machine + this script becomes a
# replacement host - the OS itself always runs in the cloud.
#
# Usage (on the new machine):
#   .\instance-provision.ps1 [-AgentId remote_daemon_01] [-CloneWorkspace]
#                             [-BridgeSessionZip <zip>] [-NoBridge] [-NoStart]
#                             [-Yes] [-CheckOnly]

param(
  [string]$AgentId = "remote_daemon_01",
  [switch]$CloneWorkspace,
  [switch]$NoStart,
  [switch]$CheckOnly,
  [switch]$Yes,
  [switch]$NoBridge,
  [string]$BridgeSessionZip = ""
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/zarlino-audio/zarlino-executive-os.git"
$InstallRoot = "C:\Zarlino"
$OsDir = Join-Path $InstallRoot "zarlino-executive-os"
$BridgeDir = Join-Path $OsDir "tools\whatsapp-bridge"
$ExecUrl = if ($env:EXEC_OS_URL) { $env:EXEC_OS_URL } else { "https://os.zarlinoaudio.com" }

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ask-Yes([string]$q, [bool]$defaultYes = $true) {
  if ($Yes) { return $true }
  $suffix = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
  $a = Read-Host "$q $suffix"
  if (-not $a) { return $defaultYes }
  return ($a -match '^(y|yes)$')
}

# -- 1. prerequisites ---------------------------------------------------------
Step "1/9 Checking git + node"
$git = Get-Command git -ErrorAction SilentlyContinue
$node = Get-Command node -ErrorAction SilentlyContinue
$winget = Get-Command winget -ErrorAction SilentlyContinue

if ($CheckOnly) {
  Step "Check-only: reporting the environment, changing nothing"
  $gitSrc = "MISSING"; if ($git) { $gitSrc = $git.Source }
  $nodeSrc = "MISSING"; if ($node) { $nodeSrc = $node.Source }
  $wingetSrc = "MISSING"; if ($winget) { $wingetSrc = $winget.Source }
  Write-Host "git:    $gitSrc"
  Write-Host "node:   $nodeSrc"
  Write-Host "winget: $wingetSrc"
  Write-Host ""
  Write-Host "Planned actions (without -CheckOnly):"
  if ($winget) { Write-Host "  - install git/node via winget where missing" } else { Write-Host "  - git/node must be installed MANUALLY (no winget on this machine)" }
  Write-Host "  - clone $RepoUrl into $OsDir"
  Write-Host "  - write secrets to $OsDir\.dev.vars (you type them; never printed)"
  Write-Host "  - npm ci (full install; tsx is required for the daemon)"
  if ($NoBridge) {
    Write-Host "  - WhatsApp bridge: SKIPPED (-NoBridge)"
  } else {
    $sessionPlan = if ($BridgeSessionZip) { "import session from $BridgeSessionZip (no QR needed)" } else { "no session zip - first start shows a QR page on http://localhost:3037/" }
    Write-Host "  - WhatsApp bridge: install + auto-start + restart-loop; $sessionPlan"
  }
  Write-Host "  - daemon auto-start (restart-loop) as instance '$AgentId'"
  Write-Host "  - register at $ExecUrl and verify heartbeats"
  exit 0
}

if (-not $git -or -not $node) {
  if (-not $winget) {
    Write-Error "git and/or node missing and winget unavailable. Install Git + Node.js LTS manually, then re-run."
    exit 1
  }
  Write-Host "Installing missing prerequisites via winget..."
  if (-not $git)  { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements | Out-Null }
  if (-not $node) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Null }
  Write-Host "Prerequisites installed. RE-OPEN this PowerShell window, then run this script again."
  exit 0
}
Write-Host "git: $($git.Source) | node: $($node.Source)"

# -- 2. clone the OS ----------------------------------------------------------
Step "2/9 Cloning/updating the Executive OS repo (git may prompt for credentials)"
if (Test-Path $OsDir) {
  Write-Host "Already present: $OsDir (updating)"
  Push-Location $OsDir
  git pull --ff-only
  Pop-Location
} else {
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  git clone $RepoUrl $OsDir
}

# -- 3. .dev.vars (secrets typed here, on this machine) -----------------------
Step "3/9 OS secrets (.dev.vars)"
$devVars = Join-Path $OsDir ".dev.vars"
$deepseek = ""
$founder = ""
if (Test-Path $devVars) {
  $existing = Get-Content $devVars
  $dLine = $existing | Where-Object { $_ -like "DEEPSEEK_API_KEY=*" } | Select-Object -First 1
  $fLine = $existing | Where-Object { $_ -like "FOUNDER_AUTH_TOKEN=*" } | Select-Object -First 1
  if ($dLine) { $deepseek = ($dLine -replace "^DEEPSEEK_API_KEY=", "").Trim() }
  if ($fLine) { $founder = ($fLine -replace "^FOUNDER_AUTH_TOKEN=", "").Trim() }
  Write-Host ".dev.vars already present - reusing stored values."
}
if (-not $deepseek -and $env:ZARLINO_DEEPSEEK_KEY) { $deepseek = $env:ZARLINO_DEEPSEEK_KEY }
if (-not $founder -and $env:ZARLINO_FOUNDER_TOKEN) { $founder = $env:ZARLINO_FOUNDER_TOKEN }
if (-not $deepseek) {
  if ($Yes) { Write-Error "DEEPSEEK_API_KEY required (set ZARLINO_DEEPSEEK_KEY or add it to .dev.vars)."; exit 1 }
  $deepseek = Read-Host "Paste DEEPSEEK_API_KEY"
}
if (-not $founder) {
  if ($Yes) { Write-Error "FOUNDER_AUTH_TOKEN required (set ZARLINO_FOUNDER_TOKEN or add it to .dev.vars)."; exit 1 }
  $founder = Read-Host "Paste FOUNDER_AUTH_TOKEN"
}
if (-not $deepseek -or -not $founder) { Write-Error "Both secrets are required."; exit 1 }
# Keep any other keys already in the file; only replace the two we manage.
$lines = @()
if (Test-Path $devVars) {
  $lines = @(Get-Content $devVars | Where-Object { $_ -notlike "DEEPSEEK_API_KEY=*" -and $_ -notlike "FOUNDER_AUTH_TOKEN=*" })
}
$lines += "DEEPSEEK_API_KEY=$deepseek"
$lines += "FOUNDER_AUTH_TOKEN=$founder"
Set-Content -Path $devVars -Value $lines -Encoding ASCII

# -- 4. dependencies ----------------------------------------------------------
Step "4/9 Installing npm dependencies (full - the daemon runs through tsx)"
Push-Location $OsDir
npm ci
if ($LASTEXITCODE -ne 0) { npm install }
npx --no-install tsx --version *> "$null"
if ($LASTEXITCODE -ne 0) {
  Write-Error "tsx missing after install - the daemon (npm run agent:daemon:loop) would fail. Fix the install and re-run."
  Pop-Location
  exit 1
}
Pop-Location

# -- 5. optional plugin workspace ---------------------------------------------
Step "5/9 Plugin workspace for local build/render tools"
$workspace = ""
$wantWs = $CloneWorkspace.IsPresent
if (-not $wantWs -and -not $Yes) { $wantWs = Ask-Yes "Clone the Zarlino plugins repo so build/render tools work on this machine?" $false }
if ($wantWs) {
  $wsDir = Join-Path $InstallRoot "Zarlino"
  if (-not (Test-Path $wsDir)) {
    Write-Host "Cloning the Zarlino plugins repo (git may prompt for credentials)..."
    git clone "https://github.com/zarlino-audio/Zarlino.git" $wsDir
  }
  $workspace = $wsDir
}

# -- 6. WhatsApp bridge (founder channel) -------------------------------------
$installBridge = -not $NoBridge.IsPresent
if ($installBridge -and -not $Yes) {
  $installBridge = Ask-Yes "Install the WhatsApp bridge on this machine too (host the founder channel)?" $true
}
if ($installBridge) {
  Step "6/9 WhatsApp bridge (founder channel)"
  Push-Location $BridgeDir
  npm ci
  if ($LASTEXITCODE -ne 0) { npm install }
  Pop-Location

  if ($BridgeSessionZip) {
    if (-not (Test-Path $BridgeSessionZip)) {
      Write-Warning "Session zip not found: $BridgeSessionZip - the bridge will show a QR instead."
    } else {
      $tmp = Join-Path $env:TEMP "zarlino-wa-session"
      if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
      Expand-Archive -Path $BridgeSessionZip -DestinationPath $tmp -Force
      $src = $tmp
      if (Test-Path (Join-Path $tmp "auth")) { $src = Join-Path $tmp "auth" }
      $authDir = Join-Path $BridgeDir "auth"
      New-Item -ItemType Directory -Path $authDir -Force | Out-Null
      Copy-Item -Path (Join-Path $src "*") -Destination $authDir -Recurse -Force
      if (Test-Path (Join-Path $authDir "creds.json")) {
        Write-Host "Linked-device session imported - NO QR scan needed on this machine."
      } else {
        Write-Warning "Session zip did not contain creds.json - the bridge will show a QR instead."
      }
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "No session zip given - the first start shows a QR at http://localhost:3037/ to link the business WhatsApp."
  }

  # restart-loop launcher: survives crashes (30s between restarts)
  $bridgeLines = @("@echo off", "cd /d `"%~dp0`"", ":loop", "node index.mjs >> bridge.log 2>&1", "timeout /t 30 /nobreak >nul", "goto loop")
  Set-Content -Path (Join-Path $BridgeDir "run-bridge-loop.cmd") -Value ($bridgeLines -join "`r`n") -Encoding ASCII
  $bridgeVbs = @"
' Zarlino WhatsApp Bridge - hidden restart-loop launcher.
Option Explicit
Dim fso, dir, sh
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & dir & "\run-bridge-loop.cmd""", 0, False
"@
  Set-Content -Path (Join-Path $BridgeDir "start-bridge-loop.vbs") -Value $bridgeVbs -Encoding ASCII

  $startup = [Environment]::GetFolderPath("Startup")
  $lnkPath = Join-Path $startup "Zarlino WhatsApp Bridge.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = "`"$BridgeDir\start-bridge-loop.vbs`""
  $lnk.WorkingDirectory = $BridgeDir
  $lnk.Description = "Zarlino Executive OS - WhatsApp bridge (founder channel) auto-start"
  $lnk.Save()
  Write-Host "Bridge auto-start installed: $lnkPath"
} else {
  Step "6/9 WhatsApp bridge: SKIPPED"
}

# -- 7. daemon launcher (restart-loop + auto-start) ---------------------------
Step "7/9 Daemon launcher (restart-loop + auto-start)"
$daemonLines = @("@echo off", "set AGENT_ID=$AgentId")
if ($workspace) { $daemonLines += "set ZARLINO_WORKSPACE=$workspace" }
$daemonLines += @("", "cd /d `"%~dp0..`"", ":loop", "call npm run agent:daemon:loop >> local-daemon.log 2>&1", "timeout /t 20 /nobreak >nul", "goto loop")
Set-Content -Path (Join-Path $OsDir "scripts\remote-daemon.cmd") -Value ($daemonLines -join "`r`n") -Encoding ASCII
$daemonVbs = @"
' Zarlino Executive OS - remote daemon hidden restart-loop launcher (instance: $AgentId).
Option Explicit
Dim fso, dir, sh
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & dir & "\remote-daemon.cmd""", 0, False
"@
Set-Content -Path (Join-Path $OsDir "scripts\remote-daemon.vbs") -Value $daemonVbs -Encoding ASCII

$startup = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startup "Zarlino Remote Daemon.lnk"
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$OsDir\scripts\remote-daemon.vbs`""
$lnk.WorkingDirectory = $OsDir
$lnk.Description = "Zarlino Executive OS - remote daemon ($AgentId) auto-start at login"
$lnk.Save()
Write-Host "Startup entry installed: $lnkPath"

# -- 8. register the instance in the org registry -----------------------------
Step "8/9 Registering this machine as '$AgentId' in the org registry"
$headers = @{ Authorization = "Bearer $founder"; "Content-Type" = "application/json" }
$body = @{ id = $AgentId; role_id = "role_software_engineering"; kind = "local"; model = "deepseek-v4"; source = "runtime" } | ConvertTo-Json
try {
  $reg = Invoke-RestMethod -Uri "$ExecUrl/api/org/agents" -Method Post -Headers $headers -Body $body
  Write-Host "Registered: $($reg.agent.id) ($($reg.agent.status))"
} catch {
  Write-Host "WARNING: registration failed ($($_.Exception.Message)) - the daemon heartbeat will register it anyway."
}

# -- 9. start + verify --------------------------------------------------------
Step "9/9 Starting and verifying"
if (-not $NoStart) {
  wscript.exe (Join-Path $OsDir "scripts\remote-daemon.vbs")
  if ($installBridge) { wscript.exe (Join-Path $BridgeDir "start-bridge-loop.vbs") }
}

Write-Host "Waiting up to 120s for the daemon heartbeat..."
$ok = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Seconds 5
  try {
    $resp = Invoke-RestMethod -Uri "$ExecUrl/api/org/agents" -Headers @{ Authorization = "Bearer $founder" } -TimeoutSec 20
    $list = if ($resp.agents) { @($resp.agents) } else { @($resp) }
    $me = $list | Where-Object { $_.id -eq $AgentId } | Select-Object -First 1
    if ($me -and $me.last_seen) {
      $seen = [datetime]::Parse($me.last_seen).ToUniversalTime()
      if (((Get-Date).ToUniversalTime() - $seen).TotalMinutes -lt 3) { $ok = $true; break }
    }
  } catch { }
}
if ($ok) {
  Write-Host "Daemon heartbeat VERIFIED for '$AgentId'." -ForegroundColor Green
} else {
  Write-Warning "No fresh heartbeat yet - check local-daemon.log on this machine (the daemon may still be starting)."
}

if ($installBridge) {
  try {
    $b = Invoke-RestMethod -Uri "$ExecUrl/api/whatsapp/bridge" -Headers @{ Authorization = "Bearer $founder" } -TimeoutSec 20
    if ($b.bridge -and $b.bridge.fresh) {
      Write-Host "WhatsApp bridge heartbeat VERIFIED ($($b.bridge.host) as $($b.bridge.linkedAs))." -ForegroundColor Green
    } else {
      Write-Host "Bridge not linked yet - on THIS machine open http://localhost:3037/ to scan the QR (skip if a session zip was imported)." -ForegroundColor Yellow
    }
  } catch { }
}

Write-Host "`n==> DONE - this machine is now a Zarlino instance ($AgentId)."
Write-Host "    Console: $ExecUrl"
Write-Host "    When this instance is verified, the old host can be retired:"
Write-Host "    run scripts\retire-this-machine.ps1 on the machine being replaced."
