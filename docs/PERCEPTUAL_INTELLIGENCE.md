# Perceptual Intelligence — Implementation Summary

Implements `specs/zarlino-artificial-organization.md` (45 sections) inside the
Executive OS. Deployed as migration **v22** (`perceptual_intelligence`).

## What was built

| Spec | Implementation |
|---|---|
| §2 Perceptual Intelligence layer | New first-class capability: tables, core module, tools, API, console view, doctor check. |
| §3 Five evidence layers | `EVIDENCE_LAYERS` (engineering, measurement, perceptual, workflow, market) + governance. Each tracked independently in `product_validations`. |
| §4-5 Evaluator panel ≠ employees | `perceptual_evaluators` with `actor_type` forced to `external_human \| internal_agent \| customer` — different organizational actors stay distinct. |
| §6 Test registry | `perceptual_tests` (hypothesis, objective, protocol, stimuli, conditions, blinding, randomization, metrics, acceptance threshold, sample target, tier). |
| §7 Test types | `blind_preference`, `abx_identification`, `problem_solution`, `workflow`, `preference_reach`. |
| §8 Test pipeline | statuses `draft → designed → recruiting → in_progress → completed → analyzed → closed`; analysis endpoint returns aggregation + knowledge draft. |
| §9 Anti-manipulation | Results are **append-only**: no PATCH/DELETE routes or store methods exist for `perceptual_results`. Engineering provides builds/metadata; it cannot edit evaluator responses. |
| §10 Blinding | `blinding`: `blind`, `double_blind`, `unblinded`. |
| §11 Evaluator calibration | `reliability_by_domain_json` — per-domain scores only; no universal "good ear" score. Attention-check failures auto-reject a response. |
| §12 Panel composition | Panel filterable by `actor_type`/`availability`; composition planning happens per test in `evaluator_requirements`. |
| §13 Sample sizes | Tiers with minimums: exploratory 5, validation 12, high-confidence 20, commercial 30. Aggregations below the minimum are explicitly labeled **WEAK evidence** — never pretended strong. |
| §14 Validation gate | `product_validations` (6 layers) + `evaluateProductGates()` computes per-stage requirements. Technical completion is NOT product validation. |
| §15 Kill system | `evaluateProductGates()` recommends `KILL`/`ITERATE`/`REPOSITION`; sunk effort is not an input to the decision. |
| §16 Scoring | `scoreProduct()` with versioned weights (model v1, default 30/20/15/10/10/5/5/5) stored in settings — configurable, never permanent truth. |
| §18 Bounded cycles | `iteration` on validations; `MAX_VALIDATION_CYCLES = 3` → KILL or ESCALATE. |
| §24 Conflict visibility | Computed recommendation is separate from the recorded founder decision; conflicts are surfaced (`evaluation.conflict`), never hidden. |
| §26 Decision matrix | Hard overrides: governance FAIL beats everything; engineering/measurement FAIL beats commercial PASS; perceptual FAIL → ITERATE/KILL; market FAIL → REPOSITION/KILL. |
| §27-29, §40 Knowledge base | `perceptual_knowledge` (category, musical context, desired outcome, observations, confidence, sample size, protocol, evidence tier) + `deriveKnowledge()` from aggregations. |
| §36-37 KPIs | `perceptualKpi()`: Validated Product Yield, tests by status/tier, active evaluators, evidence gaps, avg prototype→decision cycle days. |
| §39 Failure taxonomy | `failure_analyses` with 8 failure classes; engineering hours become organizational learning. |
| §42 Human sensor network | Console "Panel" tab manages the external network; agents never substitute synthetic consensus for human perception. |

## Where it lives

- Schema/migration: `src/db/schema.ts` (`PERCEPTUAL_SQL`), `src/db/migrations.ts` (v22)
- Types: `src/types.ts` (`PerceptualEvaluator`, `PerceptualTest`, `PerceptualResult`, `PerceptualKnowledge`, `ProductValidation`, `FailureAnalysis`)
- Core logic (pure): `src/core/perceptual/manager.ts`
- Store: `src/db/store.ts` (perceptual section)
- Agent tools: `src/agent/tools.ts` (`perceptual.*` — 14 tools)
- API: `src/index.ts` (`/api/perceptual/*` + `perceptual` key in the data bundle)
- Doctor check: `src/core/doctor.ts` (`perceptual.evidence_gaps`, MEDIUM, report-only)
- Console: `web/src/views/perceptual.tsx` (Gates / Tests / Panel / Knowledge / Failures tabs)
- Tests: `test/perceptual.test.ts` (16 tests; suite 71/71)

## Honest seeded baseline

`product_validations` seeds ZScorch and ZTame with engineering/measurement/
governance PASS but **perceptual INCONCLUSIVE** — matching reality (ZTame P8
A/B listening test still BLOCKED). The doctor's `perceptual.evidence_gaps`
check therefore WARNs until controlled listening tests are run and results
recorded. That warning is the point: AI judgment is not equivalent to external
human listening evidence.

## Not implemented (future increments)

- External stimulus delivery & collection UI for remote evaluators (public
  test-taking pages, secure stimulus hosting) — currently results are entered
  manually via console/API/agent tools.
- Evaluator compensation logistics (Paystack payout flows) — profiles are
  tracked, payment is not wired.
- Automatic reliability scoring updates from test history — the per-domain
  JSON is maintained manually/by agents today.
- Full panel-composition planning tooling (quota per segment).
