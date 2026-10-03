/**
 * Outreach engine (Phase 1 growth) — the "marketing team" logic.
 *
 * The company raises its own money through sales; this module runs the
 * affiliate cold-outreach pipeline: prospects -> one honest pitch -> funnel.
 *
 * Rules that are enforced here, not hoped for:
 *   - kill switch: `settings.outreach_enabled` must be "1" for the automatic
 *     cycle (manual single sends via the API still work when configured);
 *   - hard daily cap (OUTREACH_DAILY_CAP, default 20) across BOTH the manual
 *     and automatic paths, counted from the touch log;
 *   - every send is recorded (outreach_touches) and audited;
 *   - templates are short, honest, and carry an explicit opt-out reply line.
 */

import { newId, nowIso } from "../ids";
import type { ExecutiveStore } from "../db/store";
import { sendEmail, emailConfigured, type EmailEnv } from "../integrations/email";
import { escalateToFounder, type NotifyEnv } from "../integrations/whatsapp";
import { checkReplyPolicy, generateProspectReply } from "../integrations/growth-ai";

export type OutreachEnv = EmailEnv & {
  OUTREACH_DAILY_CAP?: string;
  /** Cap on LLM auto-replies per day (growth agent), separate from OUTREACH_DAILY_CAP. */
  GROWTH_REPLY_DAILY_CAP?: string;
  /** Days a contacted prospect may stay silent before ONE polite follow-up. */
  FOLLOWUP_AFTER_DAYS?: string;
  /** DeepSeek key used by the growth agent to draft replies. */
  DEEPSEEK_API_KEY?: string;
};

export const OUTREACH_STATUSES = [
  "NEW",
  "CONTACTED",
  "REPLIED",
  "APPLIED",
  "APPROVED",
  "REJECTED",
  "UNSUBSCRIBED",
] as const;

export interface OutreachTemplate {
  id: string;
  subject: string;
  body: string;
}

/**
 * Template library (kept honest and short; no AI-trace wording, no hype).
 * Placeholders: {name} = first name, {platform} = pretty platform name.
 */
export const OUTREACH_TEMPLATES: OutreachTemplate[] = [
  {
    id: "affiliate_intro",
    subject: "Free ZTame license + 25% for your audience",
    body: `Hi {name},

I'm with Zarlino Audio, a small plugin studio (Windows VST3). I came across your work on {platform} and the audience you've built is exactly who we make our tools for.

Our flagship is ZTame, a zero-latency resonance suppressor in the same category as Soothe-style tools. I would like to send you a free NFR license - no strings - and if you like it, our affiliate program pays 25% per sale. You keep full editorial control; no scripts, no talking points required.

Details: https://zarlinoaudio.com/affiliates

If you would rather not hear from me again, just reply "no" and I will stop here.

- Zarlino Audio
support@zarlinoaudio.com`,
  },
  {
    id: "follow_up",
    subject: "Re: Free ZTame license + 25% for your audience",
    body: `Hi {name},

Floating this back to the top in case it got buried. Happy to send the free license for you to try - completely your call from there.

If you would rather not hear from me again, just reply "no" and I will stop here.

- Zarlino Audio
support@zarlinoaudio.com`,
  },
];

export interface OutreachVars {
  name?: string;
  platform?: string;
}

/** Merge {placeholders}; unknown placeholders stay visible (never silently empty). */
export function renderTemplate(template: string, vars: OutreachVars): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key];
    return v === undefined || v === null || v === "" ? match : v;
  });
}

export function firstNameOf(name: string): string {
  const clean = name.trim();
  const tokens = clean.split(/\s+/);
  const first = (tokens[0] ?? "").toLowerCase();
  // Organisation-style names read badly when truncated ("Hi The," / "Hi House,"):
  // drop a leading "The", otherwise keep the org's full name for the greeting.
  if (tokens.length > 1 && first === "the") return tokens.slice(1).join(" ");
  if (tokens.length > 1 && first === "house") return clean;
  return tokens[0] || "there";
}

export function prettyPlatform(platform: string): string {
  const p = platform.trim().toLowerCase();
  if (p === "youtube" || p === "yt") return "YouTube";
  if (p === "tiktok") return "TikTok";
  if (p === "instagram" || p === "ig") return "Instagram";
  if (p === "email") return "your site";
  return "your channel";
}

export function outreachDailyCap(envVal: string | undefined): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 20;
}

export function canSendToday(sentToday: number, cap: number): boolean {
  return sentToday < cap;
}

export interface OutreachCycleResult {
  enabled: boolean;
  configured: boolean;
  sent: number;
  failed: number;
  skipped: number;
  queued: number;
  cap: number;
}

/** Send to ONE prospect (manual path). Enforces email validity + daily cap. */
export async function sendOutreachNow(
  store: ExecutiveStore,
  env: OutreachEnv,
  prospectId: string,
  templateId = "affiliate_intro",
): Promise<{ ok: boolean; error?: string }> {
  const p = store.getProspect(prospectId);
  if (!p) return { ok: false, error: "prospect not found" };
  if (!p.email) return { ok: false, error: "prospect has no email" };
  if (p.status === "UNSUBSCRIBED" || p.status === "REJECTED") {
    return { ok: false, error: `prospect is ${p.status.toLowerCase()} — won't contact again` };
  }
  if (!emailConfigured(env)) return { ok: false, error: "email provider not configured" };
  const tpl = OUTREACH_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return { ok: false, error: `unknown template '${templateId}'` };
  const cap = outreachDailyCap(env.OUTREACH_DAILY_CAP);
  const sentToday = store.outreachSentCount(nowIso().slice(0, 10));
  if (!canSendToday(sentToday, cap)) return { ok: false, error: `daily cap reached (${cap} sends/day)` };

  const subject = renderTemplate(tpl.subject, {});
  const body = renderTemplate(tpl.body, { name: firstNameOf(p.name), platform: prettyPlatform(p.platform) });
  const res = await sendEmail(env, { to: p.email, subject, text: body });
  const at = nowIso();
  store.recordOutreachTouch({
    id: newId("ot"),
    prospect_id: p.id,
    template: tpl.id,
    channel: "email",
    status: res.ok ? "SENT" : "FAILED",
    subject,
    error: res.error ?? null,
    sent_at: at,
    created_at: at,
  });
  store.insertAudit({
    id: newId("aud"),
    actor: "outreach",
    action: res.ok ? "outreach.sent" : "outreach.failed",
    entity_type: "prospects",
    entity_id: p.id,
    detail_json: JSON.stringify({ template: tpl.id, channel: "email", error: res.error ?? null }),
    source: "outreach",
    created_at: at,
    updated_at: at,
  });
  if (res.ok) store.updateProspect(p.id, { status: "CONTACTED", last_touch_at: at });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * The automatic cycle: one bounded batch per invocation. Called from the
 * maintenance sweep only when the founder has flipped `outreach_enabled` on.
 */
export async function runOutreachCycle(
  store: ExecutiveStore,
  env: OutreachEnv,
  source: string,
): Promise<OutreachCycleResult> {
  const enabled = store.getSetting("outreach_enabled") === "1";
  const cap = outreachDailyCap(env.OUTREACH_DAILY_CAP);
  const configured = emailConfigured(env);
  const sentToday = store.outreachSentCount(nowIso().slice(0, 10));
  const queued = store.listProspects({ status: "NEW", limit: 500 }).length;
  const result: OutreachCycleResult = { enabled, configured, sent: 0, failed: 0, skipped: 0, queued, cap };
  if (!enabled || !configured) return result;

  const budget = Math.max(0, cap - sentToday);
  if (budget === 0) return result;
  const batch = store.listProspects({ status: "NEW", limit: budget });

  for (const p of batch) {
    if (!p.email) {
      store.updateProspect(p.id, {
        status: "REJECTED",
        notes: `${p.notes ?? ""} [no email on file]`.trim().slice(0, 2000),
      });
      result.skipped++;
      continue;
    }
    const r = await sendOutreachNow(store, env, p.id, "affiliate_intro");
    if (r.ok) result.sent++;
    else result.failed++;
  }

  const at = nowIso();
  store.insertAudit({
    id: newId("aud"),
    actor: "outreach",
    action: "outreach.cycle",
    entity_type: "outreach",
    entity_id: "cycle",
    detail_json: JSON.stringify({ ...result, source }),
    source: "outreach",
    created_at: at,
    updated_at: at,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Reply handling (autonomous): inbound replies arrive via the inbound-mail
// worker -> /api/outreach/reply -> here. Opt-outs are enforced immediately;
// the founder only reads what matters.
// ---------------------------------------------------------------------------

export type ReplyIntent = "OPT_OUT" | "INTERESTED" | "QUESTION" | "OTHER";

/** Deterministic intent classifier (opt-out always wins). */
export function classifyReply(text: string): ReplyIntent {
  const t = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return "OTHER";
  const optOut =
    /\b(unsubscribe|opt[\s-]?out|remove me|stop (?:emailing|contacting|messaging)|don'?t (?:email|contact|message)|not interested|no thanks|no thank you|leave me alone)\b/.test(t) ||
    /^no[.! ]*$/.test(t);
  if (optOut) return "OPT_OUT";
  const interested =
    /\b(yes|sure|interested|sounds good|sign me up|send (?:it|me|the license|the key)|happy to|(?:i'?d|would) love|let'?s do it|count me in)\b/.test(t) ||
    /\b(how (?:do|can|does)|tell me more|more info|what'?s the catch)\b/.test(t);
  if (interested) return "INTERESTED";
  if (t.includes("?")) return "QUESTION";
  return "OTHER";
}

export interface ReplyRecordResult {
  matched: boolean;
  intent: ReplyIntent;
  prospectId?: string;
  status?: string;
  notified: boolean;
}

/**
 * Record an inbound reply. Classifies intent, enforces opt-outs immediately
 * (status UNSUBSCRIBED — never contacted again), otherwise marks REPLIED, and
 * notifies the founder through the existing channel.
 */
export async function recordProspectReply(
  store: ExecutiveStore,
  env: OutreachEnv,
  input: { from: string; subject?: string; body?: string; messageId?: string },
): Promise<ReplyRecordResult> {
  const from = String(input.from ?? "").toLowerCase().trim();
  const subject = input.subject ? String(input.subject).slice(0, 300) : null;
  const bodyText = String(input.body ?? "");
  const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 500) || null;
  const intent = classifyReply(`${subject ?? ""}\n${bodyText}`);
  const at = nowIso();
  const p = from ? store.findProspectByEmail(from) : null;

  store.insertProspectReply({
    id: newId("rply"),
    prospect_id: p ? p.id : null,
    from_email: from || "unknown",
    subject,
    snippet,
    intent,
    message_id: input.messageId ? String(input.messageId).slice(0, 300) : null,
    created_at: at,
  });

  let status: string | undefined;
  if (p) {
    status = intent === "OPT_OUT" ? "UNSUBSCRIBED" : "REPLIED";
    store.updateProspect(p.id, { status, last_touch_at: at });
  }
  store.insertAudit({
    id: newId("aud"),
    actor: "outreach",
    action: "outreach.reply",
    entity_type: "prospects",
    entity_id: p ? p.id : from || "unknown",
    detail_json: JSON.stringify({ intent, matched: Boolean(p), subject }),
    source: "email",
    created_at: at,
    updated_at: at,
  });

  let notified = false;
  try {
    const who = p ? p.name : from || "unknown sender";
    const headline =
      intent === "OPT_OUT" ? `Opt-out: ${who}` : intent === "INTERESTED" ? `Interested: ${who}` : `Reply (${intent}): ${who}`;
    await escalateToFounder(store, env as unknown as NotifyEnv, {
      subject: headline,
      body: `Reply from ${who} (${from}).\nIntent: ${intent}\nSubject: ${subject ?? "-"}\n\n${snippet ?? "(no text extracted)"}`,
      source: "outreach",
    });
    notified = true;
  } catch {
    /* notification best-effort; the reply row is the durable record */
  }

  return { matched: Boolean(p), intent, prospectId: p ? p.id : undefined, status, notified };
}

// ---------------------------------------------------------------------------
// Autonomous nurturing: LLM-drafted replies + scheduled follow-ups.
// The founder reads what matters; the agent handles the rest.
// ---------------------------------------------------------------------------

/** Cap for auto-replies per day (default 10); separate from the outreach cap. */
export function growthReplyCap(envVal: string | undefined): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 10;
}

/** Days before a silent contacted prospect gets one follow-up (default 5, max 30). */
export function followUpAfterDays(envVal: string | undefined): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 30) : 5;
}

export interface AutoReplyResult {
  sent: boolean;
  reason?: string;
}

export interface AutoReplyDeps {
  generate?: (
    env: OutreachEnv,
    input: { name?: string; subject?: string; replyText: string; intent: string },
  ) => Promise<string>;
  send?: typeof sendEmail;
}

const AUTO_RESPONDER = /out of office|automatic reply|auto-?reply|abwesenheit|vacation responder/i;

/**
 * Draft + send an autonomous reply to a prospect who wrote back.
 * Skips opt-outs, self mail, auto-responders, capped days and already-replied
 * threads; on generation failure or policy violation it ESCALATES instead.
 */
export async function maybeAutoReply(
  store: ExecutiveStore,
  env: OutreachEnv,
  input: { from: string; subject?: string; body?: string; intent: ReplyIntent; prospectId?: string },
  deps: AutoReplyDeps = {},
): Promise<AutoReplyResult> {
  if (store.getSetting("growth_auto_reply_enabled") === "0") return { sent: false, reason: "auto-reply disabled" };
  if (input.intent === "OPT_OUT") return { sent: false, reason: "opt-out: no reply" };
  if (!input.prospectId) return { sent: false, reason: "unknown sender" };
  const p = store.getProspect(input.prospectId);
  if (!p || !p.email) return { sent: false, reason: "prospect missing email" };
  if (p.email.toLowerCase() === String(env.EMAIL_FROM ?? "").toLowerCase()) return { sent: false, reason: "self" };
  if (AUTO_RESPONDER.test(String(input.subject ?? ""))) return { sent: false, reason: "auto-responder" };
  if (store.countTouchesByTemplate(p.id, "auto_reply") > 0) return { sent: false, reason: "already replied" };
  const cap = growthReplyCap(env.GROWTH_REPLY_DAILY_CAP);
  if (store.countTouchesByTemplateToday("auto_reply", nowIso().slice(0, 10)) >= cap) {
    return { sent: false, reason: `daily reply cap (${cap})` };
  }

  const generate = deps.generate ?? generateProspectReply;
  let draft = "";
  try {
    draft = await generate(env, {
      name: p.name,
      subject: input.subject,
      replyText: String(input.body ?? ""),
      intent: input.intent,
    });
  } catch (e) {
    await escalateToFounder(store, env as unknown as NotifyEnv, {
      subject: `Reply needs you (draft failed): ${p.name}`,
      body: `${input.from}: ${input.body ?? ""}`,
      source: "outreach",
    });
    return { sent: false, reason: `generation failed: ${String(e).slice(0, 120)}` };
  }

  const policy = checkReplyPolicy(draft);
  if (!policy.ok) {
    await escalateToFounder(store, env as unknown as NotifyEnv, {
      subject: `Reply needs you (policy: ${policy.reason}): ${p.name}`,
      body: `${input.from}: ${input.body ?? ""}`,
      source: "outreach",
    });
    return { sent: false, reason: `policy: ${policy.reason}` };
  }

  const rawSubject = String(input.subject ?? "your message");
  const subject = (/^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`).slice(0, 180);
  const send = deps.send ?? sendEmail;
  const res = await send(env, { to: p.email, subject, text: draft });
  const at = nowIso();
  store.recordOutreachTouch({
    id: newId("ot"),
    prospect_id: p.id,
    template: "auto_reply",
    channel: "email",
    status: res.ok ? "SENT" : "FAILED",
    subject,
    error: res.error ?? null,
    sent_at: at,
    created_at: at,
  });
  store.insertAudit({
    id: newId("aud"),
    actor: "growth-agent",
    action: res.ok ? "outreach.auto_replied" : "outreach.auto_reply_failed",
    entity_type: "prospects",
    entity_id: p.id,
    detail_json: JSON.stringify({ intent: input.intent, error: res.error ?? null }),
    source: "outreach",
    created_at: at,
    updated_at: at,
  });
  if (res.ok) store.updateProspect(p.id, { last_touch_at: at });
  return res.ok ? { sent: true } : { sent: false, reason: res.error ?? "send failed" };
}

export interface FollowUpResult {
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * One polite follow-up for prospects who were contacted, never replied, and
 * never got a follow-up — bounded by the shared daily cap.
 */
export async function runFollowUps(store: ExecutiveStore, env: OutreachEnv, now = nowIso()): Promise<FollowUpResult> {
  const result: FollowUpResult = { sent: 0, failed: 0, skipped: 0 };
  if (store.getSetting("outreach_enabled") !== "1") return result;
  if (!emailConfigured(env)) return result;
  const days = followUpAfterDays(env.FOLLOWUP_AFTER_DAYS);
  const cutoffMs = Date.parse(now) - days * 24 * 60 * 60 * 1000;
  let budget = Math.max(0, outreachDailyCap(env.OUTREACH_DAILY_CAP) - store.outreachSentCount(now.slice(0, 10)));
  if (budget === 0) return result;
  const candidates = store.listProspects({ status: "CONTACTED", limit: 500 });
  for (const p of candidates) {
    if (budget === 0) break;
    if (!p.email || !p.last_touch_at) {
      result.skipped++;
      continue;
    }
    if (Date.parse(p.last_touch_at) > cutoffMs) {
      result.skipped++;
      continue;
    }
    if (store.countTouchesByTemplate(p.id, "follow_up") > 0) {
      result.skipped++;
      continue;
    }
    const r = await sendOutreachNow(store, env, p.id, "follow_up");
    if (r.ok) {
      result.sent++;
      budget--;
    } else {
      result.failed++;
    }
  }
  return result;
}
