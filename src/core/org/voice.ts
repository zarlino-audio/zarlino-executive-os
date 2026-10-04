/**
 * The founder's WhatsApp voice — how the OS talks to the one human it serves.
 *
 * Two hard rules, learned from the first live link (2026-10-01):
 *
 *   1. NO SPAM. Escalations are COALESCED into a single message (duplicate
 *      items collapse to one line) and a quiet gap (`WHATSAPP_MIN_GAP_MINUTES`,
 *      default 240) limits how often a message can go out at all. The 8-item
 *      backlog that flooded the founder the first time is now one message.
 *
 *   2. NO MACHINE TRACES. Nothing says "system", "agent", "automated",
 *      "decision(s)", "[Zarlino OS | ...]" — it reads like a colleague
 *      texting their boss. The Workers AI executive tier writes it when
 *      available (with strict voice rules); the deterministic fallback below
 *      is written to pass the same voice check.
 *
 * Strangers NEVER see any of this: they get one public canned reply and
 * nothing else.
 */
import type { ExecutiveStore } from "../../db/store";
import { chargeNeurons, executiveGenerate, neuronLedger, type AiEnv } from "../../integrations/workersai";

/** Which engine produced the founder's last message (observability). */
export const LAST_ENGINE_SETTING = "voice_last_engine";
/** First failure text from the CAO tier, kept so we can explain a downgrade. */
export const CAO_ERROR_SETTING = "voice_cao_error";
/** When the CAO tier last refused (ISO), used to back off retries. */
export const CAO_BLOCKED_SETTING = "voice_cao_blocked_at";
/** Minutes to skip re-probing a refusing CAO model before trying it again. */
export const CAO_RETRY_MINUTES = 30;

export interface VoiceEnv extends AiEnv {
  WHATSAPP_MIN_GAP_MINUTES?: string;
  WHATSAPP_FOUNDER_NUMBER?: string;
  WHATSAPP_FOUNDER_LIDS?: string;
}

/** settings key holding the last successful founder delivery (ISO time). */
export const LAST_SENT_SETTING = "whatsapp_last_sent_at";
export const DEFAULT_GAP_MINUTES = 240;

export interface QueuedNotificationRow {
  id: string;
  subject?: string;
  body: string;
  source: string;
  created_at: string;
}

// ---- quiet gap --------------------------------------------------------------

export function founderGapMs(env: VoiceEnv): number {
  const n = Number(env.WHATSAPP_MIN_GAP_MINUTES);
  const minutes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_GAP_MINUTES;
  return minutes * 60_000;
}

/** Is the founder channel still inside the quiet gap after the last message? */
export function cooldown(
  store: ExecutiveStore,
  env: VoiceEnv,
  now = Date.now(),
): { held: boolean; holdUntil?: string; lastSentAt?: string } {
  const last = store.getSetting(LAST_SENT_SETTING);
  if (!last) return { held: false };
  const t = Date.parse(last);
  if (Number.isNaN(t)) return { held: false };
  const until = t + founderGapMs(env);
  if (now < until) return { held: true, holdUntil: new Date(until).toISOString(), lastSentAt: last };
  return { held: false, lastSentAt: last };
}

export function markFounderMessageSent(store: ExecutiveStore, at = new Date().toISOString()): void {
  try {
    store.setSetting(LAST_SENT_SETTING, at);
  } catch {
    /* never blocks a delivery */
  }
}

// ---- item extraction --------------------------------------------------------

const FOOTER_LINE = /^(approve or reject|you can approve|whenever you|all in the console|it'?s waiting)/i;

function cleanItem(line: string): string {
  return line
    .replace(/^[•\-*]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\s*\(approval\s+[^)]+\)\s*$/i, "")
    .trim();
}

/**
 * Collapse queued notifications into human bullet items: one line per real
 * item, duplicates merged, machine-ish subjects ("N decision(s)…") never
 * surface.
 */
export function extractEscalationItems(rows: QueuedNotificationRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    let found = 0;
    for (const raw of (r.body ?? "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || FOOTER_LINE.test(line)) continue;
      const item = cleanItem(line);
      if (!item || item.length < 3) continue;
      out.push(item);
      found += 1;
    }
    const subject = (r.subject ?? "").trim();
    if (!found && subject && !/decision\(s\)|need(?:s|ed)? the founder|awaiting/i.test(subject)) {
      out.push(subject);
    }
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of out) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, 8);
}

// ---- founder-facing composition --------------------------------------------

/** Deterministic fallback that passes the same "human colleague" voice check. */
export function naturalDigestFallback(items: string[]): string {
  if (items.length === 1) {
    return `Hey! One thing needs your eyes when you get a sec:\n\n• ${items[0]}\n\nIt's waiting in the console — no rush.`;
  }
  const lines = items.map((i) => `• ${i}`).join("\n");
  return `Hey! A few things have stacked up for you:\n\n${lines}\n\nAll in the console when you have a moment.`;
}

const DIGEST_SYSTEM =
  "You write ONE short WhatsApp message from Zarlino Audio's operations desk to the founder, " +
  "a busy engineer. Voice rules, all mandatory: sound like a human colleague texting — casual, " +
  "warm, direct; NEVER mention AI, bots, models, systems, agents, automation or monitoring; " +
  "NEVER use corporate filler (leverage, kindly, utilize, please note, decision(s), 'this is an automated'); " +
  "max 4 short lines; list ONLY the items given, EXACTLY as written, one per line starting with '•' — " +
  "never add, merge or invent items; never include numbers that are not in the list; " +
  "end with a light pointer to the console. Output the message text only — no quotes, no labels.";

export interface FounderDigest {
  text: string;
  ids: string[];
  items: string[];
  model: string | null;
}

/** One message for however many escalations — AI voice or the fallback. */
export async function composeFounderDigest(
  store: ExecutiveStore,
  env: VoiceEnv,
  rows: QueuedNotificationRow[],
): Promise<FounderDigest> {
  const ids = rows.map((r) => r.id);
  const items = extractEscalationItems(rows);
  const fallback = naturalDigestFallback(
    items.length ? items : ["A couple of small things are waiting for you"],
  );
  try {
    const ai = await executiveGenerate(
      env,
      store,
      [
        { role: "system", content: DIGEST_SYSTEM },
        { role: "user", content: JSON.stringify({ items }) },
      ],
      { maxTokens: 240, class: "founder" },
    );
    const text = ai?.text?.trim();
    if (text) {
      return { text: markEngine(store, `exec:${ai?.model ?? "unknown"}`, text.slice(0, 900)), ids, items, model: ai?.model ?? null };
    }
  } catch {
    /* fall through to the deterministic voice */
  }
  return { text: fallback, ids, items, model: null };
}

// ---- quick replies ----------------------------------------------------------

const REPLY_SYSTEM =
  "You are Zarlino Audio's Chief Administrative Officer (CAO) - replying to THE FOUNDER over WhatsApp. " +
  "You own the task board: what is in flight, what is blocked, what needs a decision. " +
  "Sound like a sharp human chief of staff: casual, short (1-3 lines max), contractions fine, NO bullet lists, " +
  "NO status dumps, NO jargon. Never mention AI, automation, monitoring, systems or agents; never say " +
  "'as an assistant'; never speak about the founder in the third person. " +
  "HARD RULE: only state facts that appear in the provided state - never invent numbers, files, events " +
  "or plans (if you don't know, say you'll check and get back). If they ask for status, give the single " +
  "most important item in one calm sentence. If the message is just a greeting or test, reply with one " +
  "short friendly line and stop. Output the reply text only.";

/**
 * The CAO tier: DeepSeek V4 Pro - the strongest model in the Workers AI
 * catalog (1M context, reasoning none/low/high/max) - answers the founder.
 *
 * Measured on this account (2026-10, /api/ai/cao-probe): the model answers in
 * ~1.2-1.9s. It is a REASONING model, so the first attempt with a 16-token
 * budget came back with empty content - the reasoning pass had eaten the whole
 * allowance. Reply calls therefore run with reasoning_effort "none" and a
 * generous token budget: short, factual WhatsApp answers do not need a hidden
 * reasoning pass, and the reasoning tokens are billed as output.
 *
 * If the deployment ever refuses the model (plan change, model retirement),
 * the refusal is recorded, the tier is skipped for CAO_RETRY_MINUTES, and the
 * executive tier answers instead - the channel never goes dark.
 */
async function caoGenerate(
  env: VoiceEnv,
  store: ExecutiveStore,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens: number,
): Promise<{ text: string; model: string } | null> {
  const anyEnv = env as unknown as {
    AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
    CAO_AI_MODEL?: string;
  };
  if (!anyEnv.AI) return null;
  const model = anyEnv.CAO_AI_MODEL || "@cf/deepseek-ai/deepseek-v4-pro-0813";

  // A refusing tier is skipped for a while, not retried on every message.
  try {
    const blockedAt = store.getSetting(CAO_BLOCKED_SETTING);
    if (blockedAt) {
      const age = Date.now() - Date.parse(blockedAt);
      if (Number.isFinite(age) && age < CAO_RETRY_MINUTES * 60_000) return null;
    }
  } catch {
    /* settings miss is not fatal */
  }

  const inputs = messages.reduce((n, m) => n + m.content.length, 0);
  const ask = async (input: Record<string, unknown>) => {
    const out = (await anyEnv.AI!.run(model, input)) as {
      response?: string;
      choices?: Array<{ message?: { content?: string } }>;
      result?: { response?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = out?.choices?.[0]?.message?.content ?? out?.response ?? out?.result?.response;
    return { text: typeof text === "string" ? text.trim() : "", usage: out?.usage };
  };

  try {
    let result = await ask({
      messages,
      reasoning_effort: "none",
      max_completion_tokens: Math.max(maxTokens, 400),
      temperature: 0.25,
    });
    // Empty content means the token budget was consumed before any answer
    // (reasoning pass, or a truncated completion). Retry once with room.
    if (!result.text) {
      result = await ask({ messages, max_completion_tokens: 900, temperature: 0.25 });
    }
    if (!result.text) {
      recordCaoFailure(store, "empty response");
      return null;
    }
    try {
      store.setSetting(CAO_ERROR_SETTING, "");
      store.setSetting(CAO_BLOCKED_SETTING, "");
      chargeNeurons(
        store,
        model,
        result.usage?.prompt_tokens ?? Math.ceil(inputs / 4),
        result.usage?.completion_tokens ?? Math.ceil(result.text.length / 4),
      );
    } catch {
      /* accounting must never break a reply */
    }
    return { text: result.text.slice(0, 700), model };
  } catch (err) {
    // Model unavailable on this plan, budget refused, transient failure:
    // remember why, then fall back rather than leave the founder hanging.
    recordCaoFailure(store, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function recordCaoFailure(store: ExecutiveStore, message: string): void {
  try {
    store.setSetting(CAO_ERROR_SETTING, message.slice(0, 300));
    store.setSetting(CAO_BLOCKED_SETTING, new Date().toISOString());
  } catch {
    /* never fatal */
  }
}

export interface FounderStateContext {
  pendingApprovals: string[];
  openTasks: number;
  ceoSummary: string | null;
  doctor: { ok?: number; warn?: number; fail?: number } | null;
}

export function naturalReplyFallback(ctx: FounderStateContext): string {
  const first = ctx.pendingApprovals[0];
  if (first) {
    const more = ctx.pendingApprovals.length > 1 ? ` (+${ctx.pendingApprovals.length - 1} more)` : "";
    return `Hey — just "${first}"${more} still waiting on you. Everything else is ticking along fine.`;
  }
  if (ctx.openTasks > 0) {
    return `Hey! Nothing needs you right now — ${ctx.openTasks} thing${ctx.openTasks === 1 ? "" : "s"} in flight and all fine.`;
  }
  return "Hey! All quiet here — nothing needs you at the moment.";
}

export async function naturalFounderReply(
  store: ExecutiveStore,
  env: VoiceEnv,
  text: string,
  ctx: FounderStateContext,
): Promise<string> {
  try {
    const prompts = [
      {
        role: "system" as const,
        content:
          REPLY_SYSTEM +
          " Current state (only if relevant): " +
          JSON.stringify({
            pending_approvals: ctx.pendingApprovals,
            open_tasks: ctx.openTasks,
            doctor: ctx.doctor,
            latest_note: ctx.ceoSummary?.slice(0, 300) ?? null,
          }),
      },
      { role: "user" as const, content: text.slice(0, 1500) },
    ];
    // CAO tier first (strongest model), executive tier as the fallback.
    const cao = await caoGenerate(env, store, prompts, 200);
    if (cao) return markEngine(store, `cao:${cao.model}`, cao.text);
    const ai = await executiveGenerate(
      env,
      store,
      prompts,
      { maxTokens: 200, temperature: 0.25, class: "founder" },
    );
    const reply = ai?.text?.trim();
    if (reply) return markEngine(store, `exec:${ai?.model ?? "unknown"}`, reply.slice(0, 700));
  } catch {
    /* fall through */
  }
  return markEngine(store, "fallback:canned", naturalReplyFallback(ctx));
}

/** Record which engine answered so a downgrade is visible, never guessed. */
function markEngine(store: ExecutiveStore, engine: string, text: string): string {
  try {
    store.setSetting(LAST_ENGINE_SETTING, engine);
  } catch {
    /* never blocks a reply */
  }
  return text;
}

/** 
 * Status of the founder channel: who answered last, why the CAO tier is down
 * (if it is), and how much allowance is left. Read by the console + doctor so
 * "is the founder getting the smart model?" is a fact, not a hope.
 */
export function voiceStatus(
  store: ExecutiveStore,
  env: VoiceEnv,
): {
  lastEngine: string | null;
  caoError: string | null;
  caoBlockedAt: string | null;
  caoRetrying: boolean;
  ledger: { budget: number; reserve: number; used: number; left: number; backgroundLeft: number };
} {
  let caoError: string | null = null;
  let caoBlockedAt: string | null = null;
  let lastEngine: string | null = null;
  try {
    caoError = store.getSetting(CAO_ERROR_SETTING) || null;
    caoBlockedAt = store.getSetting(CAO_BLOCKED_SETTING) || null;
    lastEngine = store.getSetting(LAST_ENGINE_SETTING) || null;
  } catch {
    /* fresh store */
  }
  const age = caoBlockedAt ? Date.now() - Date.parse(caoBlockedAt) : Number.POSITIVE_INFINITY;
  return {
    lastEngine,
    caoError,
    caoBlockedAt,
    caoRetrying: age >= CAO_RETRY_MINUTES * 60_000,
    ledger: neuronLedger(store, env),
  };
}

/** Strangers get exactly this — warm, public, zero internal information. */
export function strangerReply(): string {
  return (
    "Hi! Thanks for reaching out — this is Zarlino Audio. For anything to do with our plugins " +
    "(support, licensing, downloads), everything lives at zarlinoaudio.com. Cheers!"
  );
}
