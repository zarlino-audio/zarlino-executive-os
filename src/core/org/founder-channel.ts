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
import { executiveGenerate, type AiEnv } from "../../integrations/workersai";

/** The founder's personal number — the ONLY number treated as the founder. */
export const FOUNDER_WHATSAPP_DEFAULT = "+233546778438";

export interface FounderChannelEnv extends AiEnv {
  WHATSAPP_FOUNDER_NUMBER?: string;
}

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
export function strangerReply(): string {
  return (
    "Hello! This is the Zarlino Audio assistant. This line is monitored automatically " +
    "and is not the founder's personal line. For anything about our plugins — support, " +
    "licensing, downloads — please visit https://zarlinoaudio.com and the right person " +
    "will pick it up. Your message has been logged. Thank you!"
  );
}

function safeCounts(raw: string | undefined): { ok?: number; warn?: number; fail?: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { ok?: number; warn?: number; fail?: number };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export interface FounderContext {
  pendingApprovals: string[];
  openTasks: number;
  ceoSummary: string | null;
  doctor: { ok?: number; warn?: number; fail?: number } | null;
}

export function buildFounderContext(store: ExecutiveStore): FounderContext {
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

function deterministicFounderReply(ctx: FounderContext): string {
  const parts: string[] = [];
  parts.push(`Received. ${ctx.pendingApprovals.length} pending approval(s), ${ctx.openTasks} open task(s).`);
  if (ctx.pendingApprovals.length) {
    parts.push(`Awaiting you: ${ctx.pendingApprovals.slice(0, 3).join(" | ")}.`);
  }
  if (ctx.doctor) {
    parts.push(`Doctor: ${ctx.doctor.ok ?? "?"} OK / ${ctx.doctor.warn ?? "?"} WARN / ${ctx.doctor.fail ?? "?"} FAIL.`);
  }
  if (ctx.ceoSummary) {
    parts.push(`CEO: ${ctx.ceoSummary.slice(0, 220)}`);
  }
  return parts.join(" ");
}

async function founderReply(
  store: ExecutiveStore,
  env: FounderChannelEnv,
  text: string,
): Promise<string> {
  const ctx = buildFounderContext(store);
  const ai = await executiveGenerate(
    env,
    store,
    [
      {
        role: "system",
        content:
          "You are the Zarlino Audio Executive OS answering the FOUNDER over WhatsApp. " +
          "Be concise (max 4 short lines), factual, no fluff, no markdown tables. " +
          "Use ONLY the provided state context — never invent numbers. If the founder asks for " +
          "an action, say it will be handled by the CEO agent and logged. " +
          "State context: " +
          JSON.stringify({
            pending_approvals: ctx.pendingApprovals,
            open_tasks: ctx.openTasks,
            doctor: ctx.doctor,
            ceo_last_summary: ctx.ceoSummary?.slice(0, 400) ?? null,
          }),
      },
      { role: "user", content: text.slice(0, 1500) },
    ],
    { maxTokens: 320 },
  );
  if (ai && ai.text.trim()) return ai.text.trim().slice(0, 900);
  return deterministicFounderReply(ctx);
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
  try {
    reply = role === "FOUNDER" ? await founderReply(store, env, text) : strangerReply();
  } catch {
    reply = role === "FOUNDER" ? deterministicFounderReply(buildFounderContext(store)) : strangerReply();
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
