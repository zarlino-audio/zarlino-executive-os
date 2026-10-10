$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_link.txt"

$tool = Invoke-RestMethod -Method Post -Uri "https://os.zarlinoaudio.com/api/tools/run" -Headers $H -ContentType "application/json" -Body '{"name":"executive.list_objectives","input":{}}'
$mine = $tool.output.objectives | Where-Object { $_.id -eq "obj_mv375148_lhrtgi9ho1q9" }
("TOOL: status={0} tasks={1} open_tasks={2} verified_at={3}" -f $mine.status, $mine.tasks, $mine.open_tasks, $mine.verified_at) | Out-File $out -Encoding utf8

$obj = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/objectives" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).objectives |
  Where-Object { $_.id -eq "obj_mv375148_lhrtgi9ho1q9" }
"--- linked tasks per /api/objectives ---" | Out-File $out -Append -Encoding utf8
($obj.tasks | ForEach-Object { "  {0} | {1}" -f $_.id, $_.status }) | Out-File $out -Append -Encoding utf8
Get-Content $out
