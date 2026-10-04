/**
 * The CEO cycle must not buy the same summary twice.
 *
 * The console polls every 60s and every wake runs a maintenance sweep that
 * includes this cycle - so the same 120-word summary was being regenerated
 * dozens of times an hour. On 2026-10-04 that drained the whole daily neuron
 * allowance before the founder ever asked anything, and his WhatsApp channel
 * quietly dropped to a canned line.
 *
 * The cycle itself (decisions, escalations, the cheap deterministic summary)
 * still runs every time. Only the expensive model call is throttled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { runCeoCycle } from "../src/core/org/ceo";
import { neuronsUsedToday } from "../src/integrations/workersai";

let db: DatabaseSync;
let store: ExecutiveStore;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  store = new ExecutiveStore(createNodeSql(db as never));
  store.migrate();
});
afterAll(() => {
  db.close();
});

/** A Workers AI stub that counts how many times it was actually called. */
function countingAi(reply = "All quiet."): { binding: unknown; calls: number } {
  const holder: { binding: unknown; calls: number } = {
    calls: 0,
    binding: {
      run: async () => {
        holder.calls += 1;
        return { response: reply, usage: { prompt_tokens: 40, completion_tokens: 8 } };
      },
    },
  };
  return holder;
}

const env = (ai: unknown, extra: Record<string, unknown> = {}) => ({
  AI: ai,
  EXEC_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  CEO_AUTO_APPROVE: "off",
  ...extra,
});

describe("CEO summary reuse", () => {
  it("asks the model on a cold cycle", async () => {
    const ai = countingAi();
    await runCeoCycle(store, env(ai.binding) as never, "test");
    expect(ai.calls).toBe(1);
    expect(store.latestCeoReport()?.id).toBeTruthy();
  });

  it("reuses the recent summary instead of buying it again", async () => {
    const before = neuronsUsedToday(store);
    const ai = countingAi("Another summary.");
    await runCeoCycle(store, env(ai.binding) as never, "wake");
    expect(ai.calls).toBe(0);
    expect(neuronsUsedToday(store)).toBe(before);
  });

  it("buys a fresh summary once the reuse window has passed", async () => {
    const ai = countingAi("Fresh summary.");
    await runCeoCycle(store, env(ai.binding, { CEO_SUMMARY_REUSE_MINUTES: "0" }) as never, "wake");
    expect(ai.calls).toBe(1);
  });

  it("a wake storm costs one model call, not one per wake", async () => {
    // Eleven wakes inside the 30-minute window: a recently written report
    // means zero calls here, and at most one if the window had just lapsed.
    // What must never happen is one call per wake.
    const ai = countingAi("Storm summary.");
    const e = env(ai.binding, { CEO_SUMMARY_REUSE_MINUTES: "30" }) as never;
    for (let i = 0; i < 11; i += 1) await runCeoCycle(store, e, "wake");
    expect(ai.calls).toBeLessThanOrEqual(1);
  });
});
