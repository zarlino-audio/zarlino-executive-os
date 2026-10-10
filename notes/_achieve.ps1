$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_achieve.txt"

$e4 = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv38w0nc_l3wcjyucnm27" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
("E4 status=" + $e4.task.status) | Out-File $out -Encoding utf8
($e4.evidence | ForEach-Object { "  E4 ev($($_.verified)): " + (($_.summary -replace "`n"," ").Substring(0, [Math]::Min(300, ($_.summary -replace "`n"," ").Length))) }) | Out-File $out -Append -Encoding utf8

"--- linked tasks ---" | Out-File $out -Append -Encoding utf8
$tasks = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks?objective_id=obj_mv375148_lhrtgi9ho1q9" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).tasks
($tasks | ForEach-Object { "{0} | {1} | {2}" -f $_.id, $_.status, $_.title }) | Out-File $out -Append -Encoding utf8
$openLinked = @($tasks | Where-Object { $_.status -ne "DONE" -and $_.status -ne "CANCELLED" }).Count
("open linked: " + $openLinked) | Out-File $out -Append -Encoding utf8

"--- CEO cycle ---" | Out-File $out -Append -Encoding utf8
try {
  $cy = Invoke-RestMethod -Method Post -Uri "https://os.zarlinoaudio.com/api/ceo/run" -Headers $H -ContentType "application/json" -Body '{}'
  ($cy | ConvertTo-Json -Depth 4 -Compress) | Out-File $out -Append -Encoding utf8
} catch { ("ceo/run error: " + $_.Exception.Message) | Out-File $out -Append -Encoding utf8 }

Start-Sleep -Seconds 20
$obj = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/objectives" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).objectives |
  Where-Object { $_.id -eq "obj_mv375148_lhrtgi9ho1q9" }
("OBJECTIVE status={0} verified_at={1} updated_at={2}" -f $obj.status, $obj.verified_at, $obj.updated_at) | Out-File $out -Append -Encoding utf8
if ($obj.evidence_json) { ("evidence: " + $obj.evidence_json.Substring(0, [Math]::Min(700, $obj.evidence_json.Length))) | Out-File $out -Append -Encoding utf8 }
Get-Content $out
