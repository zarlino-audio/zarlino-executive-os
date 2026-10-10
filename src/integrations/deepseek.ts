/**
 * Direct DeepSeek API client (chat completions).
 *
 * The founder's rule for the CAO seat: if Workers AI cannot answer, the agent
 * falls back to the DeepSeek API — a separate account and a separate bill, so a
 * Cloudflare-side outage or model retirement does not silence the founder
 * channel.
 *
 * Deliberately small: one function, hard timeout, no retries (the caller has a
 * fallback chain of its own), and every failure returns null with the reason
 * captured so the caller can record WHY the tier was skipped.
 */
export interface DeepSeekEnv {
  DEEPSEEK_API_KEY?: string;
  /** Secondary key, used when the primary is exhausted (402) or rejected (401/403). */
  DEEPSEEK_API_KEY_FALLBACK?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_CAO_MODEL?: string;
}

export interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export const DEFAULT_CAO_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * Every configured key, primary first, deduped and trimmed. The founder can
 * register a second account so a depleted primary balance cannot silence the
 * founder channel or stall agent runs (the 2026-10-05..11 outage: primary at
 * USD -0.00, HTTP 402 on every call).
 */
export function deepseekKeys(env: DeepSeekEnv): string[] {
  const keys = [env.DEEPSEEK_API_KEY, env.DEEPSEEK_API_KEY_FALLBACK]
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 8);
  return Array.from(new Set(keys));
}

export function deepseekConfigured(env: DeepSeekEnv): boolean {
  return deepseekKeys(env).length > 0;
}

/** True when an error means "this KEY cannot serve requests" (auth/balance). */
export function isDeepseekKeyFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /DeepSeek HTTP (401|402|403)\b/.test(message) || /insufficient balance/i.test(message);
}

/**
 * One completion. Returns null (never throws) when unconfigured, refused,
 * slow, or returning an empty answer. Tries each configured key in order and
 * only advances to the fallback on a KEY-level refusal (401/402/403) — a
 * malformed request would fail identically on the second key.
 */
export async function deepseekComplete(
  env: DeepSeekEnv,
  messages: DeepSeekChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; model?: string } = {},
): Promise<DeepSeekResult | null> {
  const keys = deepseekKeys(env);
  if (keys.length === 0) return null;
  const model = opts.model ?? env.DEEPSEEK_CAO_MODEL ?? DEFAULT_CAO_DEEPSEEK_MODEL;
  const base = (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  for (let i = 0; i < keys.length; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys[i]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.maxTokens ?? 400,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const keyLevel = res.status === 401 || res.status === 402 || res.status === 403;
        if (keyLevel && i < keys.length - 1) continue; // try the fallback key
        return null;
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body?.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) return null;
      return {
        text: text.trim(),
        model,
        promptTokens: body?.usage?.prompt_tokens ?? 0,
        completionTokens: body?.usage?.completion_tokens ?? 0,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
