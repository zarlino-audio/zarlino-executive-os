/**
 * Approval queue — factory for creating Founder approval requests.
 * The Executive creates these for HIGH-risk / irreversible actions; the
 * Founder approves or rejects them from the web console or via API.
 */
import type { ApprovalRequest } from "../../types";
import { newId, nowIso } from "../../ids";

export interface CreateApprovalInput {
  action_label: string;
  reason: string;
  decision_id?: string;
  expected_upside?: string;
  max_downside?: string;
  budget_available?: string;
  recommendation?: string;
  requested_by?: string;
  source?: string;
}

export function createApprovalRequest(input: CreateApprovalInput): ApprovalRequest {
  const now = nowIso();
  return {
    id: newId("appr"),
    decision_id: input.decision_id,
    action_label: input.action_label.trim(),
    reason: input.reason.trim(),
    expected_upside: input.expected_upside,
    max_downside: input.max_downside,
    budget_available: input.budget_available,
    recommendation: input.recommendation ?? "APPROVE",
    status: "PENDING",
    requested_by: input.requested_by ?? "executive",
    source: input.source ?? "executive",
    created_at: now,
    updated_at: now,
  };
}
