# Fix: token/cost metering diverges from actual provider usage

Branch: `fix/token-cost-metering` (do NOT deploy)

## Evidence pulled from the LIVE worker (2026-09-15T07:38Z)

`GET /api/executive/overview` -> `budget`:
```
daily: 100, monthly: 150
spentToday: 0.08640368000000001      <-- ledger truth (model_costs SUM(cost))
spentThisMonth: 16.309820300000002
tokensToday: 305919
tokensThisMonth: 58230073
```
(`0.08640368 / 305919 * 1e6 = $0.28244/M` - exactly the $0.27 in / $1.10 out mix.)

`GET /api/productivity/report` -> `today` (the OTHER dollar meter):
```
tokens: 305919, cost: 0.24473519999999999   <-- same tokens, 2.83x the dollars
```
`POST /api/doctor/run` -> `provider.balance`: **FAIL**
```
"AI provider is rejecting paid work: cloud runs failing with HTTP 402
 Insufficient Balance (last 2026-09-05T18:00:56.579Z)."
```
`aiDailyBudget` override = 100 while `wrangler.toml` `AI_DAILY_BUDGET = "5"`.

## Defects (each independently reproducible)

D1. `recordChatCost` (src/index.ts) calls `store.record()` which inserts into
    `model_costs`, but NEVER calls `store.addTokenUse(...)`. So `token_budgets`
    is only ever touched by the manual agent tool `productivity.record_token_usage`.
    Live proof: global token_budget says 21_000 tokens / $0.072 while the same
    moment's ledger says 305_919 tokens / $0.0864, and the productivity rollup
    says 305_919 tokens / $0.2447. Three meters, three numbers.

D2. Cost is derived by multiplying a token count by a flat blended rate instead
    of reading the ledger:
      - src/core/productivity/manager.ts:644  `cost: store.tokensToday() * 0.0000008`
      - src/core/productivity/manager.ts:655  `const cost = tokens * 0.0000008`
      - src/agent/tools.ts:1487 `input.cost ?? input.tokens * 0.0000008`
    Flat $0.80/M vs the real $0.28244/M mix = 2.83x overstatement of every
    non-ledger dollar figure.

D3. Pricing was duplicated in 3 files at 2 different values:
    - src/index.ts `recordChatCost`: 0.27 / 1.10   (the real ledger rate)
    - src/integrations/vision.ts local `estimateCost`: 0.27 / 1.10
    - manager.ts / tools.ts: flat 0.80
    `recordChatCost` also hardcoded the model rate instead of using the
    caller's `model`, so `deepseek-reasoner` (0.55/2.19) was billed as chat.

D4. Budget enforcement reads `token_budgets` (which never sees real usage -> the
    knob can never trip) while the on-screen "exhausted" banner reads
    `model_costs` + a $100 override. The two halves of the same feature read
    different, mutually inconsistent tables.

D5. The incident that is actually blocking paid work - HTTP 402 Insufficient
    Balance - was not surfaced as a budget/meter condition; the meter reported
    "$100/day with $0.0864 used" at the exact moment the provider was refusing
    all paid calls. The meter could not explain the outage ("token exhausted"
    with almost no spend).

## Fix

1. NEW `src/core/model/meter.ts` - the ONE place that turns a provider usage
   block into a ledger row + a budget increment (`meterModelCall`).
   - prices via `pricingFor(model)` (D3)
   - is the only writer of `addTokenUse` for provider usage (D1, D4)
   - attributes to scope `global` always + `task` when a taskId is known
   - records `providerCost` (billed) separately from `meterCost` (what the
     ledger says) so divergence is DETECTABLE and surfaces as a doctor issue,
     not a silent drift
2. `recordChatCost` in src/index.ts delegates to `meterModelCall`.
3. vision.ts records through the same path.
4. manager.ts `today.cost` + `dailyRollup` read `store.spentToday()` (the
   ledger) instead of `tokens * 0.0000008` (D2).
5. `productivity.record_token_usage` uses the shared pricing (D2/D3).
6. New doctor check `meter.provider_reconcile` that compares the passed-through
   provider usage against the recorded ledger and FAILS on drift (D5).
7. Tests: test/metering.test.ts.

## Acceptance criteria mapping

1. trace -> code path quoted in REPORT
2. defect + fix -> D1..D5 above
3. before/after on a controlled call -> test prints provider-reported vs
   recorded for the same call
4. test -> test/metering.test.ts
5. paths + branch -> REPORT
6. root cause IS established from local+live evidence (no guessing needed)
