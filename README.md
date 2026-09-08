# Zarlino Executive OS

Autonomous business/engineering agent for the Zarlino audio plugin company, running on
Cloudflare Workers (Durable Object + SQLite) with a **self-healing System Doctor**.

The Executive OS is the "brain" that operates alongside the `zarlino-website` worker: it
keeps the product pipeline (ZScorch / ZTame / PresenceField), tracks finances, runs
research & maintenance tasks, gates risky actions behind approvals, and — since v1.1 —
**fixes itself automatically** on a 6-hour cadence and on every wake.

---

## Capabilities

| Area | What it does |
| --- | --- |
| **Pipeline orchestration** | Tasks, decisions, pipeline gates (product → DSP → UI → QA → ship), product registry |
| **Finance** | Daily/monthly snapshots, model-cost ledger, budget enforcement (daily/monthly/per-task/per-run) |
| **Memory** | Semantic memory store with recency/relevance scoring for grounded replies |
| **Autonomy** | Auto-runnable tasks (`tasks.auto_run = 1`) are started automatically by the Doctor/maintenance; high-risk actions still require Founder approval |
| **Integrations** | Web fetch/search, website deploy (wrangler), GitHub (repos/issues/PRs), Cloudflare (pages deploy), vision (image description), Paystack (revenue + transfers) |
| **Chat** | SSE-streamed DeepSeek chat with tool-calling loop, budget-gated |
| **Files** | Uploaded-file registry with size/type validation |
| **Local bridge** | `local_tasks` — the CLI agent (`scripts/local-agent.ts`) claims & executes machine tasks, heartbeats progress, reports results |
| **Productivity Manager** | Token budgets per scope, task→role/skill assignment, cost-efficiency optimization (stale-assignment reaping, budget reallocation, batching/model-tier recommendations), contradiction & misconception detection with audit-trailed resolution |
| **System Doctor** | 14 health checks, auto-fixes safe issues, logs every run, exposes `/api/doctor/run` + `/api/doctor/logs` |
| **Console** | Founder web console (`web/`): overview, Doctor, chat, tasks, approvals, productivity, budget settings |

---

## System Doctor (self-healing)

Runs on:

1. **Every DO wake** — constructor `blockConcurrencyWhile` (fast, no model calls).
2. **Cron** — `0 */6 * * *` (`wrangler.toml` `[triggers]`).
3. **Alarm** — self-rescheduling 6h alarm (5 min after a fresh wake so new deploys start fast).
4. **On demand** — `POST /api/doctor/run`, the `system.doctor` tool, or the CLI.

Checks (`src/core/doctor.ts`):

| Check | Severity | Auto-fix |
| --- | --- | --- |
| `schema.migrations` | CRITICAL | applies pending migrations |
| `db.tables` | HIGH | recreates missing core tables |
| `jobs.stale_runs` | HIGH | reaps stale agent runs |
| `tasks.expired_leases` | MEDIUM | re-queues expired local-task leases |
| `sessions.expired` | LOW | clears expired sessions |
| `streams.orphaned` | LOW | closes orphaned chat streams |
| `state.executive` | HIGH | — (reported) |
| `settings.budget` | MEDIUM | drops invalid overrides |
| `metrics.seed` | LOW | seeds missing product metrics |
| `secrets.required` | HIGH | — (reported; values never read) |
| `kv.health` | LOW | — (reported when KV unbindable) |
| `productivity.stale_assignments` | MEDIUM | marks 48h-no-progress assignments STALLED |
| `productivity.budget_health` | MEDIUM | — (reported; warns at ≥90% of monthly budget) |
| `productivity.contradictions` | LOW | — (reported; count of open findings) |

Every run is logged to `doctor_logs` (migration v17) and is visible in the console and via
`GET /api/doctor/logs`. The public `GET /api/health` reports the last Doctor result so
uptime monitors can alert on `doctorHealthy: false`.

---

## Productivity Manager (do more with less)

The Productivity Manager (`src/core/productivity/manager.ts`, migration v18) is the
Executive's efficiency layer. It runs a **safe, local maintenance pass on every DO wake**
(no model calls): daily rollup + safe optimizations.

### What it tracks & manages

| Concern | How |
| --- | --- |
| **Token budgets** | `token_budgets` per scope (global/role/task): daily+monthly caps, actual usage, cost. Global budget recalibrated to env vars; under-utilized scopes release budget to over-utilized ones. |
| **Task assignment** | `productivity_assignments` link tasks to roles with a token budget + cost estimate; `productivity.recommend_assignment` picks the best role by **skill coverage + historical cost per task**. |
| **Roles & skills** | `role_skills` (proficiency 1–5) seeded from the 12 technical roles; `task_skills` infer required skills from task text; skill gaps are surfaced. |
| **Optimization** | `optimize()` applies **safe/reversible** fixes (stale assignments → STALLED, budget recalibration, budget reallocation) and records recommendations (batching ≥3 same-priority tasks, model-tier downgrades, skill gaps). Every event is audited in `optimization_events`. |
| **Contradictions** | `detectContradictions()` scans for stale approved decisions with open tasks, done-but-running tasks, duplicate open tasks, shipped products with open gates, auto-run blocked tasks, misassignments, budget-override mismatches. Idempotent; resolve with an audited resolution. |
| **Metrics** | Daily rollups (`productivity_metrics`): tasks done, tokens, cost, tasks/$ and avg tokens/task. |

### API

`GET /api/productivity/report` · `GET /api/productivity/budget` · `GET /api/productivity/assignments` ·
`POST /api/productivity/assign` · `POST /api/productivity/optimize` ·
`GET /api/productivity/contradictions` · `POST /api/productivity/contradictions/detect` ·
`POST /api/productivity/contradictions/:id/resolve` · `GET /api/productivity/metrics`

Agent tools: `productivity.report`, `productivity.budget`, `productivity.recommend_assignment`,
`productivity.assign`, `productivity.optimize`, `productivity.detect_contradictions`,
`productivity.list_contradictions`, `productivity.resolve_contradiction`,
`productivity.record_token_usage`, `productivity.skills`.

### Safety rails

- Only **reversible** optimizations are auto-applied; judgment calls become recommendations.
- Contradiction detection is idempotent (identical OPEN findings never duplicate).
- Budget reallocation is bounded (±10%) and audited.

### CLI

```bash
npm run doctor            # check against the live worker (or local with --local)
npm run doctor:fix        # check + auto-fix
npm run maintenance       # maintenance sweep
npm run doctor -- --local # run checks against .local/exec.db (no network)
```

---

## Quick start

```bash
npm install
npx tsc --noEmit          # typecheck
npm test                  # vitest (21 tests)
npm run doctor -- --local # run the System Doctor locally

# local worker
npx wrangler dev          # http://127.0.0.1:8787

# local console (proxies /api to the dev worker)
npm --prefix web install
npm run console:dev       # http://127.0.0.1:5173
npm run build:console     # rebuild web/dist
```

### Auth

**Founder sign-in is username/password** (seeded by migration v19: username
`Khritical`, a temporary password the Founder MUST rotate from the console →
Settings → Change password). Passwords are PBKDF2-SHA256 (100k iterations,
`src/core/auth/passwords.ts`), sessions last 30 days, 5 failed attempts lock
the account for 15 minutes, and changing the password signs out every other
device. `POST /api/auth/login` returns a session token used as
`Authorization: Bearer …`; `POST /api/auth/change-password` rotates it.

`FOUNDER_AUTH_TOKEN` remains as a **machine/API key** for the CLI and local
agent (`npm run doctor`, `npm run agent:local` read it from `.dev.vars`).

### Secrets

Local: `executive-os/.dev.vars` (git-ignored). Production: `wrangler secret put <NAME>`.

| Secret | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | model calls (DeepSeek OpenAI-compatible) |
| `FOUNDER_AUTH_TOKEN` | machine/API auth for the CLI + local agent (Bearer) |
| `GITHUB_TOKEN` | GitHub integration tools |
| `CF_API_TOKEN` | Cloudflare pages deploy tool |
| `PAYSTACK_SECRET_KEY` | revenue + transfer tools |
| `ZARLINO_LICENSE_PRIVATE_KEY` | license verification (required — Doctor warns if missing) |

Budget vars (`wrangler.toml [vars]`): `AI_DAILY_BUDGET`, `AI_MONTHLY_BUDGET`,
`AI_PER_TASK_BUDGET`, `AI_PER_RUN_BUDGET`. Overridable at runtime via
`POST /api/settings` (console → Settings).

---

## Architecture

```
Worker entry (src/index.ts)
 ├─ ExecutiveAgent (Durable Object, use_sqlite)
 │   ├─ constructor → migrate() + wake maintenance (Doctor + start auto jobs) + setAlarm
 │   ├─ alarm() → full maintenance + auto-job execution
 │   ├─ scheduled (cron) → /api/_scheduled → full maintenance
 │   └─ fetch() → REST API (auth-gated except /api/health + login)
 ├─ agent/tools.ts          → tool registry (wired to store + env)
 ├─ core/doctor.ts          → System Doctor (11 checks, auto-fix, logging)
 ├─ core/tasks/model.ts     → task state machine
 ├─ core/approvals/queue.ts → approval gating
 ├─ core/finance/calc.ts    → budget math
 ├─ core/model/cost.ts      → model cost ledger
 ├─ core/memory/retrieval.ts→ memory scoring
 ├─ core/tools/             → registry + tool types
 ├─ db/                     → sql adapter, schema (v1–v17), migration runner, store
 └─ integrations/           → web, website, github, cloudflare, vision, paystack
```

### Schema (migrations v1 → v18)

`db/schema.ts` + `db/migrations.ts` (deterministic baseline seed, idempotent
`INSERT OR IGNORE`). Latest: **v18** adds the Productivity Manager tables
(assignments, role/task skills, token budgets, optimization events,
contradictions, metrics). The Doctor auto-applies any pending migrations on
wake, so deploys with new migrations self-heal.

---

## Maintenance (what "keep it healthy" means)

1. **Add a migration, not ad-hoc DDL** — new tables/columns go in `db/schema.ts` as
   migration `vN+1`; the Doctor applies it everywhere automatically.
2. **Extend the Doctor, not scattered scripts** — new health rules go in
   `DOCTOR_CHECKS` (`src/core/doctor.ts`). Keep auto-fixes safe & reversible.
3. **Budget first** — any new AI feature must respect the budget gates in
   `core/finance/calc.ts`; bump caps in `wrangler.toml` / `/api/settings`, never in code.
4. **Test** — every change ships with a test in `test/` (`store.test.ts`,
   `doctor.test.ts`, `paystack.test.ts`). Run `npm test` + `npx tsc --noEmit`.
5. **Deploy** — `npm run deploy` (bundle ~770 KiB, gzip ~129 KiB). Migrations are
   handled by the DO `[[migrations]]` block + Doctor.
6. **Rotate secrets** — if a `.dev.vars` or token ever leaks, rotate it in the
   provider console and `wrangler secret put` the replacement.

### Safety rails

- High/CRITICAL-risk tools require `confirm:true` (`/api/tools/run`) or a human
  approval record — never executed silently.
- The Doctor only auto-fixes *reversible* state; judgment calls are surfaced as
  `action` items for the Founder.
- `internal()` gate protects the `/api/_scheduled` kick from public access.
- `nodejs_compat` compatibility flag is required for the built-in SQLite + fetch tooling.
