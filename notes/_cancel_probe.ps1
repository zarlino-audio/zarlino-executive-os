$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_cancel.txt"

$rem = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/remote/runs" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json).runs |
  Where-Object { $_.id -eq "rrun_mv38xs3o" -or $_.run_url -like "*38107573361*" }
($rem | Select-Object id, task_id, status, conclusion, error, created_at, updated_at | Format-List | Out-String) | Out-File $out -Encoding utf8

$bundle = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/data/all" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
$audit = $bundle.audit
"audit entries: " + $audit.Count | Out-File $out -Append -Encoding utf8
($audit | Select-Object -First 45 | ForEach-Object {
  $detail = [string]$_.detail_json
  if ($detail.Length -gt 120) { $detail = $detail.Substring(0, 120) }
  "{0} | {1} | {2} | {3}" -f $_.created_at, $_.actor, $_.action, $detail
}) | Out-File $out -Append -Encoding utf8
Get-Content $out | Select-Object -First 55
