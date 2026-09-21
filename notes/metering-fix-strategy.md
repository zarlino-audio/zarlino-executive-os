# Token/cost metering — strategy + verification plan

Generated while the provider key was UNREACHABLE (all calls HTTP 402 Insufficient
Balance). The plan below does not depend on live provider access.

## Observation that drives the design

Measured over this session:

| view | tokens | dollars |
|---|---|---|
| `/api/executive/overview` -> `budget` (from `model_costs`) | 305,919 (today) / 58,230,073 (month) | 0.0864 (today) / 16.3098 (month) |
| `/api/productivity/report` -> `today` (tokens from `model_costs`) | 305,919 | (see below) |

`0.08640368 / 305919 * 1e6 = $0.28244/M` — exactly the $0.27 in / $1.10 out mix.
The per-call provider `usage` block (the only source of `input_tokens` /
`output_tokens`, since nothing else in the codebase writes those columns) is
therefore reaching `model_costs`. The ledger is NOT wildly wrong per call.

The divergences that ARE reproducible without a provider key:

* **D-A (daily accumulation).** `spentToday()` / `tokensToday()` filter
  `substr(created_at,1,10) = <today UTC>`. Since the process restart on
  2026-09-15, both returned 0 while `spentThisMonth()` returned 16.3098 /
  58.2M. A whole-month gap with a zero day means days in the month were
  accumulated and then cleared, or the rows are bucketed under a day key that
  is not the UTC day the reader computes. Root cause needs measurement against
  the live DB (see "Needs", below).
* **D-B (per-day rollup loses the month).** `dailyRollup()` *overwrites*
  `productivity_metrics` for today with the current UTC day snapshot. At 00:00
  UTC the day's accumulator is empty, so the previous day's metric row keeps
  its snapshot but every reader of "today" resets. Yesterday's real spend is
  therefore invisible to the productivity meter while the ledger still has it.
* **D-C (divide-by-ten, round-trip loss).** `dailyRollup` stores
  `cost: Math.round(cost * 100) / 100`. At ~$0.09/day this is pure loss (and at
  $0.004/day it stores 0). The ledger and the rollup can never be reconciled
  after the fact, because the rollup is a rounded copy, not the truth.
* **D-D (two writers, two tables).** `recordChatCost()` calls `store.record()`
  (ledger) and never `store.addTokenUse()` (budget). The budget table is
  written only by the manual agent tool `productivity.record_token_usage`, so
  the two meters can never agree. This is the auditable half of the original
  brief.

## Strategy (what gets changed)

1. Make `meterModelCall` the single writer for BOTH the ledger and the budget
   increment, and make the sink in `agentLoop` go through it (not around it).
2. Store the **provider's** `usage` verbatim for every call, and never derive a
   dollar figure from a token count at read time: the price table is applied
   once, at write time, from `pricingFor(model)`.
3. Add a `provider_cost` column so the provider-side number (when the payload
   carries one) and our price-table number are both on the row: divergence is
   then *recorded*, not inferred.
4. `dailyRollup` keeps the ledger as the source of truth (no rounding, no
   re-derivation) so `report.today.cost === store.spentToday()` exactly.
5. A doctor check that FAILS when ledger and budget meter disagree
   (`meterDivergence`), instead of both silently reporting different numbers.

## C* — controlled test call (criterion 3)

The provider is refusing paid calls (`HTTP 402 Insufficient Balance`), so a
*real* call cannot be made to show before/after. Instead the test drives the
REAL call path (`callDeepSeek` in src/index.ts) against a stubbed global
`fetch` that returns a DeepSeek-shaped payload whose `usage` block is known
(prompt 1200 / completion 300, i.e. $0.000654 at $0.27/$1.10 per M). The
assertion is: what the meter recorded for that call == what the stub's
`usage` says it cost. That is the exact quantity the brief asks for, and it is
reproducible in CI forever.

With that harness the D-D defect can be demonstrated directly rather than
argued from live numbers, which is what the earlier session could not do.

## What still needs live/DB evidence (do NOT guess — criterion 6)

1. The value of `DEEPSEEK_API_KEY` (in `.dev.vars` — read-only access, never
   modified). Without it `callDeepSeek` throws before any metering happens, so
   no real before/after is possible. **Current status: 402 for every model id.**
2. A SQL window over `model_costs` grouped by `substr(created_at,1,10)` (13
   months at most) to see which day keys actually have rows and whether any day
   is ever *absent* mid-month. That single query decides D-A.
3. `SELECT * FROM token_budgets` on the live DB to confirm the budget row's
   token count (believed 21,000) against the ledger's 305,919 today.
