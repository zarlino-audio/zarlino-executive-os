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

export type OutreachEnv = EmailEnv & { OUTREACH_DAILY_CAP?: string };

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
