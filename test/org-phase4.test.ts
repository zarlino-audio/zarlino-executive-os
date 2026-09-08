/**
 * AOrgI Phase 4 tests (migration v27) — collective intelligence metrics,
 * organizational analyst self-observation, and guarded chaos drills (§35,
 * §36). Production instances are never targeted.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { collectiveMetrics, runChaosTest, runOrgAnalyst } from "../src/core/org/intelligence";
import { runDoctor } from "../src/core/doctor";

describe("AOrgI Phase 4 (migration v27)", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });

  afterAll(() => {
    db.close();
  });

  it("computes collective metrics from real tables", () => {
    // Real convergence data: one negotiation, resolved at the round cap.
    const n = store.createOrgNegotiation({ topic: "Metrics probe" });
    store.addNegotiationRound(n.id, { kind: "PROPOSAL", role: "role_coa", content: "A" });
    store.addNegotiationRound(n.id, { kind: "CRITIQUE", role: "role_qa_verification", content: "No." });
    store.addNegotiationRound(n.id, { kind: "REVISION", role: "role_coa", content: "B" });
    store.arbitrateNegotiation(n.id, "B", "role_coa");
    // Real scalability data: one message tied to one completed task.
    const task = store.getTask("tsk_ztame_p8")!;
    store.sendOrgMessage({ fromRole: "role_coa", toRole: "role_qa_verification", type: "REQUEST", taskId: task.id });

    const m = collectiveMetrics(store);
    expect(m.convergence.negotiationsTotal).toBe(1);
    expect(m.convergence.resolved).toBe(1);
    expect(m.convergence.avgRoundsToResolve).toBe(3);
    expect(m.convergence.cappedDebates).toBe(1);
    expect(m.scalability.messagesTotal).toBe(1);
    expect(m.robustness.chaosTestsTotal).toBe(0);
    expect(m.objectiveAchievement.proxyDivergence).toBeNull(); // honest null
  });

  it("analyst run writes observations and recommendations", () => {
    const report = runOrgAnalyst(store, "test");
    expect(report.trigger).toBe("test");
    const obs = JSON.parse(report.observations_json);
    const recs = JSON.parse(report.recommendations_json);
    expect(obs.length).toBeGreaterThan(0);
    // No chaos drills yet — the analyst must recommend one (§35 robustness).
    expect(recs.some((r: string) => r.includes("chaos"))).toBe(true);
    expect(store.latestAnalystReport()!.id).toBe(report.id);
  });

  it("doctor enforces analyst freshness (§36)", async () => {
    // Fresh report exists → OK. Backdate it past the 26h window → WARN.
    let report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    let check = report.checks.find((c) => c.id === "org.analyst.fresh")!;
    expect(check.status).toBe("OK");

    const old = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE org_analyst_reports SET generated_at = ?").run(old);
    report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    check = report.checks.find((c) => c.id === "org.analyst.fresh")!;
    expect(check.status).toBe("WARN");
  });

  it("refuses to run chaos drills against production instances (§35)", () => {
    store.upsertOrgAgent({ id: "executive_do_01", roleId: "role_coa", kind: "cloud" });
    const outcome = runChaosTest(store, "agent_kill_sim", "executive_do_01");
    expect(outcome.status).toBe("REFUSED");
    expect(outcome.detail).toContain("never targeted");
    // The production instance is untouched.
    expect(store.getOrgAgent("executive_do_01")).toBeTruthy();
  });

  it("agent_kill_sim verifies fallback detection and leaves no residue", () => {
    store.upsertOrgAgent({
      id: "chaos_probe_01",
      roleId: "role_strategy_intelligence",
      kind: "cloud",
      source: "chaos",
    });
    const outcome = runChaosTest(store, "agent_kill_sim", "chaos_probe_01");
    expect(outcome.status).toBe("PASSED");
    // Probe cleaned up after the drill — no residue in the registry.
    expect(store.getOrgAgent("chaos_probe_01")).toBeNull();
    const tests = store.listChaosTests(10);
    expect(tests[0]!.kind).toBe("agent_kill_sim");
    expect(tests[0]!.status).toBe("PASSED");
  });

  it("grant_degrade verifies fail-closed denial and cleans up the probe grant", () => {
    store.upsertOrgAgent({
      id: "chaos_probe_02",
      roleId: "role_design_ux",
      kind: "cloud",
      source: "chaos",
    });
    const outcome = runChaosTest(store, "grant_degrade", "chaos_probe_02");
    expect(outcome.status).toBe("PASSED");
    // The temporary L0 grant is gone — nothing real was modified.
    const leftovers = store.listCapabilityGrants().filter((g) => g.capability === "__chaos_probe__");
    expect(leftovers.length).toBe(0);
  });

  it("rejects unknown chaos kinds", () => {
    const outcome = runChaosTest(store, "rm_rf_production", "whatever");
    expect(outcome.status).toBe("FAILED");
    expect(outcome.detail).toContain("Unknown chaos kind");
  });
});
