import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import {
  aggregateTestResults,
  attentionCheckFailed,
  binomialTail,
  DEFAULT_SCORING_WEIGHTS,
  deriveKnowledge,
  evaluateProductGates,
  failureRecord,
  normalizeActorType,
  perceptualKpi,
  scoreProduct,
  scoringWeights,
} from "../src/core/perceptual/manager";
import type { PerceptualResult, PerceptualTest, ProductValidation } from "../src/types";
import { newId, nowIso } from "../src/ids";

function mkValidation(overrides: Partial<ProductValidation> = {}): ProductValidation {
  return {
    product_id: "prod_test",
    stage: "validation",
    engineering: "PASS",
    measurement: "PASS",
    perceptual: "PASS",
    workflow: "INCONCLUSIVE",
    commercial: "INCONCLUSIVE",
    governance: "PASS",
    decision: "NONE",
    iteration: 0,
    notes_json: "[]",
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

function mkTest(overrides: Partial<PerceptualTest> = {}): PerceptualTest {
  return {
    id: newId("pt"),
    product_id: "prod_test",
    title: "Test",
    hypothesis: "",
    objective: "",
    test_type: "blind_preference",
    protocol: "",
    stimuli_json: "[]",
    conditions_json: "[]",
    evaluator_requirements: "",
    sample_size_target: 12,
    blinding: "blind",
    randomization: "",
    metrics_json: "[]",
    acceptance_threshold: "",
    tier: "validation",
    status: "completed",
    source: "test",
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

function mkResult(testId: string, overrides: Partial<PerceptualResult> = {}): PerceptualResult {
  return {
    id: newId("prs"),
    test_id: testId,
    evaluator_id: "ev_1",
    responses_json: JSON.stringify({ choice: "A" }),
    attention_checks_passed: 1,
    attention_checks_total: 1,
    status: "accepted",
    source: "test",
    created_at: nowIso(),
    ...overrides,
  };
}

describe("Perceptual Intelligence (node:sqlite)", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });

  it("migration v22 creates tables and seeds the honest validation baseline", () => {
    expect(store.listPerceptualEvaluators({})).toEqual([]);
    expect(store.listPerceptualTests({})).toEqual([]);
    expect(store.listPerceptualResults({})).toEqual([]);
    expect(store.listPerceptualKnowledge({})).toEqual([]);
    expect(store.listFailureAnalyses({})).toEqual([]);
    const validations = store.listProductValidations();
    expect(validations.length).toBe(2);
    const ztame = store.getProductValidation("prod_ztame");
    expect(ztame).not.toBeNull();
    // Honest baseline: technical layers pass, perceptual evidence NOT pretended.
    expect(ztame!.perceptual).toBe("INCONCLUSIVE");
    expect(ztame!.engineering).toBe("PASS");
    expect(ztame!.governance).toBe("PASS");
  });

  it("registers evaluators as explicit organizational actors (never employees)", () => {
    const now = nowIso();
    store.createPerceptualEvaluator({
      id: "ev_1",
      name: "Test Listener",
      actor_type: "external_human",
      expertise: "mixing_engineer",
      genres_json: JSON.stringify(["afrobeats"]),
      experience_level: "senior",
      reliability_score: 0,
      calibration_score: 0,
      reliability_by_domain_json: "{}",
      availability: "active",
      compensation_profile: "",
      conflicts_json: "[]",
      test_count: 0,
      source: "test",
      created_at: now,
      updated_at: now,
    });
    expect(normalizeActorType("INTERNAL_AGENT")).toBe("internal_agent");
    expect(normalizeActorType("garbage")).toBe("external_human");
    expect(store.getPerceptualEvaluator("ev_1")?.actor_type).toBe("external_human");
    expect(store.listPerceptualEvaluators({ actorType: "external_human" }).length).toBe(1);
    expect(store.listPerceptualEvaluators({ actorType: "customer" }).length).toBe(0);
    expect(store.deletePerceptualEvaluator("missing")).toBe(false);
  });

  it("registers controlled listening tests in the registry", () => {
    store.createPerceptualTest(mkTest({ id: "pt_1", title: "Vocal presence A/B", product_id: "prod_ztame", status: "designed" }));
    const t = store.getPerceptualTest("pt_1");
    expect(t).not.toBeNull();
    expect(t!.test_type).toBe("blind_preference");
    expect(t!.tier).toBe("validation");
    expect(store.listPerceptualTests({ productId: "prod_ztame" }).length).toBe(1);
    store.updatePerceptualTest("pt_1", { status: "recruiting" });
    expect(store.getPerceptualTest("pt_1")?.status).toBe("recruiting");
  });

  it("records results append-only and rejects attention-check failures", () => {
    store.createPerceptualResult(mkResult("pt_1"));
    store.createPerceptualResult(mkResult("pt_1", { id: newId("prs"), responses_json: JSON.stringify({ choice: "B" }) }));
    // A failed attention check is NOT evidence — stored as rejected.
    store.createPerceptualResult(
      mkResult("pt_1", {
        id: newId("prs"),
        attention_checks_passed: 0,
        attention_checks_total: 1,
        status: "rejected",
      }),
    );
    expect(attentionCheckFailed({ attention_checks_passed: 0, attention_checks_total: 1 })).toBe(true);
    expect(attentionCheckFailed({ attention_checks_passed: 1, attention_checks_total: 1 })).toBe(false);
    // The store itself rejects nothing (the layer above computes status), but
    // the aggregate must exclude it.
    const results = store.listPerceptualResults({ testId: "pt_1" });
    expect(results.length).toBe(3);
    expect(store.countAcceptedPerceptualResults("pt_1")).toBe(2);
  });

  it("aggregates preference with weak-evidence labeling (never pretended strong)", () => {
    const test = store.getPerceptualTest("pt_1")!;
    const results = store.listPerceptualResults({ testId: "pt_1" });
    const agg = aggregateTestResults(test, results);
    expect(agg.total).toBe(3);
    expect(agg.accepted).toBe(2);
    expect(agg.rejected).toBe(1);
    expect(agg.majorityChoice).toBe("A");
    expect(agg.preferenceRatio).toBe(0.5);
    // validation tier minimum is 12 → 2 accepted is WEAK evidence, flagged.
    expect(agg.weakEvidence).toBe(true);
    expect(agg.tierMinimum).toBe(12);
  });

  it("computes ABX detection significance with a binomial test", () => {
    expect(binomialTail(0.5, 10, 10)).toBeCloseTo(1 / 1024, 6);
    const test = mkTest({ id: "pt_abx", test_type: "abx_identification", tier: "exploratory" });
    store.createPerceptualTest(test);
    for (let i = 0; i < 5; i++) {
      store.createPerceptualResult(
        mkResult("pt_abx", {
          id: newId("prs"),
          responses_json: JSON.stringify({ correct: true }),
        }),
      );
    }
    const agg = aggregateTestResults(test, store.listPerceptualResults({ testId: "pt_abx" }));
    expect(agg.detectionRate).toBe(1);
    expect(agg.abxPValue).toBeCloseTo(0.03125, 5);
    expect(agg.detected).toBe(true);
  });

  it("derives structured knowledge from an aggregation", () => {
    const test = store.getPerceptualTest("pt_1")!;
    const agg = aggregateTestResults(test, store.listPerceptualResults({ testId: "pt_1" }));
    const k = deriveKnowledge(test, agg);
    expect(k.evidence_tier).toBe("perceptual");
    expect(k.source_test_id).toBe("pt_1");
    expect(JSON.parse(k.observation_json).length).toBeGreaterThan(0);
    expect(k.sample_size).toBe(2);
  });

  it("enforces the decision matrix: technical failure overrides commercial enthusiasm", () => {
    const v = mkValidation({ engineering: "FAIL", commercial: "PASS", perceptual: "PASS" });
    const e = evaluateProductGates(v);
    expect(e.ok).toBe(false);
    expect(e.blockers).toContain("engineering");
    expect(e.recommendation).toContain("ITERATE");
  });

  it("enforces the decision matrix: governance failure overrides every other signal", () => {
    const v = mkValidation({ governance: "FAIL", engineering: "PASS", measurement: "PASS", perceptual: "PASS", commercial: "PASS" });
    const e = evaluateProductGates(v);
    expect(e.ok).toBe(false);
    expect(e.recommendation).toContain("governance");
  });

  it("perceptual FAIL blocks a validation-stage product and recommends ITERATE/KILL", () => {
    const v = mkValidation({ perceptual: "FAIL" });
    const e = evaluateProductGates(v);
    expect(e.ok).toBe(false);
    expect(e.blockers).toContain("perceptual");
    expect(e.recommendation).toContain("KILL");
    // Cycle limit reached → KILL, not endless optimization (spec §18).
    const e2 = evaluateProductGates(mkValidation({ perceptual: "FAIL", iteration: 3 }));
    expect(e2.cycleLimitReached).toBe(true);
    expect(e2.recommendation).toContain("KILL");
  });

  it("labels insufficient evidence as RETEST and never pretends PASS", () => {
    const v = mkValidation({ perceptual: "INCONCLUSIVE", engineering: "PASS", measurement: "PASS" });
    const e = evaluateProductGates(v);
    expect(e.ok).toBe(false);
    expect(e.insufficient).toContain("perceptual");
    expect(e.recommendation).toContain("RETEST");
  });

  it("passes a fully-evidenced ship-stage product and exposes decision conflicts", () => {
    const v = mkValidation({
      stage: "ship",
      engineering: "PASS",
      measurement: "PASS",
      perceptual: "PASS",
      workflow: "PASS",
      commercial: "PASS",
      governance: "PASS",
      decision: "SHIP",
    });
    const e = evaluateProductGates(v);
    expect(e.ok).toBe(true);
    expect(e.recommendation).toBe("SHIP");
    expect(e.conflict).toBe(false);
    // A recorded KILL against a PASS recommendation stays visible (spec §24).
    const e2 = evaluateProductGates({ ...v, decision: "KILL" });
    expect(e2.conflict).toBe(true);
  });

  it("scores products with the versioned, configurable scoring model", () => {
    const weights = DEFAULT_SCORING_WEIGHTS;
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    const s = scoreProduct({ perceptual: 1, problem_severity: 1, differentiation: 1, workflow: 1, market_demand: 1, cpu: 1, stability: 1, monetization: 1 });
    expect(s.score).toBeCloseTo(1, 6);
    expect(s.modelVersion).toBe(1);
    // Store-backed override: weights are configurable, not permanent truth.
    // Full replacement set: perceptual is the only weighted criterion.
    store.setSetting(
      "perceptual_scoring_weights",
      JSON.stringify({
        perceptual: 1,
        problem_severity: 0,
        differentiation: 0,
        workflow: 0,
        market_demand: 0,
        cpu: 0,
        stability: 0,
        monetization: 0,
      }),
    );
    const w2 = scoringWeights(store);
    expect(w2.perceptual).toBe(1);
    expect(w2.problem_severity).toBe(0);
    expect(w2.differentiation).toBe(0);
    const s2 = scoreProduct({ perceptual: 1 }, store);
    expect(s2.score).toBeCloseTo(1, 6);
    const s3 = scoreProduct({ perceptual: 0.5, problem_severity: 1 }, store);
    expect(s3.score).toBeCloseTo(0.5, 6);
    store.setSetting("perceptual_scoring_weights", null);
  });

  it("computes Validated Product Yield and evidence gaps (spec §36)", () => {
    const kpi = perceptualKpi(store);
    expect(kpi.seriousExperiments).toBeGreaterThanOrEqual(1);
    // Shipped products have commercial PASS → viable.
    expect(kpi.viableProducts).toBe(2);
    expect(kpi.validatedProductYield).not.toBeNull();
    // ZTame/ZScorch seeded with perceptual INCONCLUSIVE → evidence gaps.
    expect(kpi.evidenceGaps).toContain("prod_ztame");
    expect(kpi.evaluatorsActive).toBeGreaterThanOrEqual(0);
  });

  it("normalizes failure classes for the taxonomy (spec §39)", () => {
    const f = failureRecord({
      id: "pfl_1",
      productId: "prod_test",
      failureClass: "PERCEPTUAL",
      title: "x",
      description: "",
      lessons: ["lesson"],
      now: nowIso(),
    });
    expect(f.failure_class).toBe("perceptual");
    expect(JSON.parse(f.lesson_json)).toEqual(["lesson"]);
    expect(failureRecord({ id: "pfl_2", productId: "p", failureClass: "??", title: "x", now: nowIso() }).failure_class).toBe("perceptual");
  });

  it("stores knowledge and failures in organizational memory", () => {
    store.createPerceptualKnowledge({
      id: "pk_1",
      product_category: "vocal_processor",
      musical_context: "dense_afrobeats_mix",
      desired_outcome: "forward_vocal",
      observation_json: JSON.stringify(["listeners preferred moderate harmonic enhancement"]),
      confidence: 0.7,
      sample_size: 12,
      test_protocol: "blind_preference | blind | target 12",
      source_test_id: "pt_1",
      evidence_tier: "perceptual",
      source: "test",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    expect(store.listPerceptualKnowledge({ productCategory: "vocal_processor" }).length).toBe(1);
    expect(store.deletePerceptualKnowledge("pk_1")).toBe(true);
    store.createFailureAnalysis(failureRecord({ id: "pfl_3", productId: "prod_test", failureClass: "market", title: "no WTP", now: nowIso() }));
    expect(store.listFailureAnalyses({ failureClass: "market" }).length).toBe(1);
  });
});
