$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_org4.txt"

function NewT($b) {
  $body = $b | ConvertTo-Json -Depth 4
  try { return Invoke-RestMethod -Method Post -Uri "https://os.zarlinoaudio.com/api/tasks" -Headers $H -ContentType "application/json" -Body $body }
  catch { return @{ ok = $false; err = $_.Exception.Message } }
}

$e3 = NewT @{
  title = "ZTame v1.2.0: dispatch the release gate on the artefact fix and attach the verified result"
  description = "Two CI defects are fixed on main (bcfd6a39 ctest scoping, 960cff86 ZTame_All so VST3/Standalone artefacts are produced; the previous run 38106875866 got as far as packaging and failed because only the code library was built). Dispatch ztame-release-gate.yml (zarlino-audio/Zarlino, ref main) through remote.dispatch_workflow with THIS task id, sync until terminal, and attach the run URL + conclusion as evidence. If it fails again, read the failing step from the run and record the real cause - do not close it as if it passed."
  objective_id = "obj_mv375148_lhrtgi9ho1q9"
  role_id = "role_dsp_engineering"
  priority = "P1"
  acceptance_criteria = "Remote run terminal with its real conclusion attached as evidence on this task; on success, the VST3 + Standalone artefacts are listed."
}
("E3: " + ($e3 | ConvertTo-Json -Depth 3 -Compress)) | Out-File $out -Encoding utf8

$e4 = NewT @{
  title = "ZTame v1.2.0: verify the artefact-fixed gate run independently"
  description = "Once the artefact-fix task is DONE, verify its evidence yourself with remote.sync_runs plus a separate GitHub Actions API read of that run id. Confirm from the run itself: the conclusion, that the release-gate tests step passed, and that the VST3 + Standalone + NSIS artefacts were produced. State the verdict and name anything still missing."
  objective_id = "obj_mv375148_lhrtgi9ho1q9"
  role_id = "role_qa_verification"
  priority = "P1"
  dependency_task_id = $e3.id
  acceptance_criteria = "Verification note attached; run id, conclusion, tests-step result and artefacts listed; verdict explicit."
}
("E4: " + ($e4 | ConvertTo-Json -Depth 3 -Compress)) | Out-File $out -Append -Encoding utf8
Get-Content $out
