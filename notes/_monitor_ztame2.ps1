# Watch the follow-up tasks (E3 dispatch on the fixed workflow, E4 QA verification)
# until terminal, or 35 minutes. Each poll also wakes the OS so its sweep syncs
# the in-flight GitHub run and attaches evidence.
$ErrorActionPreference = "SilentlyContinue"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os

$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$log = "notes\_o_monitor2.txt"

$tasks = @{
  E3 = "tsk_mv38w0et_souh6se07kua"   # engineering: dispatch on the artefact fix
  E4 = "tsk_mv38w0nc_l3wcjyucnm27"   # QA verification (depends on E3)
}

"MONITOR2 START $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Encoding utf8
$deadline = (Get-Date).AddMinutes(35)
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
    Where-Object { $_.task_id -eq $tasks.E3 -or $_.task_id -eq $tasks.E4 } | Select-Object -First 1
  if ($rem) { $line += "| gate=$($rem.status)/$($rem.conclusion) $($rem.run_url)" }
  $line | Out-File $log -Append -Encoding utf8

  $allDone = $true
  foreach ($k in $tasks.Keys) { if ($statuses[$k] -ne "DONE") { $allDone = $false } }
  if ($allDone) { $final = "ALL TASKS DONE"; break }
  if ((Get-Date) -ge $deadline) { $final = "DEADLINE REACHED"; break }
  Start-Sleep -Seconds 60
} while ($true)

"MONITOR2 END $(Get-Date -Format 'HH:mm:ss') | $final" | Out-File $log -Append -Encoding utf8
Get-Content $log | Select-Object -Last 4
