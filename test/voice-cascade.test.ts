/**
 * Founder-channel cascade: Workers AI (strongest) -> DeepSeek API -> Workers AI
 * executive -> deterministic line.
 *
 * The founder asked for the DeepSeek fallback explicitly: the channel that
 * carries his instructions must not depend on a single provider.
 */
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { naturalFounderReply, voiceStatus, LAST_ENGINE_SETTING } from "../src/core/org/voice";
import { DEFAULT_EXEC_MODEL } from "../src/integrations/workersai";

const CAO_MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813";
const REAL_FETCH = globalThis.fetch;

let db: DatabaseSync;
let store: ExecutiveStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new ExecutiveStore(createNodeSql(db as never));
  store.migrate();
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.stubGlobal("fetch", REAL_FETCH);
});

const ctx = { pendingApprovals: [] as string[], openTasks: 1, ceoSummary: null, doctor: null };

/** Workers AI stub: CAO tier throws, executive tier answers. */
function workersAi(caoBehaviour: "ok" | "throw", execText = "exec answer") {
  const calls: string[] = [];
  return {
    calls,
    binding: {
      run: async (model: string) => {
        calls.push(model);
        if (model === CAO_MODEL && caoBehaviour === "throw") throw new Error("model unavailable");
        return { response: model === CAO_MODEL ? "cao answer" : execText, usage: { prompt_tokens: 10, completion_tokens: 3 } };
      },
    },
  };
}

/** DeepSeek stub: one successful chat completion. */
function stubDeepSeek(text = "deepseek answer") {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 120, completion_tokens: 20 },
      }),
    } as unknown as Response;
  });
  return bodies;
}

describe("founder channel cascade", () => {
  it("prefers the Workers AI CAO tier when it answers", async () => {
    const ai = workersAi("ok");
    const reply = await naturalFounderReply(store, { AI: ai.binding, CAO_AI_MODEL: CAO_MODEL }, "status?", ctx);
    expect(reply).toBe("cao answer");
    expect(store.getSetting(LAST_ENGINE_SETTING)).toBe(`cao:${CAO_MODEL}`);
  });

  it("falls back to the DeepSeek API when Workers AI refuses, and says so", async () => {
    const ai = workersAi("throw");
    const bodies = stubDeepSeek("deepseek answer");
    const reply = await naturalFounderReply(
      store,
      { AI: ai.binding, CAO_AI_MODEL: CAO_MODEL, DEEPSEEK_API_KEY: "sk-test-1234567890", DEEPSEEK_CAO_MODEL: "deepseek-chat" },
      "status?",
      ctx,
    );
    expect(reply).toBe("deepseek answer");
    expect(store.getSetting(LAST_ENGINE_SETTING)).toBe("deepseek:deepseek-chat");
    // The executive tier was never touched.
    expect(ai.calls).toEqual([CAO_MODEL]);
    expect(String((bodies[0] as { model: string }).model)).toBe("deepseek-chat");
  });

  it("uses the executive tier when DeepSeek is not configured", async () => {
    const ai = workersAi("throw");
    const reply = await naturalFounderReply(store, { AI: ai.binding, CAO_AI_MODEL: CAO_MODEL }, "status?", ctx);
    expect(reply).toBe("exec answer");
    expect(store.getSetting(LAST_ENGINE_SETTING)).toBe(`exec:${DEFAULT_EXEC_MODEL}`);
  });

  it("never dies: a failing DeepSeek call still yields the executive answer", async () => {
    const ai = workersAi("throw");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const reply = await naturalFounderReply(
      store,
      { AI: ai.binding, CAO_AI_MODEL: CAO_MODEL, DEEPSEEK_API_KEY: "sk-test-1234567890" },
      "status?",
      ctx,
    );
    expect(reply).toBe("exec answer");
  });

  it("reports the DeepSeek tier in the channel status", () => {
    expect(voiceStatus(store, {}).deepseekReady).toBe(false);
    expect(voiceStatus(store, { DEEPSEEK_API_KEY: "sk-test-1234567890" }).deepseekReady).toBe(true);
  });
});
