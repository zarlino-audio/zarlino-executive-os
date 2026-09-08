/**
 * Critic independence discounting (AOrgI §20) — two agents with the same
 * model/prompt lineage are correlated evidence, not independent votes.
 *
 * Each lineage's weight is 1/sqrt(members), so n correlated votes count like
 * sqrt(n) independent ones. Track lineage_id and discount correlated votes —
 * never count them as fully independent evidence.
 */

export interface CriticVote {
  agentId: string;
  lineageId: string;
  /** 1 = approve, -1 = reject. */
  verdict: 1 | -1;
  /** 0..1 confidence in the verdict. */
  confidence: number;
}

export interface DiscountedVotes {
  /** -1..1 aggregate; the sign decides the verdict. */
  score: number;
  verdict: "APPROVE" | "REJECT" | "DIVERGED";
  lineageWeights: Array<{ lineageId: string; members: number; weight: number }>;
}

export function discountCorrelatedVotes(votes: CriticVote[], divergeThreshold = 0.15): DiscountedVotes {
  const byLineage = new Map<string, CriticVote[]>();
  for (const v of votes) {
    const list = byLineage.get(v.lineageId) ?? [];
    list.push(v);
    byLineage.set(v.lineageId, list);
  }
  const lineageWeights = [...byLineage.entries()].map(([lineageId, members]) => ({
    lineageId,
    members: members.length,
    weight: 1 / Math.sqrt(members.length),
  }));

  let num = 0;
  let den = 0;
  for (const { lineageId, weight } of lineageWeights) {
    for (const v of byLineage.get(lineageId)!) {
      const confidence = Math.max(0, Math.min(1, v.confidence));
      num += weight * v.verdict * confidence;
      den += weight * confidence;
    }
  }
  const score = den === 0 ? 0 : num / den;
  const verdict = score > divergeThreshold ? "APPROVE" : score < -divergeThreshold ? "REJECT" : "DIVERGED";
  return { score, verdict, lineageWeights };
}
