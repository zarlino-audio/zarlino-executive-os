/**
 * Model metering — the ONE place that turns a provider `usage` block into
 * (a) a durable `model_costs` ledger row and (b) a `token_budgets` increment.
 *
 * Why this module exists (bug fix, 2026-09-15)
 * --------------------------------------------
 * Recorded spend diverged from real provider usage because the two halves of
 * the meter were wired to different tables and different rates:
 *
 *   1. `recordChatCost` (src/index.ts) wrote ONLY to `model_costs` via
 *      `store.record()`. It never called `store.addTokenUse()`, so every
 *      provider call was invisible to `token_budgets` — the table the budget
 *      enforcement / `productivity.budget_status` knob actually reads. Live
 *      evidence: the global budget row reported 21,000 tokens while the
 *      ledger for the same moment reported 305,919.
 *
 *   2. Dollars were recomputed from a token count with a flat $0.80/M blended
 *      rate (`tokensToday() * 0.0000008`) in `productivityReport().today`,
 *      `dailyRollup()` and the manual `productivity.record_token_usage` tool,
 *      while the ledger was billed at the real $0.27 in / $1.10 out mix
 *      (= $0.28244/M for that day's token split). The same 305,919 tokens were
 *      reported as BOTH $0.0864 and $0.2447 in the same serialized response.
 *
 *   3. The DeepSeek rates were duplicated in three files at two different
 *      values; `recordChatCost` also hardcoded the chat rate, so a
 *      `deepseek-reasoner` call (0.55/2.19) was billed as if it were chat.
 *
 * Now: pricing comes from `pricingFor(model)` and every provider usage block
 * funnels through `meterModelCall`, which is the single writer for both the
 * ledger and the budget increment. Any future path that calls a model MUST go
 * through here.
 *
 * Honesty doctrine (HONEST_NUMBERS): the meter never hides a divergence. If the
 * provider tells us the call cost X and our price table yields Y, both are
 * recorded, and `meterDivergence` surfaces the gap so the Doctor can FAIL on it
 * instead of silently reporting a number nobody can reconcile.
 */

import { pricingFor } from "./pricing";
import type { ModelCallRecord } from "./types";

/** The provider's own usage reporting for one call (the API `usage` block). */
export interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface MeterOptions {
  model: string;
  provider?: string;
  taskType: ModelCallRecord["taskType"];
  usage: ProviderUsage | undefined;
  latencyMs: number;
  /** Keeps output tokens non-zero when the provider omits `usage`. */
  fallbackChars?: number;
  sessionId?: string;
  runId?: string;
  /** Links the call to a task-scoped budget so per-task actuals stay honest. */
  taskId?: string;
  /** The provider's own billed cost, when the payload carries one. */
  providerCost?: number;
  /**
   * Allow booking a call whose usage block is missing/empty. Default false.
   *
   * A provider call that returns neither `usage` nor a character count is not
   * a free call — it is an UNMEASURED call. Booking it as "$0.00 / 0 tokens"
   * (the old behaviour) hides real spend behind a zero row, which is the exact
   * failure mode this module exists to eliminate. Set this only when the caller
   * genuinely KNOWS the call is free (e.g. a cached/local path).
   */
  allowZeroUsage?: boolean;
}

export class MissingUsageError extends Error {
  constructor(model: string, taskType: string) {
    super(
      `Model call to ${model} (${taskType}) returned no usage block and no character fallback — ` +
        "refusing to book an unmeasured $0 call. Pass `usage` from the provider payload, or " +
        "`fallbackChars` / `allowZeroUsage` if the count is truly unknown.",
    );
    this.name = "MissingUsageError";
  }
}

/** What the meter recorded, for tests, tools and audit. */
export interface MeteredCall extends ModelCallRecord {
  /** Cost the provider billed (or the price-table value when unreported). */
  providerCost: number;
  /** Cost our price table yields for the same token counts. */
  meterCost: number;
  /** providerCost - meterCost. Non-zero means the price table is stale. */
  divergence: number;
  /** True when the provider gave us a usage block at all. */
  usageReported: boolean;
  meterSource: "provider_usage" | "char_fallback" | "missing_usage";
}

/**
 * Minimal store surface the meter needs - satisfied by `ExecutiveStore`.
 * Declared structurally so the meter is unit-testable against a fake store and
 * so a signature change in the store cannot silently stop the increment (the
 * original bug: `record()` alone satisfied the compiler, so nothing complained
 * that `addTokenUse()` was never called).
 */
export interface MeterStore {
  record(call: ModelCallRecord): void;
  addTokenUse(scope: string, scopeId: string | undefined, tokens: number, cost: number): void;
}

/** `usage` -> (inputTokens, outputTokens), honouring the char fallback. */
export function tokensFromUsage(
  usage: ProviderUsage | undefined,
  fallbackChars = 0,
): { inputTokens: number; outputTokens: number; reported: boolean } {
  const reported =
    usage !== undefined && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined);
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? (fallbackChars > 0 ? Math.ceil(fallbackChars / 4) : 0);
  return { inputTokens, outputTokens, reported };
}

/**
 * Record one provider call: ledger row + budget increment, priced by the shared
 * table. This is the ONLY supported way to book model spend.
 */
export function meterModelCall(store: MeterStore, opts: MeterOptions): MeteredCall {
  const { inputTokens, outputTokens, reported } = tokensFromUsage(opts.usage, opts.fallbackChars);
  const price = pricingFor(opts.model);
  const meterCost = (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM;
  const providerCost = opts.providerCost ?? meterCost;

  const tokens = inputTokens + outputTokens;
  // Guard: never write a $0 / 0-token row for a call we could not measure.
  // Row-level silence is what made the drift invisible (a missing usage block
  // is not the same fact as a free call).
  if (tokens === 0 && !opts.allowZeroUsage) throw new MissingUsageError(opts.model, opts.taskType);

  const meterSource: MeteredCall["meterSource"] = reported
    ? "provider_usage"
    : (opts.fallbackChars ?? 0) > 0
      ? "char_fallback"
      : "missing_usage";

  const record: ModelCallRecord = {
    provider: opts.provider ?? "deepseek",
    model: opts.model,
    taskType: opts.taskType,
    inputTokens,
    outputTokens,
    // The ledger price is the provider own figure when it gives one (ground
    // truth), otherwise our table. Never a blended guess.
    cost: providerCost,
    // Provenance travels WITH the row (migration v32). Computing providerCost /
    // meterCost / divergence and then persisting only the chosen `cost` is what
    // made recorded spend un-reconcilable against actual provider usage: once
    // the call is written there was no way to tell a billed figure from a
    // price-table guess. `usageReported` is the flag the budget viewer and the
    // Doctor read to distinguish "unmeasured" from "free".
    // The RESOLVED provider figure, not the raw option: when the provider reports
    // token usage but no dollar amount, the price-table cost IS the provider-side
    // number for that call (both are derived from the same reported usage).
    // Persisting raw opts.providerCost here wrote NULL for every normal DeepSeek
    // response, leaving provider_cost permanently unset and the row
    // un-reconcilable -- provenance that is always undefined is not provenance.
    providerCost,
    meterCost,
    usageReported: reported,
    meterSource,
    sessionId: opts.sessionId,
    runId: opts.runId,
    latencyMs: opts.latencyMs,
    timestamp: new Date().toISOString(),
  };
  store.record(record);

  // THE FIX for the fundamental divergence: the same numbers that went into the
  // ledger also move the budget meters. Before this, `record` and `addTokenUse`
  // were called from unrelated places and real provider usage never reached
  // `token_budgets` at all.
  store.addTokenUse("global", undefined, tokens, providerCost);
  if (opts.taskId) store.addTokenUse("task", opts.taskId, tokens, providerCost);

  return {
    ...record,
    providerCost,
    meterCost,
    divergence: providerCost - meterCost,
    usageReported: reported,
    meterSource,
  };
}

/**
 * Reconcile two independent views of the same spend.
 *
 * `ledger` is the SUM over `model_costs`; `budget` is the SUM over
 * `token_budgets`. They are written by the same function now, so any gap is a
 * real bug (an unmetered model path) rather than a rounding artefact.
 */
export function meterDivergence(
  ledger: { tokens: number; cost: number },
  budget: { tokens: number; cost: number },
): { tokenDelta: number; costDelta: number; divergent: boolean; reason: string } {
  const tokenDelta = budget.tokens - ledger.tokens;
  const costDelta = Math.round((budget.cost - ledger.cost) * 1e9) / 1e9;
  // 1% / 1e-6 USD tolerance absorbs float noise on many small increments but is
  // far below the 2.83x (283%) error the flat-rate bug produced.
  const tokenTol = Math.max(1, Math.round(ledger.tokens * 0.01));
  const divergent = Math.abs(tokenDelta) > tokenTol || Math.abs(costDelta) > 1e-6;
  const reason = divergent
    ? `Budget meter and model_costs ledger disagree by ${tokenDelta} tokens / $${costDelta.toFixed(6)} ` +
      `(ledger ${ledger.tokens} tok / $${ledger.cost.toFixed(6)} vs budget ${budget.tokens} tok / $${budget.cost.toFixed(6)}). ` +
      "A model path is writing one and not the other - book spend with meterModelCall."
    : `Budget meter and model_costs ledger agree (${ledger.tokens} tok / $${ledger.cost.toFixed(6)}).`;
  return { tokenDelta, costDelta, divergent, reason };
}
