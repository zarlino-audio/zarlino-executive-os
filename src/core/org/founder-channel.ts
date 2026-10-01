/**
 * The founder WhatsApp channel — inbound half of the linked-device bridge.
 *
 * One business number receives everything; the OS decides WHO is talking:
 *
 *   - The founder's own number (WHATSAPP_FOUNDER_NUMBER, default
 *     +233546778438) is the FOUNDER channel: replies are composed on the
 *     Workers AI executive tier with a compact state context (pending
 *     approvals, open tasks, last CEO report, doctor counts). Deterministic
 *     digest fallback when the tier is unavailable.
 *
 *   - EVERY other number is a STRANGER: they get a polite canned reply with
 *     no internal information whatsoever — never founder treatment, never
 *     privileged status, never AI context about the business. Their message
 *     is logged for review.
 *
 * Message ids are deduped (unique index) so a provider redelivery can never
 * trigger a duplicate reply. Nothing here throws: the bridge gets an honest
 * result even when AI or storage degrade.
 */
import type { ExecutiveStore } from "../../db/store";
import { newId, nowIso } from "../../ids";
import {
  naturalFounderReply,
  naturalReplyFallback,
  strangerReply,
  type FounderStateContext,
  type VoiceEnv,
} from "./voice";

/** The founder's personal number — the ONLY number treated as the founder. */
export const FOUNDER_WHATSAPP_DEFAULT = "+233546778438";

export type FounderChannelEnv = VoiceEnv;

export { strangerReply };

/** Digits only, so +233 54 677 8438, 233546778438 and 0546778438 all normalize. */
export function normalizePhone(raw: string): string {
  return (raw || "").replace(/[^\d]/g, "");
}

/** The configured founder number, digits only. */
export function founderDigits(env: FounderChannelEnv): string {
  return normalizePhone(env.WHATSAPP_FOUNDER_NUMBER || FOUNDER_WHATSAPP_DEFAULT);
}

/**
 * Same-person check with national-format tolerance: exact digit match, or
 * the last 9 digits match (covers +233 / 0-prefixed local forms). Anything
 * else is NOT the founder — fail closed.
 */
export function isFounderNumber(env: FounderChannelEnv, raw: string): boolean {
  const a = normalizePhone(raw);
  const b = founderDigits(env);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9);
}

export interface InboundWhatsAppInput {
  from: string;
  name?: string;
  text: string;
  messageId?: string;
}

export interface InboundWhatsAppResult {
  role: "FOUNDER" | "STRANGER";
  reply: string;
  messageRowId: string | null;
  duplicate: boolean;
}

/** A stranger gets exactly this — polite, public, zero internal context. */
// (strangerReply now lives in ./voice, re-exported above.)

function safeCounts(raw: string | undefined): { ok?: number; warn?: number; fail?: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { ok?: number; warn?: number; fail?: number };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export type FounderContext = FounderStateContext;

export function buildFounderContext(store: ExecutiveStore): FounderStateContext {
  const pending = store
    .listApprovals({ status: "PENDING", limit: 5 })
    .map((a) => a.action_label || a.id);
  const openTasks = store
    .listTasks({ limit: 500 })
    .filter((t) => t.status !== "DONE" && t.status !== "CANCELLED").length;
  const report = store.listCeoReports(1)[0];
  const doctor = store.latestDoctorLog();
  return {
    pendingApprovals: pending,
    openTasks,
    ceoSummary: report?.summary ?? null,
    doctor: safeCounts(doctor?.summary_json),
  };
}

async function founderReply(
  store: ExecutiveStore,
  env: FounderChannelEnv,
  text: string,
): Promise<string> {
  return naturalFounderReply(store, env, text, buildFounderContext(store));
}

/** settings key holding the approvals referenced by the last delivered digest. */
export const DIGEST_APPROVALS_SETTING = "whatsapp:pending_digest_approvals";

const BARE_YES = /^(approve[d]?|ok(ay)?|yes|yeah|yep|sure|fine|go ahead|do it|lgtm|all good|green light|ship it)[.!,]*$/i;
const BARE_NO = /^(reject(ed)?|decline[d]?|no|nope|nah)[.!,]*$/i;
const HAS_WORD_YES = /\b(approve|approved|go ahead)\b/i;
const HAS_WORD_NO = /\b(reject|rejected|decline|declined)\b/i;

export interface DecisionOutcome {
  intent: "APPROVED" | "REJECTED" | null;
  labels: string[];
}

/**
 * A founder reply can ACT: "approve", "ok", "yes", "go ahead" decides the
 * pending item(s) from the last delivered digest; "reject", "no", "decline"
 * rejects them. Anything else is just conversation. 48h freshness window;
 * only PENDING items move; every action is audited (actor founder, source
 * whatsapp), so "was it acted on?" always has an answer.
 */
export function applyDecisionIntent(store: ExecutiveStore, text: string): DecisionOutcome {
  const t = (text || "").trim();
  if (!t) return { intent: null, labels: [] };
  let intent: "APPROVED" | "REJECTED" | null = null;
  if (BARE_YES.test(t) || (t.length <= 60 && HAS_WORD_YES.test(t))) intent = "APPROVED";
  else if (BARE_NO.test(t) || (t.length <= 60 && HAS_WORD_NO.test(t))) intent = "REJECTED";
  if (!intent) return { intent: null, labels: [] };

  const raw = store.getSetting(DIGEST_APPROVALS_SETTING);
  if (!raw) return { intent, labels: [] };
  let parsed: { ids?: string[]; at?: string } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { intent, labels: [] };
  }
  const at = parsed.at ? Date.parse(parsed.at) : 0;
  if (!at || Date.now() - at > 48 * 3600_000) return { intent, labels: [] };

  const labels: string[] = [];
  for (const id of (parsed.ids ?? []).slice(0, 5)) {
    const a = store.getApproval(id);
    if (!a || a.status !== "PENDING") continue;
    store.updateApproval(id, {
      status: intent,
      decided_by: "founder",
      decision_note: "Decided via WhatsApp reply",
      decided_at: nowIso(),
    } as never);
    store.insertAudit({
      id: newId("aud"),
      actor: "founder",
      action: `approval.${intent.toLowerCase()}`,
      entity_type: "approval_requests",
      entity_id: id,
      detail_json: JSON.stringify({ action_label: a.action_label ?? id, via: "whatsapp" }),
      source: "whatsapp",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    labels.push(a.action_label || id);
  }
  return { intent, labels };
}

function decisionConfirmation(intent: "APPROVED" | "REJECTED", labels: string[]): string {
  const verb = intent === "APPROVED" ? "approved" : "rejected";
  const list = labels.map((l) => `\"${l.slice(0, 70)}\"`).join(", ");
  return `Done — ${verb} ${list}. I'll take it from here.`;
}

/**
 * Handle one inbound WhatsApp message. Returns the role it was classified as
 * and the reply the bridge should send back. `duplicate: true` means the
 * message id was already processed — the bridge must NOT resend a reply.
 */
export async function handleInboundWhatsApp(
  store: ExecutiveStore,
  env: FounderChannelEnv,
  input: InboundWhatsAppInput,
): Promise<InboundWhatsAppResult> {
  const from = normalizePhone(input.from);
  const role: "FOUNDER" | "STRANGER" = isFounderNumber(env, from) ? "FOUNDER" : "STRANGER";

  if (input.messageId) {
    const seen = store.findWhatsAppMessage(input.messageId);
    if (seen) return { role, reply: "", messageRowId: seen.id, duplicate: true };
  }

  const text = (input.text || "").trim().slice(0, 4000);
  let reply: string;
  if (role === "FOUNDER") {
    const outcome = applyDecisionIntent(store, text);
    if (outcome.intent && outcome.labels.length) {
      reply = decisionConfirmation(outcome.intent, outcome.labels);
    } else {
      try {
        reply = await founderReply(store, env, text);
      } catch {
        reply = naturalReplyFallback(buildFounderContext(store));
      }
    }
  } else {
    reply = strangerReply();
  }

  const id = newId("wam");
  const at = nowIso();
  try {
    store.insertWhatsAppMessage({
      id,
      direction: "IN",
      wa_from: from,
      wa_name: input.name ?? null,
      role,
      body: text,
      reply,
      message_id: input.messageId ?? null,
      status: "REPLIED",
      source: "bridge",
      created_at: at,
      updated_at: at,
    });
  } catch {
    // Duplicate id raced us — return the reply without a second row.
    return { role, reply, messageRowId: null, duplicate: true };
  }

  store.insertAudit({
    id: newId("aud"),
    actor: role === "FOUNDER" ? "founder" : "whatsapp_stranger",
    action: role === "FOUNDER" ? "whatsapp.inbound_founder" : "whatsapp.inbound_stranger",
    entity_type: "whatsapp_messages",
    entity_id: id,
    detail_json: JSON.stringify({ from, chars: text.length, name: input.name ?? null }),
    source: "runtime",
    created_at: at,
    updated_at: at,
  });

  return { role, reply, messageRowId: id, duplicate: false };
}
