$ErrorActionPreference = "SilentlyContinue"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$log = "notes\_o_monitor3.txt"
$taskId = "tsk_mv398aku_lbgqv67jno5y"
$objId = "obj_mv375148_lhrtgi9ho1q9"

"MONITOR3 START $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Encoding utf8
$deadline = (Get-Date).AddMinutes(15)
$final = ""
do {
  $t = (Invoke-WebRequest -Uri ("https://os.zarlinoaudio.com/api/tasks/" + $taskId) -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
  $o = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/objectives" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).objectives |
    Where-Object { $_.id -eq $objId }
  "$(Get-Date -Format 'HH:mm:ss') ceo_task=$($t.task.status) objective=$($o.status) verified_at=$($o.verified_at)" | Out-File $log -Append -Encoding utf8
  if ($o.status -eq "ACHIEVED") { $final = "OBJECTIVE ACHIEVED"; break }
  if ($t.task.status -eq "DONE") { $final = "CEO TASK DONE (objective still $($o.status))"; break }
  if ((Get-Date) -ge $deadline) { $final = "DEADLINE"; break }
  Start-Sleep -Seconds 45
} while ($true)
"MONITOR3 END $(Get-Date -Format 'HH:mm:ss') | $final" | Out-File $log -Append -Encoding utf8
Get-Content $log | Select-Object -Last 5
