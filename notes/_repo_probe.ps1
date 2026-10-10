$ErrorActionPreference = "Stop"
$vars = Get-Content C:\Users\khrit\Desktop\zarlino-executive-os\.dev.vars -Raw
$gh = ([regex]::Match($vars, 'GITHUB_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $gh"; Accept = "application/vnd.github+json" }
$FH = @{ Authorization = "Bearer $tok" }
$out = "c:\Users\khrit\Desktop\zarlino-executive-os\notes\_o_repo.txt"

"--- last commits on main ---" | Out-File $out -Encoding utf8
$commits = (Invoke-WebRequest -Uri "https://api.github.com/repos/zarlino-audio/Zarlino/commits?per_page=6&sha=main" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
($commits | ForEach-Object { "{0} | {1} | {2}" -f $_.sha.Substring(0,8), $_.commit.author.date, ($_.commit.message -split "`n")[0] }) | Out-File $out -Append -Encoding utf8

"--- recent gate runs ---" | Out-File $out -Append -Encoding utf8
$runs = (Invoke-WebRequest -Uri "https://api.github.com/repos/zarlino-audio/Zarlino/actions/workflows/ztame-release-gate.yml/runs?per_page=8" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
($runs.workflow_runs | ForEach-Object { "{0} | {1}/{2} | {3} | {4}" -f $_.id, $_.status, $_.conclusion, $_.created_at, $_.head_sha.Substring(0,8) }) | Out-File $out -Append -Encoding utf8

"--- org tasks mentioning ZTame v1.2.0 ---" | Out-File $out -Append -Encoding utf8
$tasks = ((Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks?limit=60" -Headers $FH -UseBasicParsing).Content | ConvertFrom-Json).tasks
($tasks | Where-Object { $_.title -like "*ZTame v1.2.0*" -or $_.title -like "*release gate*" -or $_.title -like "*release-gate*" } |
  Select-Object -First 20 | ForEach-Object { "{0} | {1} | {2}" -f $_.id, $_.status, $_.title }) | Out-File $out -Append -Encoding utf8
Get-Content $out | Select-Object -First 40
