# Executive OS documentation

## Core documents

- `CONSTITUTION.md` — the Zarlino Constitution v1.0 (governance; bound into the agent prompts,
  skills and both other repos' copilot instructions).
- `OPERATOR_RUNBOOK.md` — day-to-day operation of the OS (deploy, doctor, recovery).
- `INSTANCE_AND_RETIREMENT.md` — machine instances (VM / laptop), daemon registration and the
  retirement procedure.
- `EXECUTION_BOUNDARY.md` — the VM/machine is comms + intelligence only; how engineering work
  is kept out of the machine queue (creation gate, claim gate, policy sweep).
- `REMOTE_EXECUTION.md` — engineering runs on GitHub Actions: dispatch, monitoring, evidence,
  cancellation, statuses and bounds.
- `REMOTE_DEV_MACHINE.md` — remote build/dev machine notes.
- `PERCEPTUAL_INTELLIGENCE.md` — perceptual evaluation layer (evaluators, gates, knowledge).

## Specs

- `specs/aoi-technical-spec.md` — Artificial Organizational Intelligence technical spec.
- `specs/aorgi-retrofit-plan.md` — AOrgI retrofit plan (phases 1–5; status is recorded in the file).
- `specs/zarlino-qa-platform-spec-2.md` — QA platform plan (20-plugin roadmap).

## Audits

- `audits/chat-ui-v1-readonly-audit.md` — read-only chat UI audit (26 gaps).
- `audits/chat-ui-v2-closure.md` — closure table for that audit, with per-gap evidence.

## Archive

- `archive/governance-v31-patches/` — one-off patch scripts used to port the v31 evidence-gate
  governance. Kept for history; do not re-run.
