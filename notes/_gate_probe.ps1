$ErrorActionPreference = "Stop"
$vars = Get-Content C:\Users\khrit\Desktop\zarlino-executive-os\.dev.vars -Raw
$gh = ([regex]::Match($vars, 'GITHUB_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $gh"; Accept = "application/vnd.github+json" }
$out = "c:\Users\khrit\Desktop\zarlino-executive-os\notes\_o_gate2.txt"

$runs = @()
foreach ($id in @(38106646588, 38106875866)) {
  $r = (Invoke-WebRequest -Uri "https://api.github.com/repos/zarlino-audio/Zarlino/actions/runs/$id" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
  "RUN $id | $($r.name) | $($r.status)/$($r.conclusion) | head=$($r.head_sha) | created=$($r.created_at) | ref=$($r.head_branch)" | Out-File $out -Append -Encoding utf8
  $runs += $id
}

foreach ($id in $runs) {
  $jobs = (Invoke-WebRequest -Uri "https://api.github.com/repos/zarlino-audio/Zarlino/actions/runs/$id/jobs" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
  foreach ($j in $jobs.jobs) {
    "  JOB $($j.id) $($j.name) => $($j.status)/$($j.conclusion)" | Out-File $out -Append -Encoding utf8
    foreach ($s in $j.steps) { "    step: $($s.name) => $($s.conclusion)" | Out-File $out -Append -Encoding utf8 }
  }
}

# Pull the ctest step output from the newest failing job, if any.
$jobs = (Invoke-WebRequest -Uri "https://api.github.com/repos/zarlino-audio/Zarlino/actions/runs/38106875866/jobs" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
$jobId = $jobs.jobs[0].id
try {
  $logs = (Invoke-WebRequest -Uri "https://api.github.com/repos/zarlino-audio/Zarlino/actions/jobs/$jobId/logs" -Headers $H -UseBasicParsing -MaximumRedirection 5).Content
  $lines = $logs -split "`n"
  "  --- log tail (job $jobId) ---" | Out-File $out -Append -Encoding utf8
  ($lines | Select-Object -Last 40 | ForEach-Object { ($_ -replace '^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?', '').TrimEnd() } | Where-Object { $_ -ne '' }) | Out-File $out -Append -Encoding utf8
} catch {
  "  LOG ERROR: $($_.Exception.Message)" | Out-File $out -Append -Encoding utf8
}
"done" | Out-File $out -Append -Encoding utf8
Get-Content $out
