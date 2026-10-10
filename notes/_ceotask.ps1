$ErrorActionPreference = "Stop"
Set-Location C:\Users\khrit\Desktop\zarlino-executive-os
$vars = Get-Content .dev.vars -Raw
$tok = ([regex]::Match($vars, 'FOUNDER_AUTH_TOKEN\s*=\s*(\S+)')).Groups[1].Value
$H = @{ Authorization = "Bearer $tok" }
$out = "notes\_o_ceotask.txt"

$body = @{
  title = "CEO (seat): verify the ZTame v1.2.0 objective against its evidence and close it"
  description = "The ZTame v1.2.0 release-readiness objective (obj_mv375148_lhrtgi9ho1q9) has all 9 linked tasks closed. Verify each of its 4 recorded criteria against the evidence on the board - do not trust this summary, read the evidence: (1) green remote release-gate run + verified evidence: task tsk_mv38w0et_souh6se07kua, evidence locator https://github.com/zarlino-audio/Zarlino/actions/runs/38107516518 (completed/success, head 960cff86); (2) QA verification: tsk_mv3751or_l06ndigomb56 and tsk_mv38w0nc_l3wcjyucnm27 (independent re-query); (3) launch drafts: tsk_mv38b05g_xyvaqymbze6z (draft-only note); (4) decision packet: tsk_mv3752f0_jm8zuob59f7n. If and only if all four hold, call executive.update_objective with id=obj_mv375148_lhrtgi9ho1q9, status=ACHIEVED, and evidence text that names each criterion with the task/evidence it rests on and records the two CI defects fixed (ctest scoping bcfd6a39, ZTame_All artefact target 960cff86). If any criterion is NOT satisfied, leave it ACTIVE and state exactly which one is missing and what would satisfy it. Then attach your verdict as evidence on this task and close it."
  role_id = "role_ceo"
  priority = "P1"
  acceptance_criteria = "Objective status is ACHIEVED with a verification record naming all four criteria and their evidence, or an explicit statement of the unmet criterion; verdict attached as evidence on this task."
}
$r = Invoke-RestMethod -Method Post -Uri "https://os.zarlinoaudio.com/api/tasks" -Headers $H -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 4)
("CEO TASK: " + ($r | ConvertTo-Json -Depth 3 -Compress)) | Out-File $out -Encoding utf8
Get-Content $out
