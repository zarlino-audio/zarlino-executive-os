/**
 * AOrgI Phase 5 tests (migration v29) — autonomous topology optimization:
 * proposals are evidence-backed, idempotent, human-decided, and APPLIED only
 * when reality confirms them (§33). Never a silent headcount change.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { applyTopologyDetection, pendingWorkByRole, proposeTopology } from "../src/core/org/topology";
import { runOrgAnalyst } from "../src/core/org/intelligence";

describe("AOrgI Phase 5 (migration v29)", () => {
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

  it("detects roles with pending work and zero live instances", () => {
    // role_product_architect: no instance + an open plan step it owns.
    const plan = store.createOrgPlan({ title: "P5 probe plan", ownerRole: "role_coa" });
    store.addOrgPlanStep(plan.id, { title: "Architect reviews topology", ownerRole: "role_product_architect" });
    // role_qa_verification: no instance + tsk_ztame_p8 needs its verification.
    const evidence = pendingWorkByRole(store);
    const arch = evidence.find((e) => e.roleId === "role_product_architect");
    const qa = evidence.find((e) => e.roleId === "role_qa_verification");
    expect(arch?.planSteps).toBe(1);
    expect(qa?.tasksToVerify).toBeGreaterThanOrEqual(1);

    // A role WITH a live instance must never appear.
    store.upsertOrgAgent({ id: "executive_do_01", roleId: "role_coa", kind: "cloud" });
    expect(pendingWorkByRole(store).some((e) => e.roleId === "role_coa")).toBe(false);
  });

  it("proposes instantiate for uncovered roles, idempotently", () => {
    const first = proposeTopology(store);
    expect(first.some((p) => p.kind === "instantiate" && p.role_id === "role_product_architect")).toBe(true);
    expect(first.some((p) => p.kind === "instantiate" && p.role_id === "role_qa_verification")).toBe(true);
    const second = proposeTopology(store);
    expect(second.length).toBe(0); // no duplicates while proposals are open
  });

  it("proposes replication when the local queue outpaces one daemon (§32)", () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      store.createLocalTask({
        id: `lt_queue_${i}`,
        prompt: "queue depth probe",
        status: "PENDING",
        claimed_by: undefined,
        source: "test",
        created_at: now,
        updated_at: now,
      });
    }
    const proposals = proposeTopology(store);
    expect(proposals.some((p) => p.kind === "replicate" && p.role_id === "role_software_engineering")).toBe(true);
  });

  it("APPROVED proposals become APPLIED only when a real runtime registers", () => {
    const open = store
      .listTopologyProposals({ limit: 100 })
      .find((p) => p.kind === "instantiate" && p.role_id === "role_product_architect")!;
    store.updateTopologyProposal(open.id, { status: "APPROVED", decidedBy: "founder" });
    // Approval alone is NOT applied — no runtime exists yet.
    expect(applyTopologyDetection(store)).toEqual([]);
    expect(store.getTopologyProposal(open.id)!.status).toBe("APPROVED");
    // Reality confirms: a runtime registers for the role.
    store.upsertOrgAgent({ id: "architect_instance_01", roleId: "role_product_architect", kind: "cloud" });
    const applied = applyTopologyDetection(store);
    expect(applied).toContain(open.id);
    const after = store.getTopologyProposal(open.id)!;
    expect(after.status).toBe("APPLIED");
    expect(after.decided_by).toBe("runtime");
  });

  it("founder can reject proposals, recorded with the decision", () => {
    const open = store
      .listTopologyProposals({ limit: 100 })
      .find((p) => p.kind === "instantiate" && p.role_id === "role_qa_verification")!;
    const rejected = store.updateTopologyProposal(open.id, { status: "REJECTED", decidedBy: "founder" })!;
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.decided_by).toBe("founder");
    expect(rejected.decided_at).toBeTruthy();
  });

  it("analyst records topology observations in its report", () => {
    // Clear open proposals so new ones generate; then run the analyst.
    db.prepare("DELETE FROM org_topology_proposals WHERE status IN ('PROPOSED','APPROVED')").run();
    const report = runOrgAnalyst(store, "test");
    const obs = JSON.parse(report.observations_json);
    expect(obs.some((o: string) => o.includes("Topology (§33)"))).toBe(true);
    const recs = JSON.parse(report.recommendations_json);
    expect(recs.some((r: string) => r.includes("topology proposals"))).toBe(true);
  });
});
