# Zarlino Executive OS — Remote Dev Machine Provisioner
#
# Turns a fresh Windows machine (the RDP box: Zarlino1.rdp, host 102.37.153.164)
# into a RELIABLE always-on runtime instance for the artificial organization.
#
# WHAT IT DOES
#   1. Verifies git + node (installs via winget when missing and winget exists).
#   2. Clones https://github.com/zarlino-audio/zarlino-executive-os (private).
#   3. Creates .dev.vars — YOU type DEEPSEEK_API_KEY + FOUNDER_AUTH_TOKEN here,
#      on this machine. Secrets are never printed or sent anywhere else.
#   4. npm install.
#   5. Optionally clones the Zarlino plugins repo and points the daemon at it
#      (ZARLINO_WORKSPACE) so build/render local tools work here.
#   6. Registers this machine in the org registry as its OWN instance id
#      (default: remote_daemon_01) — an honest second runtime, not a clone.
#   7. Installs a startup launcher so the daemon survives reboots.
#
# USAGE (run ON the remote machine, from any PowerShell):
#   .\remote-provision.ps1 [-AgentId remote_daemon_01] [-CloneWorkspace] [-StartNow]
#
# NOTE: machine-specific tool paths in scripts/local-agent.ts (VS vcvars,
# FL Studio, Python scripts dir) may need adjustment on this machine — run one
# local task after provisioning and verify tool resolution.

param(
  [string]$AgentId = "remote_daemon_01",
  [switch]$CloneWorkspace,
  [switch]$NoStart,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/zarlino-audio/zarlino-executive-os.git"
$InstallRoot = "C:\Zarlino"
$OsDir = Join-Path $InstallRoot "zarlino-executive-os"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# -- 1. prerequisites ---------------------------------------------------------
Step "1/7 Checking git + node"
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
  Write-Host "  - register this machine as '$AgentId' at https://os.zarlinoaudio.com"
  Write-Host "  - install a startup launcher so the daemon survives reboots"
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
Step "2/7 Cloning the Executive OS repo (git will prompt for credentials)"
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
Step "3/7 OS secrets (.dev.vars)"
$devVars = Join-Path $OsDir ".dev.vars"
$deepseek = ""
$founder = ""
if (Test-Path $devVars) {
  $existing = Get-Content $devVars
  $dLine = $existing | Where-Object { $_ -like "DEEPSEEK_API_KEY=*" }
  $fLine = $existing | Where-Object { $_ -like "FOUNDER_AUTH_TOKEN=*" }
  if ($dLine) { $deepseek = ($dLine -replace "^DEEPSEEK_API_KEY=", "") }
  if ($fLine) { $founder = ($fLine -replace "^FOUNDER_AUTH_TOKEN=", "") }
  Write-Host ".dev.vars already present — reusing stored values."
}
if (-not $deepseek) {
  $deepseek = Read-Host "Paste DEEPSEEK_API_KEY"
}
if (-not $founder) {
  $founder = Read-Host "Paste FOUNDER_AUTH_TOKEN"
}
if (-not $deepseek -or -not $founder) {
  Write-Error "Both secrets are required."
  exit 1
}
Set-Content -Path $devVars -Value @("DEEPSEEK_API_KEY=$deepseek", "FOUNDER_AUTH_TOKEN=$founder") -Encoding ASCII

# -- 4. dependencies ----------------------------------------------------------
Step "4/7 Installing npm dependencies"
Push-Location $OsDir
# FULL install (do NOT use --omit=dev): the daemon runs through tsx, which is a
# devDependency — an omit=dev install leaves `agent:daemon:loop` unable to start.
npm ci
if ($LASTEXITCODE -ne 0) { npm install }
# Sanity: the daemon cannot start without tsx.
npx --no-install tsx --version *> "$null"
if ($LASTEXITCODE -ne 0) {
  Write-Error "tsx missing after install — the daemon (npm run agent:daemon:loop) would fail. Fix the install and re-run."
  Pop-Location
  exit 1
}
Pop-Location

# -- 5. optional plugin workspace ---------------------------------------------
Step "5/7 Plugin workspace for local build/render tools"
$workspace = ""
if ($CloneWorkspace) {
  $wsDir = Join-Path $InstallRoot "Zarlino"
  if (-not (Test-Path $wsDir)) {
    Write-Host "Cloning the Zarlino plugins repo (git will prompt for credentials)..."
    git clone "https://github.com/zarlino-audio/Zarlino.git" $wsDir
  }
  $workspace = $wsDir
} else {
  $answer = Read-Host "Clone the Zarlino plugins repo so build/render tools work? (y/n)"
  if ($answer -match "y") {
    $wsDir = Join-Path $InstallRoot "Zarlino"
    if (-not (Test-Path $wsDir)) {
      git clone "https://github.com/zarlino-audio/Zarlino.git" $wsDir
    }
    $workspace = $wsDir
  }
}

# -- 6. register the instance in the org registry -----------------------------
Step "6/7 Registering this machine as '$AgentId' in the org registry"
$headers = @{ Authorization = "Bearer $founder"; "Content-Type" = "application/json" }
$execUrl = $env:EXEC_OS_URL
if (-not $execUrl) { $execUrl = "https://os.zarlinoaudio.com" }
$body = @{ id = $AgentId; role_id = "role_software_engineering"; kind = "local"; model = "deepseek-v4"; source = "runtime" } | ConvertTo-Json
try {
  $reg = Invoke-RestMethod -Uri "$execUrl/api/org/agents" -Method Post -Headers $headers -Body $body
  Write-Host "Registered: $($reg.agent.id) ($($reg.agent.status))"
} catch {
  Write-Host "WARNING: registration failed ($($_.Exception.Message)) — the daemon heartbeat will register it anyway."
}

# -- 7. startup launcher ------------------------------------------------------
Step "7/7 Installing auto-start launcher"
$vbs = Join-Path $OsDir "scripts\remote-daemon.vbs"
$envPrefix = "set AGENT_ID=$AgentId&&"
if ($workspace) { $envPrefix = $envPrefix + " set ZARLINO_WORKSPACE=$workspace&&" }
$vbsContent = @"
' Zarlino Executive OS - remote daemon launcher (instance: $AgentId).
Option Explicit
Dim fso, execOs, logPath, cmd, sh
Set fso = CreateObject("Scripting.FileSystemObject")
execOs = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logPath = execOs & "\local-daemon.log"
cmd = "cmd /c cd /d """ & execOs & """ && $envPrefix npm run agent:daemon:loop > """ & logPath & """ 2>&1"
Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 0, False
"@
Set-Content -Path $vbs -Value $vbsContent -Encoding ASCII

$startup = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startup "Zarlino Remote Daemon.lnk"
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$vbs`""
$lnk.WorkingDirectory = $OsDir
$lnk.Description = "Zarlino Executive OS - remote daemon ($AgentId) auto-start at login"
$lnk.Save()
Write-Host "Startup entry installed: $lnkPath"

# -- start now ----------------------------------------------------------------
if (-not $NoStart) {
  Write-Host "Starting the daemon now..."
  wscript.exe $vbs
  Start-Sleep -Seconds 5
}

# -- verification -------------------------------------------------------------
Write-Host "`n==> DONE. Verify on the OS console: $execUrl"
Write-Host "    Agent instance '$AgentId' should appear under /api/org/agents with a fresh last_seen."
Write-Host "    Note: doctor 'local_agent.health' describes the PRIMARY daemon only;"
Write-Host "    this instance's liveness is tracked by org_agents + doctor 'org.registry'."
