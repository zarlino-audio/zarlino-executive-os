$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_ceoobjection.txt"

# 1. Does the drafts note exist?
$notesRaw = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/notes" -Headers $H -UseBasicParsing).Content
$notes = ($notesRaw | ConvertFrom-Json).notes
("notes count: " + $notes.Count) | Out-File $out -Encoding utf8
($notes | Where-Object { $_.id -like "nt_mv38*" } | ForEach-Object { "  {0} | {1} | {2} chars" -f $_.id, $_.title, ([string]$_.body).Length }) | Out-File $out -Append -Encoding utf8

# 2. M1 evidence (full)
$m1 = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv38b05g_xyvaqymbze6z/evidence" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
($m1.evidence | ForEach-Object {
  "M1 EV {0} | verified={1} | locator={2}" -f $_.id, $_.verified, $_.locator
  "   summary: " + ($_.summary -replace "`n"," ")
}) | Out-File $out -Append -Encoding utf8

# 3. E4 evidence (full)
$e4 = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv38w0nc_l3wcjyucnm27/evidence" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
($e4.evidence | ForEach-Object {
  "E4 EV {0} | verified={1} | locator={2}" -f $_.id, $_.verified, $_.locator
  "   summary: " + ($_.summary -replace "`n"," ")
  if ($_.verification_output) { "   output: " + (($_.verification_output -replace "`n"," ").Substring(0, [Math]::Min(700, ($_.verification_output -replace "`n"," ").Length))) }
}) | Out-File $out -Append -Encoding utf8

# 4. CEO task evidence (full)
$ct = (Invoke-WebRequest -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv398aku_lbgqv67jno5y/evidence" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
($ct.evidence | ForEach-Object { "CEO EV {0} | verified={1} | locator={2}`n   {3}" -f $_.id, $_.verified, $_.locator, (($_.summary -replace "`n"," ")) }) | Out-File $out -Append -Encoding utf8
Get-Content $out | Select-Object -First 45
