/**
 * Perceptual Intelligence — core logic (migration v22).
 *
 * Implements the decision machinery of specs/zarlino-artificial-organization.md:
 *   - five distinct evidence layers (§3): engineering, measurement, perceptual,
 *     workflow, market — no single layer is sufficient;
 *   - the product validation gate + stage requirements (§14);
 *   - the decision matrix (§26) with hard overrides: technical failure beats
 *     commercial enthusiasm, governance failure beats everything;
 *   - the kill system (§15): sunk engineering effort NEVER influences the
 *     recommendation;
 *   - sample-size tiers (§13): smallest sample capable of useful evidence,
 *     weak evidence is labeled weak, never pretended strong;
 *   - evaluator calibration (§11): per-domain reliability, never one
 *     universal "good ear" score;
 *   - versioned scoring model (§16);
 *   - Validated Product Yield KPI (§36) and cycle-time KPI (§37);
 *   - failure taxonomy (§39).
 *
 * This module is PURE (no network, no I/O) — store interactions happen in the
 * store / tools / routes layers.
 */

import type {
  FailureAnalysis,
  GateVerdict,
  PerceptualEvaluator,
  PerceptualKnowledge,
  PerceptualResult,
  PerceptualTest,
  ProductValidation,
} from "../../types";
import type { ExecutiveStore } from "../../db/store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The five truth layers (spec §3). Names match product_validations columns. */
export const EVIDENCE_LAYERS = [
  "engineering",
  "measurement",
  "perceptual",
  "workflow",
  "commercial",
] as const;
export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];

/** Layers required at each product stage (spec §14). Governance is always
 *  required — a governance failure overrides every other signal (§26). */
export const STAGE_REQUIREMENTS: Record<string, EvidenceLayer[]> = {
  prototype: ["engineering", "measurement"],
  validation: ["engineering", "measurement", "perceptual"],
  beta: ["engineering", "measurement", "perceptual", "workflow"],
  ship: ["engineering", "measurement", "perceptual", "workflow", "commercial"],
};

export const TEST_TYPES = [
  "blind_preference",
  "abx_identification",
  "problem_solution",
  "workflow",
  "preference_reach",
] as const;

export const TEST_TIERS = ["exploratory", "validation", "high_confidence", "commercial"] as const;

/**
 * Smallest sample capable of producing useful evidence for the decision's
 * stakes (spec §13). Guidance, not a hard gate: tests below the minimum are
 * explicitly labeled WEAK EVIDENCE rather than silently trusted.
 */
export const TIER_MIN_SAMPLES: Record<string, number> = {
  exploratory: 5,
  validation: 12,
  high_confidence: 20,
  commercial: 30,
};

/** Bounded validation cycles before KILL-or-ESCALATE (spec §18). */
export const MAX_VALIDATION_CYCLES = 3;

export const FAILURE_CLASSES = [
  "discovery",
  "hypothesis",
  "dsp",
  "perceptual",
  "workflow",
  "positioning",
  "market",
  "execution",
] as const;

export const GATE_VERDICTS = ["PASS", "FAIL", "INCONCLUSIVE"] as const;

/** Versioned product scoring model (spec §16). Weights are configurable and
 *  versioned in the settings store — never treated as permanent truth. */
export const SCORING_MODEL_VERSION = 1;
export const DEFAULT_SCORING_WEIGHTS = {
  perceptual: 0.3,
  problem_severity: 0.2,
  differentiation: 0.15,
  workflow: 0.1,
  market_demand: 0.1,
  cpu: 0.05,
  stability: 0.05,
  monetization: 0.05,
} as const;
export type ProductScoreInput = Partial<Record<keyof typeof DEFAULT_SCORING_WEIGHTS, number>>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function normalizeVerdict(v: unknown): GateVerdict | string {
  const s = String(v ?? "").toUpperCase();
  return s === "PASS" || s === "FAIL" || s === "INCONCLUSIVE" ? s : "INCONCLUSIVE";
}

export function normalizeTier(t: unknown): string {
  const s = String(t ?? "exploratory").toLowerCase();
  return (TEST_TIERS as readonly string[]).includes(s) ? s : "exploratory";
}

export function normalizeTestType(t: unknown): string {
  const s = String(t ?? "blind_preference").toLowerCase();
  return (TEST_TYPES as readonly string[]).includes(s) ? s : "blind_preference";
}

export function normalizeActorType(t: unknown): string {
  const s = String(t ?? "external_human").toLowerCase();
  return ["external_human", "internal_agent", "customer"].includes(s) ? s : "external_human";
}

/** Attention-check gate (spec §11): a result with any failed attention check
 *  is rejected — it is not evidence. */
export function attentionCheckFailed(r: Pick<PerceptualResult, "attention_checks_passed" | "attention_checks_total">): boolean {
  const total = Math.max(0, r.attention_checks_total);
  const passed = Math.max(0, r.attention_checks_passed);
  return total > 0 && passed < total;
}

/** Binomial tail: P(X >= k) under Bin(n, p). Used for ABX detection (§7B). */
export function binomialTail(p: number, n: number, k: number): number {
  if (n <= 0) return 1;
  let tail = 0;
  for (let i = Math.max(0, Math.ceil(k)); i <= n; i++) {
    tail += comb(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.min(1, tail);
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

// ---------------------------------------------------------------------------
// Test aggregation
// ---------------------------------------------------------------------------

export interface TestAggregation {
  testId: string;
  total: number;
  accepted: number;
  rejected: number;
  weakEvidence: boolean;
  tierMinimum: number;
  /** Preference tally (blind_preference / preference_reach). */
  tally: { choice: string; count: number }[];
  preferenceRatio: number | null; // winner share of accepted votes, 0..1
  majorityChoice: string | null;
  /** ABX / identification. */
  correct: number;
  detectionRate: number | null; // correct / accepted
  abxPValue: number | null; // one-sided binomial p (chance = 0.5)
  detected: boolean | null; // p < 0.05
  meanConfidence: number | null;
  meanCompletionMs: number | null;
}

/**
 * Aggregate a test's results into structured evidence (spec §8: data
 * collection → statistical/structured analysis). REJECTED results (failed
 * attention checks) are excluded from all analysis.
 */
export function aggregateTestResults(test: PerceptualTest, results: PerceptualResult[]): TestAggregation {
  const accepted = results.filter((r) => r.status !== "rejected" && !attentionCheckFailed(r));
  const rejected = results.length - accepted.length;
  const tierMin = TIER_MIN_SAMPLES[normalizeTier(test.tier)] ?? TIER_MIN_SAMPLES.exploratory;
  const weak = accepted.length < tierMin;

  const tallyMap = new Map<string, number>();
  let correct = 0;
  let confSum = 0;
  let confCount = 0;
  let msSum = 0;
  let msCount = 0;
  for (const r of accepted) {
    let resp: Record<string, unknown> = {};
    try {
      resp = JSON.parse(r.responses_json) as Record<string, unknown>;
    } catch {
      /* malformed response contributes nothing */
    }
    const choice = typeof resp.choice === "string" && resp.choice ? resp.choice : "no_answer";
    tallyMap.set(choice, (tallyMap.get(choice) ?? 0) + 1);
    if (resp.correct === true) correct += 1;
    if (typeof resp.confidence === "number") {
      confSum += resp.confidence;
      confCount += 1;
    }
    if (typeof r.completion_ms === "number" && r.completion_ms > 0) {
      msSum += r.completion_ms;
      msCount += 1;
    }
  }
  const tally = [...tallyMap.entries()]
    .map(([choice, count]) => ({ choice, count }))
    .sort((a, b) => b.count - a.count);
  const winner = tally.find((t) => t.choice !== "no_answer") ?? tally[0];
  const isDetectionType = test.test_type === "abx_identification";
  const detectionRate = isDetectionType && accepted.length > 0 ? correct / accepted.length : null;
  const abxP = isDetectionType && accepted.length > 0 ? binomialTail(0.5, accepted.length, correct) : null;

  return {
    testId: test.id,
    total: results.length,
    accepted: accepted.length,
    rejected,
    weakEvidence: weak,
    tierMinimum: tierMin,
    tally,
    preferenceRatio: winner && accepted.length > 0 ? winner.count / accepted.length : null,
    majorityChoice: winner ? winner.choice : null,
    correct,
    detectionRate,
    abxPValue: abxP,
    detected: abxP === null ? null : abxP < 0.05,
    meanConfidence: confCount > 0 ? confSum / confCount : null,
    meanCompletionMs: msCount > 0 ? msSum / msCount : null,
  };
}

/**
 * Convert aggregation output into structured perceptual knowledge (spec §27:
 * store the underlying knowledge, not just "Product X scored 78%").
 */
export function deriveKnowledge(
  test: PerceptualTest,
  agg: TestAggregation,
): Pick<PerceptualKnowledge, "product_category" | "musical_context" | "desired_outcome" | "observation_json" | "confidence" | "sample_size" | "test_protocol" | "source_test_id" | "evidence_tier"> {
  const observations: string[] = [];
  if (agg.preferenceRatio !== null && agg.majorityChoice) {
    observations.push(
      `Listeners preferred option '${agg.majorityChoice}' in ${agg.tally.find((t) => t.choice === agg.majorityChoice)?.count ?? 0}/${agg.accepted} accepted responses (${(agg.preferenceRatio * 100).toFixed(0)}% preference share).`,
    );
  }
  if (agg.detected !== null) {
    observations.push(
      agg.detected
        ? `Listeners could reliably identify the intended difference (${agg.correct}/${agg.accepted} correct, binomial p=${agg.abxPValue?.toFixed(4)}).`
        : `Listeners could NOT reliably identify the intended difference (${agg.correct}/${agg.accepted} correct, binomial p=${agg.abxPValue?.toFixed(4)}) — question whether the effect provides sufficient value.`,
    );
  }
  if (agg.meanConfidence !== null) observations.push(`Mean self-reported listener confidence: ${agg.meanConfidence.toFixed(2)}.`);
  if (agg.weakEvidence) observations.push(`Sample (${agg.accepted}) below the ${normalizeTier(test.tier)} tier minimum (${agg.tierMinimum}) — evidence labeled WEAK, do not treat as strong.`);
  if (agg.rejected > 0) observations.push(`${agg.rejected} response(s) rejected for failed attention checks.`);

  const n = agg.accepted;
  return {
    product_category: test.product_id,
    musical_context: test.objective || test.title,
    desired_outcome: test.hypothesis,
    observation_json: JSON.stringify(observations),
    confidence: n === 0 ? 0 : Math.min(1, Math.round((n / agg.tierMinimum) * 100) / 100),
    sample_size: n,
    test_protocol: `${test.test_type} | ${test.blinding} | target ${test.sample_size_target}`,
    source_test_id: test.id,
    evidence_tier: "perceptual",
  };
}

// ---------------------------------------------------------------------------
// Validation gate + decision matrix
// ---------------------------------------------------------------------------

export interface GateEvaluation {
  stage: string;
  ok: boolean;
  /** Layers that FAILED (hard block). */
  blockers: string[];
  /** Required layers still INCONCLUSIVE (insufficient evidence). */
  insufficient: string[];
  /** Decision-matrix recommendation, ignoring any founder override. */
  recommendation: string;
  /** True when the recorded founder decision contradicts the recommendation —
   *  conflicts must remain visible, never manufactured into consensus (§24). */
  conflict: boolean;
  /** Max validation cycles reached → KILL or ESCALATE, no endless loops (§18). */
  cycleLimitReached: boolean;
}

/**
 * The decision matrix (spec §14, §26). Pure function of the validation row.
 * Sunk engineering effort is not an input — it cannot influence the result.
 */
export function evaluateProductGates(v: ProductValidation): GateEvaluation {
  const stage = v.stage || "prototype";
  const required = STAGE_REQUIREMENTS[stage] ?? STAGE_REQUIREMENTS.prototype!;
  const layers: Record<string, GateVerdict | string> = {
    engineering: normalizeVerdict(v.engineering),
    measurement: normalizeVerdict(v.measurement),
    perceptual: normalizeVerdict(v.perceptual),
    workflow: normalizeVerdict(v.workflow),
    commercial: normalizeVerdict(v.commercial),
    governance: normalizeVerdict(v.governance),
  };
  const blockers: string[] = [];
  const insufficient: string[] = [];
  for (const layer of required) {
    if (layers[layer] === "FAIL") blockers.push(layer);
    else if (layers[layer] === "INCONCLUSIVE") insufficient.push(layer);
  }
  const governanceFail = layers.governance === "FAIL";
  const cycleLimitReached = v.iteration >= MAX_VALIDATION_CYCLES;

  let recommendation: string;
  if (governanceFail) {
    // Governance failure overrides every other signal (§26).
    recommendation = "KILL/PAUSE (governance override)";
  } else if (blockers.includes("engineering") || blockers.includes("measurement")) {
    // Technical failure overrides commercial enthusiasm (§26).
    recommendation = "ITERATE (technical failure)";
  } else if (blockers.includes("perceptual")) {
    recommendation = cycleLimitReached ? "KILL (perceptual fail, cycles exhausted)" : "ITERATE/KILL (perceptual fail)";
  } else if (blockers.includes("workflow")) {
    recommendation = "ITERATE (workflow fail)";
  } else if (blockers.includes("commercial")) {
    recommendation = "REPOSITION/KILL (market fail)";
  } else if (insufficient.length > 0) {
    recommendation = `RETEST (insufficient evidence: ${insufficient.join(", ")})`;
  } else if (stage === "ship") {
    recommendation = "SHIP";
  } else {
    recommendation = stage === "beta" ? "BETA" : "PASS";
  }

  const ok = blockers.length === 0 && insufficient.length === 0 && !governanceFail;
  const recorded = String(v.decision ?? "NONE");
  const conflict =
    recorded !== "NONE" && recorded !== recommendation && recorded !== "RETEST" && !recommendation.startsWith(recorded);
  return { stage, ok, blockers, insufficient, recommendation, conflict, cycleLimitReached };
}

// ---------------------------------------------------------------------------
// Scoring (spec §16)
// ---------------------------------------------------------------------------

/** Resolve scoring weights: settings override (versioned) else defaults. */
export function scoringWeights(store?: ExecutiveStore): Record<keyof typeof DEFAULT_SCORING_WEIGHTS, number> {
  if (store) {
    try {
      const raw = store.getSetting("perceptual_scoring_weights");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<keyof typeof DEFAULT_SCORING_WEIGHTS, number>>;
        const weights: Record<keyof typeof DEFAULT_SCORING_WEIGHTS, number> = { ...DEFAULT_SCORING_WEIGHTS };
        for (const k of Object.keys(DEFAULT_SCORING_WEIGHTS) as (keyof typeof DEFAULT_SCORING_WEIGHTS)[]) {
          const w = parsed[k];
          if (typeof w === "number" && Number.isFinite(w) && w >= 0) weights[k] = w;
        }
        return weights;
      }
    } catch {
      /* malformed setting → defaults */
    }
  }
  return { ...DEFAULT_SCORING_WEIGHTS };
}

/** Weighted product score 0..1 (spec §16). Missing inputs count as 0 — the
 *  score is over the full criteria set, not only the answered ones. */
export function scoreProduct(input: ProductScoreInput, store?: ExecutiveStore): { score: number; weights: Record<string, number>; modelVersion: number } {
  const weights = scoringWeights(store);
  let total = 0;
  let sumAll = 0;
  for (const [key, weight] of Object.entries(weights)) {
    sumAll += weight;
    const v = input[key as keyof typeof DEFAULT_SCORING_WEIGHTS];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += Math.max(0, Math.min(1, v)) * weight;
    }
  }
  return { score: sumAll > 0 ? total / sumAll : 0, weights: weights as unknown as Record<string, number>, modelVersion: SCORING_MODEL_VERSION };
}

// ---------------------------------------------------------------------------
// Organizational KPIs (spec §36-37)
// ---------------------------------------------------------------------------

export interface PerceptualKpi {
  validatedProductYield: number | null; // viable / serious experiments
  seriousExperiments: number;
  viableProducts: number;
  testsByStatus: Record<string, number>;
  testsByTier: Record<string, number>;
  evaluatorsActive: number;
  evidenceGaps: string[]; // products with insufficient perceptual evidence
  avgCycleDays: number | null; // prototype→decision compression (§37)
}

/** Validated Product Yield (spec §36) + secondary KPIs (§37). */
export function perceptualKpi(store: ExecutiveStore): PerceptualKpi {
  const tests = store.listPerceptualTests({ limit: 500 });
  const validations = store.listProductValidations();
  const evaluators = store.listPerceptualEvaluators({ limit: 500 });

  const serious = tests.filter((t) => normalizeTier(t.tier) !== "exploratory").length;
  const viable = new Set(
    validations.filter((v) => normalizeVerdict(v.commercial) === "PASS" && normalizeVerdict(v.engineering) !== "FAIL").map((v) => v.product_id),
  ).size;

  const testsByStatus: Record<string, number> = {};
  const testsByTier: Record<string, number> = {};
  for (const t of tests) {
    testsByStatus[t.status] = (testsByStatus[t.status] ?? 0) + 1;
    testsByTier[normalizeTier(t.tier)] = (testsByTier[normalizeTier(t.tier)] ?? 0) + 1;
  }

  const evidenceGaps = validations
    .filter((v) => {
      const e = evaluateProductGates(v);
      return e.insufficient.includes("perceptual") || e.blockers.includes("perceptual");
    })
    .map((v) => v.product_id);

  const completed = tests.filter((t) => t.status === "completed" || t.status === "analyzed" || t.status === "closed");
  let cycleDaysSum = 0;
  let cycleDaysCount = 0;
  for (const t of completed) {
    const days = (Date.parse(t.updated_at) - Date.parse(t.created_at)) / 86_400_000;
    if (Number.isFinite(days) && days >= 0) {
      cycleDaysSum += days;
      cycleDaysCount += 1;
    }
  }

  return {
    validatedProductYield: serious > 0 ? viable / serious : null,
    seriousExperiments: serious,
    viableProducts: viable,
    testsByStatus,
    testsByTier,
    evaluatorsActive: evaluators.filter((e) => e.availability === "active").length,
    evidenceGaps,
    avgCycleDays: cycleDaysCount > 0 ? cycleDaysSum / cycleDaysCount : null,
  };
}

// ---------------------------------------------------------------------------
// Failure taxonomy (spec §39)
// ---------------------------------------------------------------------------

export function normalizeFailureClass(c: unknown): string {
  const s = String(c ?? "").toLowerCase();
  return (FAILURE_CLASSES as readonly string[]).includes(s) ? s : "perceptual";
}

export function failureRecord(input: {
  id: string;
  productId: string;
  failureClass: string;
  title: string;
  description?: string;
  evidence?: unknown[];
  lessons?: unknown[];
  now: string;
}): FailureAnalysis {
  return {
    id: input.id,
    product_id: input.productId,
    failure_class: normalizeFailureClass(input.failureClass),
    title: input.title,
    description: input.description ?? "",
    evidence_json: JSON.stringify(input.evidence ?? []),
    lesson_json: JSON.stringify(input.lessons ?? []),
    created_at: input.now,
    updated_at: input.now,
  };
}

// ---------------------------------------------------------------------------
// Evaluator calibration (spec §11) — per-domain, never one universal score
// ---------------------------------------------------------------------------

export function domainReliability(evaluator: PerceptualEvaluator): Record<string, number> {
  try {
    const parsed = JSON.parse(evaluator.reliability_by_domain_json || "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.max(0, Math.min(1, v));
    }
    return out;
  } catch {
    return {};
  }
}
