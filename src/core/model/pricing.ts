/**
 * Model pricing — the SINGLE source of truth for turning token counts into
 * dollars.
 *
 * Why this module exists (bug fix, 2026-09-15):
 * The DeepSeek rates were duplicated in three places with two DIFFERENT
 * values: the real cost recorder (`recordChatCost`, vision `estimateCost`)
 * used $0.27 in / $1.10 out per 1M tokens, while the Productivity meter
 * (`dailyRollup` / `productivityReport`) used a flat $0.80 per 1M tokens.
 * The budget ceiling was therefore compared against a dollar figure computed
 * at a stale rate — one of the two root causes of the false "token exhausted"
 * report. Any future rate change must now happen HERE and nowhere else.
 */

/** Per-1M-token prices (USD) by model. Keep in sync with the provider's page. */
export const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "deepseek-chat": { inputPerM: 0.27, outputPerM: 1.1 },
  "deepseek-reasoner": { inputPerM: 0.55, outputPerM: 2.19 },
  // Vision reuses the chat model in this system; keep an explicit entry so a
  // future split does not silently fall back to the wrong rate.
  "deepseek-vl": { inputPerM: 0.27, outputPerM: 1.1 },
};

/** Fallback used when an unknown model id shows up (chat model rate). */
export const DEFAULT_PRICING = MODEL_PRICING["deepseek-chat"]!;

/** Token-delimited pricing for an arbitrary model id (never throws). */
export function pricingFor(model: string | undefined): { inputPerM: number; outputPerM: number } {
  if (!model) return DEFAULT_PRICING;
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Cost in USD for an input/output token pair, at the given model's rate.
 *
 * BUG FIXED HERE (2026-09-15, metering divergence follow-up): the signature
 * used to consume `outputTokens` but never price it —
 *
 *     return (inputTokens / 1_000_000) * p.inputPerM;   // <-- output dropped
 *
 * The parameter was silently ignored while all three call sites passed real
 * output counts, so any dollar figure derived through `estimateCost` (the
 * `productivity.record_token_usage` fallback rate, vision reporting) was
 * UNDER-stated. The ledger path (`recordChatCost`) priced output separately
 * by hand, which is exactly how the two halves of the meter drifted apart.
 * Output tokens are now priced here, once, for every caller.
 *
 * `model` is optional for backwards compatibility — omit it to use the
 * default (chat) rate.
 */
export function estimateCost(inputTokens: number, outputTokens: number, model?: string): number {
  const p = pricingFor(model);
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

/**
 * Bounded, explicitly-honest conversation rate for ESTIMATES only (never for
 * recording real spend). Assignments quote a round number before work starts;
 * actuals always come from `model_costs`. Kept here so the two can never drift.
 */
export const ESTIMATE_BLENDED_PER_MILLION = 0.8;
