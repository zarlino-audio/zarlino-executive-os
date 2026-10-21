/**
 * Factory build lifecycle tests (migration v40).
 *
 * Proves the invariants the factory depends on:
 *   - build ids are immutable, validated identifiers;
 *   - states move forward only (no backwards moves, no skips, terminals final);
 *   - a completion whose quality gate did not pass can never reach READY;
 *   - a valid completion reaches READY with artifact + timing cost persisted;
 *   - the cost summary is a correct SQL aggregate.
 *
 * Uses the same node:sqlite in-memory setup as the rest of the suite.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import {
  FACTORY_BUILD_STATES,
  FactoryBuildError,
  buildCostSummary,
  completeBuild,
  createBuild,
  generateBuildId,
  getBuild,
  getBuildEvents,
  isTerminalState,
  isValidBuildId,
  transitionBuild,
  validateStateTransition,
  type CreateBuildInput,
} from "../src/core/factory/builds";

function buildInput(id: string, overrides: Partial<CreateBuildInput> = {}): CreateBuildInput {
  return {
    id,
    requestId: "req_factory_test",
    accountId: "acct_factory_test",
    productId: "zarlino.example.saturation",
    productName: "Example Saturation",
    productVersion: "1.0.0",
    uiTemplate: "standard",
    spec: {
      factorySchemaVersion: 1,
      plugin: { id: "zarlino.example.saturation", name: "Example Saturation", version: "1.0.0" },
    },
    specSha256: "a".repeat(64),
    sourceCommit: "abc123",
    ...overrides,
  };
}

describe("factory builds (node:sqlite)", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;
  let sql: ReturnType<typeof createNodeSql>;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    sql = createNodeSql(db as never);
    store = new ExecutiveStore(sql);
    store.migrate();
  });

  afterAll(() => {
    db.close();
  });

  it("validates build ids and generates conforming ones", () => {
    expect(isValidBuildId("fb-20261017T101010Z-a1b2c3")).toBe(true);
    expect(isValidBuildId("abc123")).toBe(true);
    expect(isValidBuildId(generateBuildId())).toBe(true);

    // Too short, leading punctuation, spaces/path traversal, too long, empty.
    expect(isValidBuildId("short")).toBe(false);
    expect(isValidBuildId("-abcdef")).toBe(false);
    expect(isValidBuildId("fb 12345")).toBe(false);
    expect(isValidBuildId("../escape")).toBe(false);
    expect(isValidBuildId("a".repeat(65))).toBe(false);
    expect(isValidBuildId("")).toBe(false);
  });

  it("keeps the lifecycle ordered and monotonic", () => {
    expect(FACTORY_BUILD_STATES).toEqual([
      "QUEUED",
      "ASSEMBLING",
      "BUILDING",
      "TESTING",
      "PACKAGING",
      "READY",
      "FAILED",
    ]);
    expect(validateStateTransition("QUEUED", "ASSEMBLING")).toBe(true);
    expect(validateStateTransition("ASSEMBLING", "BUILDING")).toBe(true);
    expect(validateStateTransition("BUILDING", "TESTING")).toBe(true);
    expect(validateStateTransition("TESTING", "PACKAGING")).toBe(true);
    expect(validateStateTransition("PACKAGING", "READY")).toBe(true);
    // Any non-terminal state may fail.
    expect(validateStateTransition("QUEUED", "FAILED")).toBe(true);
    expect(validateStateTransition("TESTING", "FAILED")).toBe(true);
    // Backwards, skips and no-ops are rejected.
    expect(validateStateTransition("BUILDING", "ASSEMBLING")).toBe(false);
    expect(validateStateTransition("QUEUED", "BUILDING")).toBe(false);
    expect(validateStateTransition("READY", "READY")).toBe(false);
    // Terminal states are final.
    expect(isTerminalState("READY")).toBe(true);
    expect(isTerminalState("FAILED")).toBe(true);
    expect(isTerminalState("PACKAGING")).toBe(false);
    expect(validateStateTransition("READY", "FAILED")).toBe(false);
    expect(validateStateTransition("FAILED", "READY")).toBe(false);
    expect(validateStateTransition("BOGUS", "FAILED")).toBe(false);
  });

  it("rejects an illegal transition against the stored row", () => {
    const id = "fb-test-transition-0001";
    createBuild(sql, buildInput(id));
    expect(() => transitionBuild(sql, id, "BUILDING")).toThrow(FactoryBuildError);
    expect(getBuild(sql, id)?.status).toBe("QUEUED");
  });

  it("creates one QUEUED row plus a QUEUED event and rejects a duplicate id", () => {
    const id = "fb-test-duplicate-0001";
    const created = createBuild(sql, buildInput(id));
    expect(created.status).toBe("QUEUED");
    expect(created.product_id).toBe("zarlino.example.saturation");
    expect(created.spec_sha256).toBe("a".repeat(64));

    const events = getBuildEvents(sql, id);
    expect(events.length).toBe(1);
    expect(events[0]?.state).toBe("QUEUED");
    expect(events[0]?.actor).toBe("orchestrator");

    expect(() => createBuild(sql, buildInput(id))).toThrow(/already exists/);
    expect(getBuildEvents(sql, id).length).toBe(1);
  });

  it("never reaches READY when the quality gate did not pass", () => {
    const id = "fb-test-qafail-0001";
    createBuild(sql, buildInput(id));
    const done = completeBuild(sql, id, {
      status: "READY",
      githubRunId: "111222",
      record: {
        productName: "Example Saturation",
        qaPassed: false,
        qaReport: { passed: false, gates: [{ id: "audio.nan", passed: false }] },
        timings: { compileSeconds: 12, testSeconds: 4 },
        artifact: { name: "ExampleSaturation-v1.vst3.zip", zipBytes: 42, zipSha256: "b".repeat(64) },
      },
    });

    expect(done.status).toBe("FAILED");
    expect(done.failure_state).toBe("QA_GATE_FAILED");
    expect(done.qa_passed).toBe(0);
    const events = getBuildEvents(sql, id);
    expect(events.some((e) => e.state === "READY")).toBe(false);
    expect(events[events.length - 1]?.state).toBe("FAILED");
  });

  it("treats a missing qaReport.passed as a failed gate even when qaPassed is true", () => {
    const id = "fb-test-qafail-0002";
    createBuild(sql, buildInput(id));
    const done = completeBuild(sql, id, {
      status: "READY",
      record: { qaPassed: true, qaReport: { gates: [] } },
    });
    expect(done.status).toBe("FAILED");
    expect(done.failure_state).toBe("QA_GATE_FAILED");
  });

  it("reaches READY with the artifact and cost telemetry persisted", () => {
    const id = "fb-test-ready-0001";
    createBuild(sql, buildInput(id));
    const done = completeBuild(sql, id, {
      status: "READY",
      productName: "Example Saturation",
      githubRunId: "98765",
      record: {
        productName: "Example Saturation",
        productVersion: "1.0.0",
        sourceCommit: "deadbeef",
        targetPlatform: "windows-x86_64",
        qaPassed: true,
        qaReport: { passed: true, gates: [] },
        provenance: {
          specSha256: "a".repeat(64),
          specFingerprint: "0x0a57e5d0ac8c6d26",
          uiPlanFingerprint: "0x2430135e1c7458e3",
          catalogFingerprint: "0xa0c917c3692f9a8a",
          modules: [{ instanceId: "drive", moduleId: "zarlino.saturation" }],
        },
        timings: { compileSeconds: 10, testSeconds: 5, packageSeconds: 2 },
        artifact: {
          name: "ExampleSaturation-v1.vst3.zip",
          zipBytes: 123456,
          zipSha256: "f".repeat(64),
        },
        aiCostUsd: 0.5,
        estimatedVariableCostUsd: 0.25,
        retryCount: 1,
      },
    });

    expect(done.status).toBe("READY");
    expect(done.failure_state).toBeNull();
    expect(done.github_run_id).toBe("98765");
    expect(done.artifact_name).toBe("ExampleSaturation-v1.vst3.zip");
    expect(done.artifact_key).toBe(`factory-builds/${id}/artifact/ExampleSaturation-v1.vst3.zip`);
    expect(done.artifact_bytes).toBe(123456);
    expect(done.artifact_sha256).toBe("f".repeat(64));
    expect(done.qa_report_key).toBe(`factory-builds/${id}/qa-report.json`);
    expect(done.qa_passed).toBe(1);
    expect(done.compile_seconds).toBe(10);
    expect(done.test_seconds).toBe(5);
    expect(done.package_seconds).toBe(2);
    expect(done.retry_count).toBe(1);
    expect(done.ai_cost_usd).toBe(0.5);
    expect(done.estimated_variable_cost_usd).toBe(0.25);
    expect(done.spec_fingerprint).toBe("0x0a57e5d0ac8c6d26");
    expect(done.ui_plan_fingerprint).toBe("0x2430135e1c7458e3");
    expect(done.catalog_fingerprint).toBe("0xa0c917c3692f9a8a");
    expect(done.completed_at).toBeTruthy();
    expect(done.source_commit).toBe("deadbeef");
  });

  it("aggregates build cost telemetry with SQL", () => {
    // A dedicated database keeps the aggregate independent of the tests above.
    const costDb = new DatabaseSync(":memory:");
    try {
      const costSql = createNodeSql(costDb as never);
      new ExecutiveStore(costSql).migrate();

      const readyId = "fb-test-cost-ready-01";
      const failedId = "fb-test-cost-fail-01";
      createBuild(costSql, buildInput(readyId));
      createBuild(costSql, buildInput(failedId));

      completeBuild(costSql, readyId, {
        status: "READY",
        record: {
          qaPassed: true,
          qaReport: { passed: true },
          timings: { compileSeconds: 10, testSeconds: 5, packageSeconds: 2 },
          artifact: { name: "CostReady-v1.vst3.zip", zipBytes: 100, zipSha256: "c".repeat(64) },
          aiCostUsd: 0.5,
          estimatedVariableCostUsd: 0.25,
        },
      });
      completeBuild(costSql, failedId, {
        status: "READY",
        record: {
          qaPassed: false,
          qaReport: { passed: false },
          timings: { compileSeconds: 20, testSeconds: 5, packageSeconds: 3 },
          aiCostUsd: 0.1,
          estimatedVariableCostUsd: 0,
        },
      });

      const summary = buildCostSummary(costSql, "2000-01-01T00:00:00.000Z");
      expect(summary.count).toBe(2);
      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.totalCompileSeconds).toBe(30);
      expect(summary.totalTestSeconds).toBe(10);
      expect(summary.totalArtifactBytes).toBe(100);
      expect(summary.totalAiCostUsd).toBeCloseTo(0.6, 10);
      expect(summary.totalEstimatedVariableCostUsd).toBeCloseTo(0.25, 10);
      // (10 + 5 + 2 + 20 + 5 + 3) / 2 builds
      expect(summary.averageSecondsPerBuild).toBe(22.5);

      const empty = buildCostSummary(costSql, "2999-01-01T00:00:00.000Z");
      expect(empty.count).toBe(0);
      expect(empty.averageSecondsPerBuild).toBe(0);
    } finally {
      costDb.close();
    }
  });
});
