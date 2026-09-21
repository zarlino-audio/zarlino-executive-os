/**
 * Metering path tests - recorded spend must match actual provider usage.
 *
 * 1. The REAL call path (callDeepSeek in src/index.ts) driven against a stubbed global
 *    fetch returning a DeepSeek-shaped payload. That is the only way to assert what the
 *    meter recorded for a call whose provider usage block is known exactly: the live
 *    provider key is not exercised here (see REPORT: measured provider responses are
 *    HTTP 402 Insufficient Balance), and stubbing fetch pins the expected numbers
 *    instead of observing them.
 * 2. The provenance columns (migration v32) that make divergence DETECTABLE instead of
 *    silent: provider usage vs price-table cost vs unmeasured calls.
 * 3. The one-writer guarantee: model_costs and token_budgets move together, so they
 *    cannot disagree by construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { callDeepSeekForTest } from "../src/index";
import { estimateCost } from "../src/core/model/pricing";
import { meterDivergence } from "../src/core/model/meter";

const emptyRegistry = { functionSchemas: () => [] } as never;

function deepseekPayload(promptTokens: number, completionTokens: number, content = "ok") {
  return {
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("metering: recorded spend matches provider usage", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  // Criterion 3 - the controlled call: meter recorded vs provider reported, SAME call.
  it("records exactly the provider-reported usage and cost for one real call path", async () => {
    const PROMPT = 1200;
    const COMPLETION = 300;
    const fetchStub = vi.fn(async () => jsonResponse(deepseekPayload(PROMPT, COMPLETION)));
    vi.stubGlobal("fetch", fetchStub);

    const before = {
      spentToday: store.spentToday(),
      tokensToday: store.tokensToday(),
      budgetToday: store.getTokenBudget("global")?.cost_used_today ?? 0,
      budgetTokens: store.getTokenBudget("global")?.tokens_used_today ?? 0,
    };

    await callDeepSeekForTest(
      "test-key",
      [{ role: "user", content: "hello" }],
      emptyRegistry,
      store,
      "deepseek-chat",
    );

    const provider = {
      inputTokens: PROMPT,
      outputTokens: COMPLETION,
      cost: estimateCost(PROMPT, COMPLETION, "deepseek-chat"),
    };
    const recorded = store.costHistory(1)[0]!;
    const after = {
      spentToday: store.spentToday(),
      tokensToday: store.tokensToday(),
      budgetToday: store.getTokenBudget("global")?.cost_used_today ?? 0,
      budgetTokens: store.getTokenBudget("global")?.tokens_used_today ?? 0,
    };

    /* eslint-disable no-console */
    console.log([
      "",
      "  -- CONTROLLED CALL: provider usage vs recorded meter --",
      `  provider reported  : ${provider.inputTokens} in / ${provider.outputTokens} out = ${provider.inputTokens + provider.outputTokens} tokens, $${provider.cost.toFixed(8)}`,
      `  meter recorded     : ${recorded.inputTokens} in / ${recorded.outputTokens} out = ${recorded.inputTokens + recorded.outputTokens} tokens, $${recorded.cost.toFixed(8)}`,
      `  ledger spentToday  : $${before.spentToday.toFixed(8)} -> $${after.spentToday.toFixed(8)} (delta $${(after.spentToday - before.spentToday).toFixed(8)})`,
      `  ledger tokensToday : ${before.tokensToday} -> ${after.tokensToday} (delta ${after.tokensToday - before.tokensToday})`,
      `  budget cost today  : $${before.budgetToday.toFixed(8)} -> $${after.budgetToday.toFixed(8)} (delta $${(after.budgetToday - before.budgetToday).toFixed(8)})`,
      `  budget tokens      : ${before.budgetTokens} -> ${after.budgetTokens} (delta ${after.budgetTokens - before.budgetTokens})`,
      `  row provenance     : usage_reported=${recorded.usageReported} source=${recorded.meterSource} provider_cost=$${recorded.providerCost?.toFixed(8)} meter_cost=$${recorded.meterCost?.toFixed(8)}`,
      "  -------------------------------------------------------",
      "",
    ].join("\\n"));
    /* eslint-enable no-console */

    expect(recorded.inputTokens).toBe(provider.inputTokens);
    expect(recorded.outputTokens).toBe(provider.outputTokens);
    expect(recorded.cost).toBeCloseTo(provider.cost, 12);
    expect(after.spentToday - before.spentToday).toBeCloseTo(provider.cost, 12);
    expect(after.tokensToday - before.tokensToday).toBe(PROMPT + COMPLETION);
    // The budget table (what enforcement reads) moved by the SAME amount - this is the
    // regression guard for the defect: ledger and budget meter were written by different
    // code paths, so a real provider call moved one and not the other.
    expect(after.budgetToday - before.budgetToday).toBeCloseTo(provider.cost, 12);
    expect(after.budgetTokens - before.budgetTokens).toBe(PROMPT + COMPLETION);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  // Criterion 2 - the defect as a behavioural assertion.
  it("keeps the model_costs ledger and the token_budgets meter in lockstep", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(deepseekPayload(800, 150))));
    for (let i = 0; i < 3; i++) {
      await callDeepSeekForTest("k", [{ role: "user", content: `m${i}` }], emptyRegistry, store);
    }
    const reconciliation = store.meterReconciliation();
    const globalBudget = store.getTokenBudget("global");
    // eslint-disable-next-line no-console
    console.log(`\\n  ledger: ${reconciliation.tokens} tok / $${reconciliation.cost.toFixed(8)} over ${reconciliation.calls} calls\\n  budget: ${globalBudget!.tokens_used_today} tok / $${globalBudget!.cost_used_today.toFixed(8)}\\n`);
    expect(reconciliation.tokens).toBe(3 * (800 + 150));
    expect(globalBudget!.tokens_used_today).toBe(reconciliation.tokens);
    expect(globalBudget!.cost_used_today).toBeCloseTo(reconciliation.cost, 12);
    const divergence = meterDivergence(
      { tokens: reconciliation.tokens, cost: reconciliation.cost },
      { tokens: globalBudget!.tokens_used_today, cost: globalBudget!.cost_used_today },
    );
    expect(divergence.divergent).toBe(false);
  });

  // Provenance: a billed call must be distinguishable from an unmeasured one.
  // Without this the recorded total cannot be reconciled against the provider.
  it("stores provider-usage provenance on every row (migration v32 columns)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(deepseekPayload(1000, 200))));
    await callDeepSeekForTest("k", [{ role: "user", content: "x" }], emptyRegistry, store);
    const row = store.costHistory(1)[0]!;
    expect(row.usageReported).toBe(true);
    expect(row.meterSource).toBe("provider_usage");
    expect(row.providerCost).toBeCloseTo(row.cost, 12);
    expect(row.meterCost).toBeCloseTo(row.cost, 12);
    const r = store.meterReconciliation();
    expect(r.unmeasuredCalls).toBe(0);
    expect(r.providerReportedCost).toBeCloseTo(r.cost, 12);
    expect(r.priceTableCost).toBeCloseTo(r.cost, 12);
  });
});
