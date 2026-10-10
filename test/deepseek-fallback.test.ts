/**
 * DeepSeek key fallback (added 2026-10-11 after the primary account hit
 * HTTP 402 / USD -0.00 and stalled chat, agent runs and the founder channel;
 * the founder registered a second account as the fallback).
 *
 * Rules pinned here:
 *   - keys are trimmed/deduped, primary first;
 *   - the fallback is spent ONLY on an auth/balance refusal (401/402/403);
 *   - a request-shaped error (400) must fail without touching the second key;
 *   - a healthy primary never touches the fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepseekComplete, deepseekConfigured, deepseekKeys, isDeepseekKeyFailure } from "../src/integrations/deepseek";

afterEach(() => vi.unstubAllGlobals());

function res(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

describe("deepseek key fallback", () => {
  it("deepseekKeys: trims, dedupes, keeps primary first", () => {
    expect(deepseekKeys({ DEEPSEEK_API_KEY: " primary-key-123 ", DEEPSEEK_API_KEY_FALLBACK: "fallback-key-456" })).toEqual([
      "primary-key-123",
      "fallback-key-456",
    ]);
    expect(deepseekKeys({ DEEPSEEK_API_KEY: "same-key-1234", DEEPSEEK_API_KEY_FALLBACK: "same-key-1234" })).toEqual(["same-key-1234"]);
    expect(deepseekKeys({})).toEqual([]);
    expect(deepseekConfigured({ DEEPSEEK_API_KEY_FALLBACK: "fallback-key-456" })).toBe(true);
  });

  it("isDeepseekKeyFailure classifies auth/balance refusals only", () => {
    expect(isDeepseekKeyFailure(new Error("DeepSeek HTTP 402: Insufficient Balance"))).toBe(true);
    expect(isDeepseekKeyFailure(new Error("DeepSeek HTTP 401: Authentication Fails"))).toBe(true);
    expect(isDeepseekKeyFailure(new Error("DeepSeek HTTP 403: forbidden"))).toBe(true);
    expect(isDeepseekKeyFailure(new Error('DeepSeek HTTP 400: {"error":"bad request"}'))).toBe(false);
    expect(isDeepseekKeyFailure(new Error("network down"))).toBe(false);
  });

  it("deepseekComplete retries with the fallback key on 402 and returns its answer", async () => {
    const calls: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers as HeadersInit).get("Authorization"));
        if (calls.length === 1) return res(402, { error: { message: "Insufficient Balance" } });
        return res(200, { choices: [{ message: { content: "fallback answered" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
      }),
    );
    const out = await deepseekComplete(
      { DEEPSEEK_API_KEY: "primary-key-123", DEEPSEEK_API_KEY_FALLBACK: "fallback-key-456" },
      [{ role: "user", content: "hi" }],
    );
    expect(out?.text).toBe("fallback answered");
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe("Bearer primary-key-123");
    expect(calls[1]).toBe("Bearer fallback-key-456");
  });

  it("deepseekComplete does NOT spend the fallback on a request-shaped error", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return res(400, { error: { message: "bad request" } });
      }),
    );
    const out = await deepseekComplete(
      { DEEPSEEK_API_KEY: "primary-key-123", DEEPSEEK_API_KEY_FALLBACK: "fallback-key-456" },
      [{ role: "user", content: "hi" }],
    );
    expect(out).toBeNull();
    expect(calls).toBe(1);
  });

  it("deepseekComplete succeeds on the primary without touching the fallback", async () => {
    const auths: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        auths.push(new Headers(init?.headers as HeadersInit).get("Authorization"));
        return res(200, { choices: [{ message: { content: "primary answered" } }] });
      }),
    );
    const out = await deepseekComplete(
      { DEEPSEEK_API_KEY: "primary-key-123", DEEPSEEK_API_KEY_FALLBACK: "fallback-key-456" },
      [{ role: "user", content: "hi" }],
    );
    expect(out?.text).toBe("primary answered");
    expect(auths.length).toBe(1);
  });
});
