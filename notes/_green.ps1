$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_green.txt"

$evidence = @{
  kind = "command_output"
  locator = "https://github.com/zarlino-audio/Zarlino/actions/runs/38107516518"
  summary = "GREEN release gate on the fixed workflow (head 960cff86 = the two CI fixes). This run was dispatched by the org's own CI task tsk_mv38t42l (issue #18) after this task's dispatch was cancelled as a duplicate - same commit, so the result is authoritative for the work this task asked for. Every step succeeded: Configure; Build ZTame_All + ZTame_Tests; release-gate tests (ZTame.Unit ran and passed); Package VST3 artifact; Package Standalone artifact; Install NSIS; Build NSIS installer; Upload VST3 zip; Upload Standalone zip; Upload NSIS installer. Signing steps skipped (ZARLINO_SIGNING_ENABLED not set) - the build is UNSIGNED, which is a separate founder decision, not a gate failure. First green ZTame release-gate run in the repository's history (8 prior runs failed: 7 on the ctest selection defect, 1 on the artefact target defect)."
  verification_command = "GET /repos/zarlino-audio/Zarlino/actions/runs/38107516518 (+ /jobs)"
  verification_output = "status=completed conclusion=success; steps: Build ZTame (VST3 + Standalone) and test runner => success; Run automated release-gate tests => success; Package VST3 artifact => success; Package Standalone artifact => success; Build NSIS installer => success; Upload VST3 zip => success; Upload Standalone zip => success; Upload NSIS installer => success."
  verified = $true
}
$ev = Invoke-RestMethod -Method Post -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv38w0et_souh6se07kua/evidence" -Headers $H -ContentType "application/json" -Body ($evidence | ConvertTo-Json -Depth 4)
("E3 evidence ok=" + $ev.ok) | Out-File $out -Encoding utf8

$patch = Invoke-RestMethod -Method Patch -Uri "https://os.zarlinoaudio.com/api/tasks/tsk_mv38w0et_souh6se07kua" -Headers $H -ContentType "application/json" -Body '{"status":"DONE"}'
("E3 close => status=" + $patch.status) | Out-File $out -Append -Encoding utf8

foreach ($id in @("tsk_mv38w0et_souh6se07kua", "tsk_mv38w0nc_l3wcjyucnm27", "tsk_mv38t42l_2oe77fgwhy54", "tsk_mv37hgzc_zkjelkm1qeqq")) {
  $t = (Invoke-WebRequest -Uri ("https://os.zarlinoaudio.com/api/tasks/" + $id) -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
  ("{0} | {1} | {2}" -f $t.task.id, $t.task.status, $t.task.title) | Out-File $out -Append -Encoding utf8
}
Get-Content $out
