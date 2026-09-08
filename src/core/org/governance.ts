/**
 * Capability governance (AOrgI §10, §12) — before any tool invocation the
 * chain must be: agent → capability check → governance check → autonomy check
 * → tool. Never agent → tool.
 *
 * Autonomy levels (§12):
 *   L0 Suggest                    → DENY execution (can only propose)
 *   L1 Reviewed execution         → REVIEW (needs approval before running)
 *   L2 Bounded autonomous         → ALLOW actions inside the grant, else REVIEW
 *   L3 Self-governed              → ALLOW actions inside the grant/scope
 *
 * Fail-closed: no matching grant and no `*` wildcard grant for the role = DENY.
 * A grant marked requires_review always needs review, whatever its level.
 */

import type { OrgCapabilityGrant } from "../../types";

export type CapabilityVerdict = "ALLOW" | "REVIEW" | "DENY";

export interface CapabilityDecision {
  verdict: CapabilityVerdict;
  grantId: string | null;
  reason: string;
}

export function evaluateGrant(grant: OrgCapabilityGrant, action: string): CapabilityDecision {
  const allowed: string[] = safeJsonArray(grant.allowed_actions_json);
  const actionAllowed = allowed.includes("*") || allowed.includes(action);
  const base = { grantId: grant.id, reason: "" };

  // L0 (suggest only) is the strictest — execution is denied outright,
  // regardless of any review flag.
  if (grant.autonomy_level === "L0") {
    return { ...base, verdict: "DENY", reason: "L0 (suggest only) — execution denied; propose instead." };
  }
  if (grant.requires_review === 1) {
    return { ...base, verdict: "REVIEW", reason: "Grant requires review for this capability." };
  }
  switch (grant.autonomy_level) {
    case "L1":
      return { ...base, verdict: "REVIEW", reason: "L1 (reviewed execution) — founder/arbiter approval required." };
    case "L2":
      if (!actionAllowed) return { ...base, verdict: "REVIEW", reason: `L2 bounded autonomy — action '${action}' outside allowed actions.` };
      return { ...base, verdict: "ALLOW", reason: "L2 bounded autonomy — action within grant." };
    case "L3":
      if (!actionAllowed) return { ...base, verdict: "REVIEW", reason: `L3 self-governance — action '${action}' outside declared scope.` };
      return { ...base, verdict: "ALLOW", reason: "L3 self-governance — action within declared scope." };
    default:
      return { ...base, verdict: "DENY", reason: `Unknown autonomy level '${grant.autonomy_level}' — fail closed.` };
  }
}

/**
 * Decide an action for a role: exact capability grant wins, then the `*`
 * wildcard fallback, then DENY.
 */
export function capabilityVerdictForRole(grants: OrgCapabilityGrant[], capability: string, action: string): CapabilityDecision {
  const exact = grants.find((g) => g.capability === capability);
  if (exact) return evaluateGrant(exact, action);
  const wildcard = grants.find((g) => g.capability === "*");
  if (wildcard) return evaluateGrant(wildcard, action);
  return {
    verdict: "DENY",
    grantId: null,
    reason: `No capability grant (and no wildcard) for '${capability}' — unrestricted tool access is never inherited (§10).`,
  };
}

function safeJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
