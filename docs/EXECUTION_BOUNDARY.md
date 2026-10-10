# Execution boundary — the VM is comms + intelligence, NOT engineering

*Effective 2026-10-10 (migration v39). This document is the binding description of the
VM/machine's operational role (spec §2.3, §11 phase 3).*

## The rule

The machine/VM that hosts the founder channel (WhatsApp bridge) and the OS runtime is the
**CEO's communication and intelligence environment**. It does not execute engineering work.

Engineering execution — writing or modifying source, running coding agents, compiling,
building, running test suites, rendering, packaging, signing, deploying — happens **remotely**
on GitHub Actions, dispatched and tracked by the Executive OS (see `REMOTE_EXECUTION.md`).

Forbidden on the VM, enforced by the OS rather than by convention:

- Writing/modifying project source code as an execution agent.
- Running engineering coding agents locally.
- Compiling, building, running test suites, rendering, packaging, signing, deploying.
- Serving as a fallback execution environment when remote execution fails. A remote failure
  is recorded as a failure/blocker; it is never silently retried on the VM.

## Enforcement (three layers, fail closed)

1. **Creation gate — `src/core/org/execution-boundary.ts`**
   `executive.request_local_task` / `executive.delegate_idea` / `POST /api/local-tasks`
   refuse engineering prompts with `code: "REMOTE_ONLY"`, and refuse every local dispatch
   that does not carry an explicit `machine_maintenance: true` acknowledgement. The
   classifier errs toward "engineering": false positives route work to the correct remote
   environment; false negatives would let engineering run on the VM.
2. **Claim gate — `ExecutiveStore.claimLocalTask`**
   Only rows explicitly tagged `execution_target = 'machine_maintenance'` are claimable.
   Untagged legacy rows are NOT claimable (fail closed). A daemon can never silently pick
   up an engineering task, even if an older client wrote one into the table.
3. **Policy sweep — `applyExecutionBoundarySweep`** (runs on every wake, idempotent)
   Classifies legacy PENDING rows by their **original** ask (the OS dispatch wrapper is
   stripped): engineering → `CANCELLED` with an explicit reason naming the remote route;
   everything else → tagged `machine_maintenance`.

Additionally:

- `scripts/local-agent.ts` removes the engineering tools (`local_write_file`,
  `local_run_command`, `local_run_tests`, `local_build_console`, `local_deploy_website`,
  `local_new_plugin`, `local_build_plugin`, `local_plugin_tests`, `local_render_ab`,
  `local_fl_launch_test`, `local_package_release`, `local_ship_check`) from the default
  toolset. A dedicated remote build environment may opt in with
  `LOCAL_ENGINEERING_ENABLED=1`; the VM's operational role must NOT set it.
- Local read tools deny secret paths (`.dev.vars`, `.env*`, `*.pem`, `id_rsa*`, `auth/`,
  `.local/`, `.wrangler/`).
- The daemon heartbeat registers its org capability as `machine_maintenance` only.
- Doctor checks `execution.boundary` (HIGH) and `remote.execution` (HIGH) surface drift:
  engineering rows in the machine queue FAIL; missing `GITHUB_TOKEN` (no remote path)
  FAILs; stale run syncs WARN.

## What the VM still does (unchanged, protected)

- Hosts and maintains the WhatsApp bridge (`tools/whatsapp-bridge/`).
- Receives founder messages, classifies them (founder vs stranger), dedupes by message id.
- Runs the founder voice cascade (CAO → DeepSeek API → executive tier → canned).
- Retrieves second-brain context; relays authorized instructions to the Executive OS
  (cloud worker); receives execution updates and delivers reports.
- Reconnects and resynchronizes after interruptions.
- May run **non-engineering maintenance checks** explicitly acknowledged as such
  (health/liveness/connectivity/local facts).

## Operating notes

- After any repo update on the VM, restart the bridge (`start-bridge.vbs`) and — if the
  machine daemon runs there — restart it; claims will only ever return
  `machine_maintenance` rows. Engineering requests return `REMOTE_ONLY`.
- If a legacy local task was cancelled by the boundary sweep, its `error` field names the
  reason and the correct route: re-dispatch it remotely (`remote.dispatch_workflow`).
- `POST /api/local-tasks/requeue` only requeues `machine_maintenance` rows now.
