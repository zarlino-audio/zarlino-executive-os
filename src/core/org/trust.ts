/**
 * Trust math (AOrgI §21) — trust is per agent × capability, evidence-based,
 * and DECAYS over time so stale reputation stops protecting a degraded agent.
 *
 * Pure functions shared by the store and tests. Trust is evidence, not
 * reputation: it starts at an unproven 0.5 and moves only with measured
 * outcomes, decaying toward the prior as evidence ages.
 */

export const TRUST_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TRUST_LEARNING_RATE = 0.2;
export const TRUST_INITIAL = 0.5;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Decay a stored trust value according to its age (exponential half-life). */
export function decayedTrust(value: number, lastUpdatedIso: string, nowIso: string): number {
  const ageMs = Math.max(0, Date.parse(nowIso) - Date.parse(lastUpdatedIso));
  const factor = Math.exp((-Math.LN2 * ageMs) / TRUST_HALF_LIFE_MS);
  return clamp01(value * factor);
}

/**
 * Fold one piece of evidence into trust: decay the prior first, then move a
 * learning-rate step toward the outcome (1 = success, 0 = failure).
 */
export function applyTrustEvidence(
  value: number,
  lastUpdatedIso: string,
  outcome: 0 | 1,
  nowIso: string,
): { value: number; last_updated: string } {
  const prior = decayedTrust(value, lastUpdatedIso, nowIso);
  const next = clamp01(prior + (outcome - prior) * TRUST_LEARNING_RATE);
  return { value: next, last_updated: nowIso };
}
