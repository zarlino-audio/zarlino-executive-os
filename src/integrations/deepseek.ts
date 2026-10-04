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

export function deepseekConfigured(env: DeepSeekEnv): boolean {
  return typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY.length > 8;
}

/**
 * One completion. Returns null (never throws) when unconfigured, refused,
 * slow, or returning an empty answer.
 */
export async function deepseekComplete(
  env: DeepSeekEnv,
  messages: DeepSeekChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; model?: string } = {},
): Promise<DeepSeekResult | null> {
  if (!deepseekConfigured(env)) return null;
  const model = opts.model ?? env.DEEPSEEK_CAO_MODEL ?? DEFAULT_CAO_DEEPSEEK_MODEL;
  const base = (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
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
    if (!res.ok) return null;
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
