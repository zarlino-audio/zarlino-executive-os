$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_ceoverdict.txt"

$t = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv398aku_lbgqv67jno5y" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
("CEO task status: " + $t.task.status) | Out-File $out -Encoding utf8
($t.evidence | ForEach-Object { "EV ({0}) {1}: {2}" -f $_.kind, $_.verified, (($_.summary -replace "`n"," ").Substring(0, [Math]::Min(900, ($_.summary -replace "`n"," ").Length))) }) | Out-File $out -Append -Encoding utf8

$runs = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/agents/runs?limit=12" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).runs |
  Where-Object { $_.task_id -eq "tsk_mv398aku_lbgqv67jno5y" } | Select-Object -First 2
foreach ($r in $runs) {
  ("RUN {0} | {1} | it={2} tools={3}" -f $r.id, $r.status, $r.iterations, $r.tools_called) | Out-File $out -Append -Encoding utf8
  if ($r.result) { ("RESULT: " + ($r.result -replace "`n"," ").Substring(0, [Math]::Min(1500, ($r.result -replace "`n"," ").Length))) | Out-File $out -Append -Encoding utf8 }
  if ($r.error) { ("ERROR: " + $r.error) | Out-File $out -Append -Encoding utf8 }
}
Get-Content $out | Select-Object -First 40
