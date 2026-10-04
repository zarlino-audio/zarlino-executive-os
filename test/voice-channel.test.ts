/**
 * Founder-channel guarantees.
 *
 * These lock the 2026-10 finding: the 15-minute CEO cron drained the whole
 * daily neuron allowance, so the founder's WhatsApp agent silently degraded to
 * a canned line while the console said everything was fine. Three things must
 * stay true forever:
 *
 *   1. background work can never spend the founder's reserved allowance;
 *   2. the founder's channel may spend that reserve (it is the priority);
 *   3. the OS records WHICH engine answered, so a downgrade is a fact on the
 *      doctor report instead of an invisible fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import {
  executiveGenerate,
  neuronCaoReserve,
  neuronLedger,
  DEFAULT_EXEC_MODEL,
} from "../src/integrations/workersai";
import {
  CAO_BLOCKED_SETTING,
  LAST_ENGINE_SETTING,
  naturalReplyFallback,
  naturalFounderReply,
  voiceStatus,
} from "../src/core/org/voice";
import { DOCTOR_CHECKS, type DoctorContext } from "../src/core/doctor";

const CAO_MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813";
const BUDGET = 10_000;
const RESERVE = 2_500;

/** AI binding stub with per-model behaviour. */
function stubAi(behaviour: (model: string) => "ok" | "throw" | "empty"): { calls: string[]; binding: unknown } {
  const calls: string[] = [];
  return {
    calls,
    binding: {
      run: async (model: string) => {
        calls.push(model);
        const mode = behaviour(model);
        if (mode === "throw") throw new Error("paid plan required");
        if (mode === "empty") return {};
        return { response: "ALIVE", usage: { prompt_tokens: 10, completion_tokens: 2 } };
      },
    },
  };
}

const env = (extra: Record<string, string | undefined> = {}) => ({
  AI: stubAi(() => "ok").binding,
  EXEC_AI_MODEL: DEFAULT_EXEC_MODEL,
  CAO_AI_MODEL: CAO_MODEL,
  AI_NEURON_DAILY_BUDGET: String(BUDGET),
  AI_NEURON_CAO_RESERVE: String(RESERVE),
  ...extra,
});

let db: DatabaseSync;
let store: ExecutiveStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new ExecutiveStore(createNodeSql(db as never));
  store.migrate();
});
afterEach(() => {
  db.close();
});

/** Pretend the day already spent `n` neurons. */
function spend(n: number): void {
  const key = `ai_neurons:${new Date().toISOString().slice(0, 10)}`;
  store.setSetting(key, String(n));
}

const msgs = [{ role: "user", content: "ping" }];

describe("founder allowance is reserved", () => {
  it("background work stops at budget minus reserve", async () => {
    spend(BUDGET - RESERVE);
    const ai = stubAi(() => "ok");
    const e = { ...env(), AI: ai.binding };

    expect(await executiveGenerate(e, store, msgs)).toBeNull();
    expect(ai.calls).toHaveLength(0);

    const founder = await executiveGenerate(e, store, msgs, { class: "founder" });
    expect(founder?.text).toBe("ALIVE");
    expect(ai.calls).toHaveLength(1);
  });

  it("even the founder channel stops when the whole day is gone", async () => {
    spend(BUDGET);
    const ai = stubAi(() => "ok");
    const e = { ...env(), AI: ai.binding };
    expect(await executiveGenerate(e, store, msgs, { class: "founder" })).toBeNull();
    expect(ai.calls).toHaveLength(0);
  });

  it("charges the ledger for what it spent", async () => {
    const before = neuronLedger(store, env()).used;
    await executiveGenerate({ ...env(), AI: stubAi(() => "ok").binding }, store, msgs);
    expect(neuronLedger(store, env()).used).toBeGreaterThan(before);
  });

  it("ledger arithmetic never goes negative and keeps the reserve honest", () => {
    spend(BUDGET + 500);
    const ledger = neuronLedger(store, env());
    expect(ledger.left).toBe(0);
    expect(ledger.backgroundLeft).toBe(0);
    expect(neuronCaoReserve(env())).toBe(RESERVE);
  });

  it("defaults the reserve to a quarter of the budget when unset", () => {
    expect(neuronCaoReserve({ AI_NEURON_DAILY_BUDGET: "8000" })).toBe(2000);
    expect(neuronCaoReserve({})).toBe(2500);
  });
});

describe("the founder channel records which engine answered", () => {
  const ctx = { pendingApprovals: [] as string[], openTasks: 3, ceoSummary: null, doctor: null };

  it("uses the CAO tier when it answers", async () => {
    const e = env();
    const reply = await naturalFounderReply(store, e, "status?", ctx);
    expect(reply).toBe("ALIVE");
    expect(store.getSetting(LAST_ENGINE_SETTING)).toBe(`cao:${CAO_MODEL}`);
  });

  it("calls the reasoning model with reasoning off and a real token budget", async () => {
    // Measured on the live account: a 16-token budget with default reasoning
    // returned EMPTY content (the reasoning pass ate the allowance) and the
    // founder silently got the canned line. Lock the shape that works.
    const seen: Array<Record<string, unknown>> = [];
    const e = {
      ...env(),
      AI: {
        run: async (_m: string, input: Record<string, unknown>) => {
          seen.push(input);
          return { choices: [{ message: { content: "ALIVE" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
        },
      },
    };
    await naturalFounderReply(store, e, "status?", ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reasoning_effort).toBe("none");
    expect(Number(seen[0]!.max_completion_tokens)).toBeGreaterThanOrEqual(400);
  });

  it("retries once when the completion comes back empty", async () => {
    const budgets: unknown[] = [];
    const e = {
      ...env(),
      AI: {
        run: async (_m: string, input: Record<string, unknown>) => {
          budgets.push(input.max_completion_tokens);
          return budgets.length === 1
            ? { choices: [{ message: { content: "" } }] }
            : { choices: [{ message: { content: "Recovered" } }] };
        },
      },
    };
    const reply = await naturalFounderReply(store, e, "status?", ctx);
    expect(reply).toBe("Recovered");
    expect(budgets).toHaveLength(2);
  });

  it("falls back to the executive tier and says so when the CAO tier refuses", async () => {
    const ai = stubAi((m) => (m === CAO_MODEL ? "throw" : "ok"));
    const e = { ...env(), AI: ai.binding };
    const reply = await naturalFounderReply(store, e, "status?", ctx);
    expect(reply).toBe("ALIVE");
    expect(store.getSetting(LAST_ENGINE_SETTING)).toBe(`exec:${DEFAULT_EXEC_MODEL}`);
    expect(ai.calls).toEqual([CAO_MODEL, DEFAULT_EXEC_MODEL]);
  });

  it("does not re-probe a refusing CAO tier on every message", async () => {
    const ai = stubAi((m) => (m === CAO_MODEL ? "throw" : "ok"));
    const e = { ...env(), AI: ai.binding };
    await naturalFounderReply(store, e, "one", ctx);
    await naturalFounderReply(store, e, "two", ctx);
    // CAO probed once, executive answered twice.
    expect(ai.calls.filter((m) => m === CAO_MODEL)).toHaveLength(1);
    expect(ai.calls.filter((m) => m === DEFAULT_EXEC_MODEL)).toHaveLength(2);
  });

  it("never leaves the founder hanging: canned line only as the last resort", async () => {
    const ai = stubAi(() => "throw");
    const e = { ...env(), AI: ai.binding };
    spend(BUDGET); // nothing left for anyone
    const reply = await naturalFounderReply(store, e, "status?", ctx);
    expect(reply).toBe(naturalReplyFallback(ctx));
    expect(store.getSetting(LAST_ENGINE_SETTING)).toBe("fallback:canned");
  });

  it("reports the channel status the console and doctor read", async () => {
    expect(voiceStatus(store, env()).lastEngine).toBeNull();
    const ai = stubAi((m) => (m === CAO_MODEL ? "throw" : "ok"));
    await naturalFounderReply(store, { ...env(), AI: ai.binding }, "status?", ctx);
    const status = voiceStatus(store, env());
    expect(status.caoError).toContain("paid plan required");
    expect(status.caoBlockedAt).toBeTruthy();
    expect(status.caoRetrying).toBe(false);
    expect(status.lastEngine).toContain("exec:");
    expect(status.ledger.budget).toBe(BUDGET);
    expect(store.getSetting(CAO_BLOCKED_SETTING)).toBeTruthy();
  });
});

describe("doctor reports the founder channel", () => {
  const check = DOCTOR_CHECKS.find((c) => c.id === "ai.founder_channel");
  const ctx = (s: ExecutiveStore): DoctorContext => ({
    store: s,
    env: env() as unknown as Record<string, string | undefined>,
    now: () => new Date().toISOString(),
  });

  it("exists", () => {
    expect(check).toBeTruthy();
  });

  it("fails loudly when the allowance is gone", async () => {
    spend(BUDGET);
    const r = await check!.run(ctx(store), false);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain("canned");
  });

  it("does not cry wolf when the CAO tier carries the channel on a spent day", async () => {
    // The CAO model bills outside the neuron allowance: an exhausted day with
    // the top tier answering is NOT a broken founder channel.
    store.setSetting(LAST_ENGINE_SETTING, `cao:${CAO_MODEL}`);
    spend(BUDGET);
    const r = await check!.run(ctx(store), false);
    expect(r.status).toBe("WARN");
    expect(r.detail).toContain("CAO tier");
    expect(r.detail).not.toContain("canned");
  });

  it("warns when the top tier is refusing but names the fallback", async () => {
    store.setSetting("voice_cao_error", "paid plan required");
    const r = await check!.run(ctx(store), false);
    expect(r.status).toBe("WARN");
    expect(r.detail).toContain("paid plan required");
  });

  it("stays OK while the channel has a real model and room to think", async () => {
    spend(100);
    const r = await check!.run(ctx(store), false);
    expect(r.status).toBe("OK");
    expect(r.detail).toContain(CAO_MODEL);
  });
});
