# Watch the ZTame objective tasks + the remote release-gate run until they are
# terminal (or 30 minutes elapse). Each poll also wakes the Executive OS, which
# runs its sweep and syncs in-flight remote runs.
$ErrorActionPreference = "SilentlyContinue"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os

$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$log = "notes\_o_monitor.txt"

$tasks = @{
  E1 = "tsk_mv38azss_tiaglo1cnkvb"   # engineering: dispatch + record green evidence
  E2 = "tsk_mv38azz0_bj4rm9xm7pyz"   # QA verification (depends on E1)
  M1 = "tsk_mv38b05g_xyvaqymbze6z"   # marketing drafts
}

"MONITOR START $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Encoding utf8
$deadline = (Get-Date).AddMinutes(30)
$final = ""

do {
  $line = "$(Get-Date -Format 'HH:mm:ss') "
  $statuses = @{}
  foreach ($k in $tasks.Keys) {
    $d = (Invoke-WebRequest -Uri ("https://os.zarlinoaudio.com/api/tasks/" + $tasks[$k]) -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
    $statuses[$k] = $d.task.status
    $line += "$k=$($d.task.status) "
  }
  $rem = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/remote/runs" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).runs |
    Where-Object { $_.task_id -eq $tasks.E1 } | Select-Object -First 1
  if ($rem) { $line += "| gate=$($rem.status)/$($rem.conclusion) $($rem.run_url)" }
  $line | Out-File $log -Append -Encoding utf8

  $allDone = $true
  foreach ($k in $tasks.Keys) { if ($statuses[$k] -ne "DONE") { $allDone = $false } }
  if ($allDone) { $final = "ALL TASKS DONE"; break }
  if ($statuses.E1 -in @("CANCELLED") -and $statuses.E2 -eq "DONE" -and $statuses.M1 -eq "DONE") { $final = "E1 CANCELLED - negative result"; break }
  if ((Get-Date) -ge $deadline) { $final = "DEADLINE REACHED"; break }
  Start-Sleep -Seconds 60
} while ($true)

"MONITOR END $(Get-Date -Format 'HH:mm:ss') | $final" | Out-File $log -Append -Encoding utf8
Get-Content $log | Select-Object -Last 6
