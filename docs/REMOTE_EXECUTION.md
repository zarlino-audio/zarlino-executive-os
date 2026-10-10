# Remote execution — engineering work runs on GitHub Actions

*Introduced 2026-10-10 (migration v39). Implements spec §2.5, §4 (stages 5–7), §8, §9.*

## The contract

Engineering work is dispatched, monitored, and verified **remotely**. The Executive OS
never treats "a plan" or "a tool call succeeded" as execution:

```
objective/task ──dispatch──▶ GitHub Actions workflow ──poll──▶ status + artifacts
      ▲                                                              │
      └───────── evidence attached to the task (verified only on success) ◀──┘
```

Every dispatch is persisted in `remote_runs` (id, task, objective, repo, workflow, ref,
status, conclusion, GitHub run id/url, artifacts, evidence id, timestamps). State survives
model restarts and service interruptions.

## Lifecycle & statuses

| Status | Meaning |
| --- | --- |
| `DISPATCHED` | GitHub accepted the dispatch; the run id is not located yet (<15 min). |
| `QUEUED` / `IN_PROGRESS` | The GitHub run is active. |
| `COMPLETED` | GitHub concluded **success** — verified evidence is attached to the task. |
| `FAILED` | GitHub concluded anything other than success. Evidence is attached **unverified**; nothing is marked complete. |
| `CANCELLED` | The run was cancelled (founder/cancel_task/remote.cancel_run). |
| `CANCEL_REQUESTED` | Cancellation sent; waiting for GitHub to report the terminal state. |
| `UNMATCHED` | Dispatched but no GitHub run appeared within 15 minutes — recorded as a blocker with a reason (missing `workflow_dispatch`, wrong ref, missing `actions:write`). |

A failed or unmatched run **never** auto-completes a task. On success the evidence gate is
satisfied (a `command_output` evidence item with the raw conclusion/url/artifacts, marked
verified), after which the normal governance flow decides task completion.

## Tools (agent-facing)

| Tool | Permission / risk | Purpose |
| --- | --- | --- |
| `remote.dispatch_workflow` | execute / MEDIUM | Validate the workflow exists, refuse duplicate active dispatches for the same task, dispatch, record the run. Attach `taskId` so evidence lands on the board. |
| `remote.sync_runs` | read | Poll one run (`runId`) or a bounded batch; collect artifacts; finalize + attach evidence. |
| `remote.list_runs` | read | Inspect recent runs and the 7-day summary. |
| `remote.cancel_run` | modify / MEDIUM | Cancel an active run; if it already finished, the true terminal state is recorded instead of a fake cancel. |

`executive.cancel_task` propagates cancellation to all active remote runs for that task.

## API

- `GET  /api/remote/runs` — summary + recent runs.
- `POST /api/remote/dispatch` — `{ repo, workflow, ref?, inputs?, taskId?, objectiveId? }`.
- `POST /api/remote/sync` — bounded sync sweep (`{ limit? }`).
- `POST /api/remote/runs/:id/sync` — sync one run.
- `POST /api/remote/runs/:id/cancel` — cancel (`{ reason? }`).

The maintenance sweep polls active runs on **alarm/cron only** (bounded to 3 runs per sweep,
45 s minimum gap per run, 15 s HTTP timeout) so request wakes and console latency are
unaffected.

## Idempotency & bounds

- One **active** run per (task, repo, workflow). A duplicate dispatch is refused with the
  existing run id — duplicates are work duplication, not retries.
- Dispatch validates `repo` (`owner/name`) and `workflow` (`*.yml`) and the workflow's
  existence before dispatching. A dispatch to a non-existent workflow is a recorded failure
  (`WORKFLOW_NOT_FOUND`) with no run row and no evidence.
- No retry loops: syncs are bounded per sweep; GitHub errors are recorded with their HTTP
  status, not retried in a tight loop.

## Repository workflow contracts (actual, verified)

| Repo | Workflow | Notes |
| --- | --- | --- |
| `zarlino-audio/zarlino-executive-os` | `.github/workflows/ci.yml` | typecheck + tests + console build + bundle dry-run (ubuntu, ~minutes safe to dispatch). |
| `zarlino-audio/Zarlino` (plugin monorepo, private) | `.github/workflows/ztame-release-gate.yml` | Windows 2022 build + ctest + packaging; heavier, produces artifacts. `workflow_dispatch` supported. |

Dispatch only workflows that genuinely support `workflow_dispatch`; the dispatch call
validates existence but not the trigger type — an unsupported workflow surfaces as
`UNMATCHED` with the reason recorded.

## Verification semantics

- **Claimed** (an agent says done) ≠ **evidence-attached** ≠ **verified** ≠ **objective
  complete**. Remote runs move work between these states; they never collapse them.
- Objective completion is separately gated: `executive.update_objective` refuses `ACHIEVED`
  while linked tasks are open or no criteria are recorded, and notifies the founder when an
  objective is achieved.
