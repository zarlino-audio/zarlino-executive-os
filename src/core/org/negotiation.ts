/**
 * Negotiation engine (AOrgI §22) — agents may disagree, but never forever.
 *
 * The cycle is PROPOSAL → CRITIQUE → REVISION → CRITIQUE → … capped at a hard
 * maximum number of rounds (default 3). When rounds are exhausted the
 * negotiation goes to ARBITRATION with the explicit arbiter for the
 * disagreement class (§23). No infinite agent debate.
 */

export const DEFAULT_MAX_ROUNDS = 3;

export type NegotiationPhase = "PROPOSAL" | "CRITIQUE" | "REVISION" | "ARBITRATE";

/** What happens next given the current round count. */
export function negotiationPhase(round: number, maxRounds: number = DEFAULT_MAX_ROUNDS): NegotiationPhase {
  if (round >= maxRounds) return "ARBITRATE";
  if (round === 0) return "PROPOSAL";
  return round % 2 === 1 ? "CRITIQUE" : "REVISION";
}

/** Round kinds allowed when recording a round for the current phase. */
export function allowedRoundKinds(phase: NegotiationPhase): string[] {
  switch (phase) {
    case "PROPOSAL":
      return ["PROPOSAL"];
    case "CRITIQUE":
      return ["CRITIQUE"];
    case "REVISION":
      return ["REVISION", "PROPOSAL"];
    case "ARBITRATE":
      return [];
  }
}

export interface ArbiterRule {
  disagreement_class: string;
  arbiter_role_id?: string;
  fallback_role_id?: string;
  arbiter_kind: string; // "role" | "human_ceo"
}

/** Resolve the arbiter for a disagreement class (fallback included). */
export function arbiterForClass(rules: ArbiterRule[], disagreementClass: string): { arbiterRoleId: string | null; arbiterKind: string } {
  const rule = rules.find((r) => r.disagreement_class === disagreementClass) ?? rules.find((r) => r.disagreement_class === "cross_functional");
  if (!rule) return { arbiterRoleId: null, arbiterKind: "human_ceo" };
  if (rule.arbiter_kind === "human_ceo") return { arbiterRoleId: null, arbiterKind: "human_ceo" };
  return { arbiterRoleId: rule.arbiter_role_id ?? rule.fallback_role_id ?? null, arbiterKind: "role" };
}
