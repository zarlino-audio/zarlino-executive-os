/**
 * Growth-agent LLM drafting (prospect replies).
 *
 * The agent writes SHORT, honest replies for the outreach pipeline. Two hard
 * rules keep this safe: (1) the prompt may only use the facts below, and
 * (2) every draft must pass checkReplyPolicy() before it can be sent — if it
 * fails, the case escalates to the founder instead of auto-sending.
 */
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export const GROWTH_FACTS = {
  plugin:
    "ZTame — a zero-latency resonance suppressor (Windows VST3; same category of tool as Soothe-style resonance controllers).",
  price: "USD $49 on zarlinoaudio.com (payments in GHS are possible).",
  affiliate: "The affiliate program pays 25% per sale; details at https://zarlinoaudio.com/affiliates",
  license: "A free NFR review license can be provided for content/coverage.",
  support: "support@zarlinoaudio.com",
};

export function buildReplyPrompt(input: {
  name?: string;
  subject?: string;
  replyText: string;
  intent: string;
}): { system: string; user: string } {
  const system = [
    "You are the growth partner of Zarlino Audio, a small plugin studio.",
    "Write a SHORT, honest, personal email reply to a prospect (max 120 words).",
    "Rules:",
    "- Plain text only. No markdown, no bullet lists, no subject line, no placeholders.",
    "- Use ONLY these facts; never invent prices, discounts, guarantees or partnerships:",
    `  * ${GROWTH_FACTS.plugin}`,
    `  * Price: ${GROWTH_FACTS.price}`,
    `  * ${GROWTH_FACTS.affiliate}`,
    `  * ${GROWTH_FACTS.license}`,
    "- If something cannot be answered from these facts, say you will check and come back.",
    "- Friendly and direct. No hype. End exactly with:",
    "- Zarlino Audio",
    "support@zarlinoaudio.com",
  ].join("\n");
  const user = [
    `Prospect name: ${input.name ?? "there"}`,
    input.subject ? `Original subject: ${input.subject}` : "",
    `Their reply (intent classified as ${input.intent}):`,
    input.replyText,
    "",
    "Write the reply body only.",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** One-shot DeepSeek completion (no tools, low temperature, bounded length). */
export async function generateProspectReply(
  env: { DEEPSEEK_API_KEY?: string },
  input: { name?: string; subject?: string; replyText: string; intent: string },
): Promise<string> {
  const key = String(env.DEEPSEEK_API_KEY ?? "").trim();
  if (!key) throw new Error("DEEPSEEK_API_KEY not configured");
  const { system, user } = buildReplyPrompt(input);
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = String(data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("Empty model response");
  return text;
}

const BANNED =
  /\b(guarantee[ds]?|free forever|lifetime (?:free|deal)|unlimited|deepseek|openai|gpt-?\d?|language model|chatbot|ai assistant)\b/i;

/** Gate every draft must pass before it can leave the building. */
export function checkReplyPolicy(text: string): { ok: boolean; reason?: string } {
  const t = String(text ?? "").trim();
  if (t.length < 20) return { ok: false, reason: "too short" };
  if (t.length > 1600) return { ok: false, reason: "too long" };
  if (/[{}]/.test(t)) return { ok: false, reason: "placeholders left" };
  if (BANNED.test(t)) return { ok: false, reason: "banned claim or internal term" };
  if (!t.toLowerCase().includes("zarlino")) return { ok: false, reason: "missing sign-off" };
  return { ok: true };
}
