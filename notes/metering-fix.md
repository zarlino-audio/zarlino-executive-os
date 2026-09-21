fix(executive-os): make recorded spend match actual provider usage

The token/cost meter booked dollars into `model_costs` (via
`token_budgets.cost_used_*`) while a sibling code path is what the
"token exhausted" condition read, so a real provider call could move one
table and not the other. The two halves of one feature could not agree,
and a $0.068 spend could be surfaced next to a "token exhausted" state.

What changed
------------
- `core/model/meter.ts` is now the single writer for both `model_costs`
  and `token_budgets`, and it records WHERE each dollar figure came from
  instead of throwing the provenance away. Previously it computed
  `providerCost`, `meterCost` and `divergence` per call and persisted only
  the one chosen `cost`, so a billed call was indistinguishable from a
  price-table guess.
- `core/model/meter.ts` also persisted the RAW `opts.providerCost` on the
  row. DeepSeek responses carry token counts but no dollar amount, so
  `provider_cost` was written NULL for every normal call, leaving the row
  un-reconcilable. It now persists the resolved figure.
- `db/meter-usage-schema.ts` (migration v32) adds `provider_cost`,
  `meter_cost`, `usage_reported` and `meter_source` to `model_costs`, plus
  an index on `(usage_reported, created_at)`. Additive and
  nullable-defaulted, so existing rows stay readable and backfillable.
- `db/store.ts` persists the provenance in `record()`, returns it from
  `costHistory()`, and gains `meterReconciliation()` -- the SUM over the
  ledger plus a count of calls the provider never measured. `usage_reported
  = 0` marks UNMEASURED spend, which is what "we do not know" has to look
  like; it must not look like "$0 spent".
- `db/schema.ts` / `db/migrations.ts`: SCHEMA_VERSION 31 -> 32.
- `index.ts`: exports `callDeepSeekForTest` so the real call path (request
  build -> fetch -> usage parse -> recordChatCost -> meter) can be asserted
  directly, with pinned provider numbers, instead of mocking the meter.

Verification
------------
`test/metering.test.ts` adds 3 tests. The full suite is 19 files / 181
tests green (was 178). One test drives the REAL call path against a stubbed
provider payload and asserts provider-reported tokens/cost equal the
recorded row AND that `model_costs` and `token_budgets` moved by the same
amount -- the regression guard.

A live controlled call against api.deepseek.com (HTTP 200):
  provider reported : 12 in / 2 out = 14 tokens
  meter recorded    : 12 in / 2 out = 14 tokens
  ledger spentToday : 0 -> $0.00000544
  budget cost today : 0 -> $0.00000544
  MATCHES: true

No deployment. Branch only.
