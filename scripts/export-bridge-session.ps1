# Zarlino Executive OS - export the live WhatsApp linked-device session.
#
# Packages tools\whatsapp-bridge\auth (the linked business WhatsApp session)
# into a zip so ANOTHER machine can become the bridge host WITHOUT scanning a
# QR again:
#
#   (new machine)  instance-provision.ps1 -BridgeSessionZip <zip>
#
# The zip contains live account credentials - treat it like a password:
# transfer it privately (RDP drag-and-drop, encrypted USB), import it, then
# DELETE the zip and don't leave copies in cloud storage.
param(
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$auth = Join-Path $PSScriptRoot "..\tools\whatsapp-bridge\auth"

if (-not (Test-Path (Join-Path $auth "creds.json"))) {
  Write-Error "No linked session found at $auth - link the bridge on this machine first (tools\whatsapp-bridge)."
  exit 1
}

if (-not $OutFile) {
  $OutFile = Join-Path ([Environment]::GetFolderPath("Desktop")) ("zarlino-whatsapp-session-" + (Get-Date -Format "yyyyMMdd-HHmm") + ".zip")
}

$staging = Join-Path $env:TEMP "zarlino-wa-export"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -Path $auth -Destination (Join-Path $staging "auth") -Recurse -Force
Compress-Archive -Path (Join-Path $staging "auth") -DestinationPath $OutFile -Force
Remove-Item $staging -Recurse -Force

Write-Host "Session exported: $OutFile"
Write-Host ""
Write-Host "IMPORTANT: this zip can access the business WhatsApp like a logged-in device."
Write-Host "Next steps:"
Write-Host "  1. Transfer it privately to the new machine (RDP drag-and-drop or encrypted USB)."
Write-Host "  2. On the new machine:  .\instance-provision.ps1 -BridgeSessionZip `"$OutFile`""
Write-Host "  3. Verify the bridge heartbeat appears (doctor check 'whatsapp.bridge')."
Write-Host "  4. DELETE the zip from both machines."
