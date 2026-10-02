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
import { executiveGenerate, type AiEnv } from "../../integrations/workersai";

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
      { maxTokens: 240 },
    );
    const text = ai?.text?.trim();
    if (text) return { text: text.slice(0, 900), ids, items, model: ai?.model ?? null };
  } catch {
    /* fall through to the deterministic voice */
  }
  return { text: fallback, ids, items, model: null };
}

// ---- quick replies ----------------------------------------------------------

const REPLY_SYSTEM =
  "You are Zarlino Audio's right hand, replying to THE FOUNDER — the person you are speaking to — over WhatsApp. " +
  "Sound like a sharp human assistant: casual, short (1–3 lines max), contractions fine, NO bullet lists, " +
  "NO status dumps, NO jargon. Never mention AI, automation, monitoring, systems or agents; never say " +
  "'as an assistant'; never speak about the founder in the third person. " +
  "HARD RULE: only state facts that appear in the provided state — never invent numbers, files, events " +
  "or plans (if you don't know, say you'll check and get back). If they ask for status, give the single " +
  "most important item in one calm sentence. If the message is just a greeting or test, reply with one " +
  "short friendly line and stop. Output the reply text only.";

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
    const ai = await executiveGenerate(
      env,
      store,
      [
        {
          role: "system",
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
        { role: "user", content: text.slice(0, 1500) },
      ],
      { maxTokens: 200, temperature: 0.25 },
    );
    const reply = ai?.text?.trim();
    if (reply) return reply.slice(0, 700);
  } catch {
    /* fall through */
  }
  return naturalReplyFallback(ctx);
}

/** Strangers get exactly this — warm, public, zero internal information. */
export function strangerReply(): string {
  return (
    "Hi! Thanks for reaching out — this is Zarlino Audio. For anything to do with our plugins " +
    "(support, licensing, downloads), everything lives at zarlinoaudio.com. Cheers!"
  );
}
