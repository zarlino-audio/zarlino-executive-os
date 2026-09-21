/**
 * Provider-usage provenance (migration v32).
 *
 * Why this exists — the metering defect
 * -------------------------------------
 * `model_costs` recorded WHAT we booked, but not WHAT the provider told us.
 * `meter.ts` computes both numbers per call (`providerCost` vs `meterCost`) and
 * a `divergence` between them, then threw all three away: only the single
 * chosen `cost` value reached the database.
 *
 * Consequence, observed live (2026-09-15): the same instant reported
 * `spentToday = $0.0680` from `model_costs` while `token_budgets` said a
 * different number, and a "token exhausted" condition was surfaced against a
 * spend the meter itself described as almost zero. With only one number stored
 * per call there is nothing to reconcile the two meters against, so drift is
 * indistinguishable from a legitimate (expensive) call.
 *
 * These columns make the reconciliation possible, per row:
 *   - `provider_cost`  — the provider's own billed figure when the payload
 *                        carries one; NULL when the call used the char
 *                        fallback (i.e. the provider never reported usage at
 *                        all — "unmeasured", explicitly not "free").
 *   - `meter_cost`     — what our price table yields for the same token counts.
 *   - `usage_reported` — 1 when a real provider `usage` block was consumed.
 *   - `meter_source`   — 'provider_usage' | 'char_fallback' | 'missing_usage'.
 *
 * `cost` remains the value every dollar aggregate sums, so nothing that already
 * reads `model_costs` changes behaviour. `usage_reported = 0` lets the Doctor
 * and the budget viewer surface unmeasured spend instead of silently folding it
 * into the total as $0.
 *
 * Additive and nullable-defaulted on purpose: existing rows stay valid and
 * backfillable, and no reader breaks on an un-migrated row.
 */
export const METER_USAGE_SQL = `
ALTER TABLE model_costs ADD COLUMN provider_cost REAL;
ALTER TABLE model_costs ADD COLUMN meter_cost REAL;
ALTER TABLE model_costs ADD COLUMN usage_reported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_costs ADD COLUMN meter_source TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_costs_unreported ON model_costs(usage_reported, created_at);
`;
