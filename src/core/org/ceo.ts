/**
 * The CEO agent — the founder's replacement for day-to-day governance.
 *
 * One cycle (runs on every maintenance sweep + on demand):
 *   1. Registers itself as a real runtime instance (org registry, honest §7).
 *   2. Reads the pending approval queue. Decisions that are reversible and
 *      carry no spend / irreversible / legal / credential markers are
 *      APPROVED autonomously (audited as `ceo_agent`, capped per cycle).
 *      Everything else is ESCALATED — batched into ONE WhatsApp message to
 *      the founder per cycle (recorded even when WhatsApp is unconfigured).
 *   3. Compresses the state into a short executive summary on the Workers AI
 *      executive tier (10k neurons/day budget); falls back to a deterministic
 *      digest when the tier is unavailable. No theater: the summary model and
 *      neuron count are recorded with the report.
 *
 * Policy is intentionally conservative: escalate rather than guess. The
 * founder can flip CEO_AUTO_APPROVE=off to make every approval wait for them.
 */
import type { ExecutiveStore } from "../../db/store";
import { newId, nowIso } from "../../ids";
import { executiveGenerate, type AiEnv } from "../../integrations/workersai";
import { escalateToFounder, type NotifyEnv } from "../../integrations/whatsapp";

export interface CeoEnv extends AiEnv, NotifyEnv {
  CEO_AUTO_APPROVE?: string;
}

/** Matters that must never be decided autonomously. */
const ESCALATE_RE =
  /(deploy|payment|purchase|pricing|price|money|spend|budget|refund|delete|destroy|remove|legal|contract|license key|credential|secret|rotate|publish|release|ship|transfer|domain|dns|paystack|bank|terminate|termination)/i;

export interface CeoDecision {
  id: string;
  label: string;
}

export interface CeoCycleResult {
  reportId: string;
  decided: CeoDecision[];
  escalated: CeoDecision[];
  summary: string;
  summaryModel: string;
  neurons: number;
}

export async function runCeoCycle(store: ExecutiveStore, env: CeoEnv, trigger: string): Promise<CeoCycleResult> {
  // 1. The CEO is a real, registered runtime instance.
  store.upsertOrgAgent({
    id: "ceo_agent_01",
    roleId: "role_ceo",
    kind: "agent",
    model: env.EXEC_AI_MODEL || "workers-ai-exec",
    host: "cloudflare-do",
    capabilitiesJson: JSON.stringify(["decide_approvals", "prioritize", "executive_reporting", "escalation"]),
    source: "runtime",
  });

  // 2. Decide the approval queue within policy.
  const autoApprove = (env.CEO_AUTO_APPROVE ?? "on").toLowerCase() !== "off";
  const pending = store.listApprovals({ status: "PENDING", limit: 50 });
  const decided: CeoDecision[] = [];
  const escalated: CeoDecision[] = [];
  for (const a of pending) {
    const label = a.action_label || a.id;
    const haystack = `${label} ${a.reason ?? ""} ${a.max_downside ?? ""}`;
    if (autoApprove && !ESCALATE_RE.test(haystack) && decided.length < 10) {
      store.updateApproval(a.id, {
        status: "APPROVED",
        decided_by: "ceo_agent",
        decision_note: "Auto-approved by the CEO agent: reversible, within policy (no spend/irreversible/legal markers).",
      } as never);
      store.insertAudit({
        id: newId("aud"),
        actor: "ceo_agent",
        action: "approval.approved",
        entity_type: "approval_requests",
        entity_id: a.id,
        detail_json: JSON.stringify({ action_label: label, policy: "ceo_auto" }),
        source: "runtime",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      decided.push({ id: a.id, label });
    } else {
      // One founder nag per item per day: prior cycles may have escalated this
      // same approval already (it stays PENDING until the founder acts).
      const naggedRecently = store
        .auditForEntity("approval_requests", a.id, 10)
        .some(
          (e) =>
            e.action === "ceo.escalated" &&
            Date.now() - Date.parse(e.created_at ?? "") < 24 * 60 * 60 * 1000,
        );
      if (!naggedRecently) {
        store.insertAudit({
          id: newId("aud"),
          actor: "ceo_agent",
          action: "ceo.escalated",
          entity_type: "approval_requests",
          entity_id: a.id,
          detail_json: JSON.stringify({ action_label: label }),
          source: "runtime",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        escalated.push({ id: a.id, label });
      }
    }
  }

  // 3. One founder message per cycle — only when something needs them.
  let escalationStatus = "none";
  if (escalated.length) {
    const lines = escalated.map((e) => `• ${e.label} (approval ${e.id})`).join("\n");
    const r = await escalateToFounder(store, env, {
      subject: `${escalated.length} item${escalated.length === 1 ? "" : "s"} awaiting the founder`,
      body: `${lines}\n\nApprove or reject in the console.`,
      source: "ceo",
      priority: "NORMAL",
    });
    escalationStatus = r.sent
      ? "sent"
      : r.provider === "unconfigured"
        ? "queued (WhatsApp not configured — see /api/notifications)"
        : `failed: ${r.error}`;
  }

  // 4. Compress the state. Executive tier first (Workers AI neurons).
  const state = {
    approvals: { pending: pending.length, decided: decided.length, escalated: escalated.length },
    openTasks: store.listTasks({ limit: 100 }).length,
    openIncidents: store.listOrgIncidents({ status: "OPEN", limit: 50 }).length,
    openContradictions: store.countOpenContradictions(),
    escalation: escalationStatus,
  };
  let summary = `decided=${decided.length} escalated=${escalated.length} pending=${pending.length}`;
  let summaryModel = "none";
  let neurons = 0;
  const ai = await executiveGenerate(
    env,
    store,
    [
      {
        role: "system",
        content:
          "You are the CEO agent of Zarlino Audio. Write a terse executive status paragraph (<= 120 words) from the given facts. No fluff, no emoji, no markdown.",
      },
      { role: "user", content: JSON.stringify(state) },
    ],
    { maxTokens: 300 },
  );
  if (ai && ai.text.trim()) {
    summary = ai.text.trim();
    summaryModel = `workers-ai:${ai.model}`;
    neurons = ai.neurons;
  }

  const reportId = newId("ceo");
  store.insertCeoReport({
    id: reportId,
    trigger,
    decided_json: JSON.stringify(decided),
    escalated_json: JSON.stringify(escalated),
    summary,
    summary_model: summaryModel,
    neurons_used: neurons,
    created_at: nowIso(),
  });
  store.insertAudit({
    id: newId("aud"),
    actor: "ceo_agent",
    action: "ceo.cycle",
    entity_type: "ceo_reports",
    entity_id: reportId,
    detail_json: JSON.stringify({
      trigger,
      decided: decided.length,
      escalated: escalated.length,
      escalation: escalationStatus,
      summaryModel,
      neurons,
    }),
    source: "runtime",
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  return { reportId, decided, escalated, summary, summaryModel, neurons };
}
