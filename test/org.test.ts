/**
 * AOrgI organizational registry tests (migration v23).
 *
 * Verifies the honest, non-theatrical part of the artificial organization:
 *   - departments + role manifests are seeded and internally consistent,
 *   - agent instances exist ONLY after a real runtime registers (no theater),
 *   - heartbeats refresh liveness without losing started_at,
 *   - task contracts carry acceptance criteria + independent verification,
 *   - the System Doctor audits registry coherence.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { runDoctor } from "../src/core/doctor";

describe("AOrgI org registry (migration v23)", () => {
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

  it("seeds 6 departments including an independent VERIFICATION silo", () => {
    const depts = store.listDepartments();
    expect(depts.length).toBe(6);
    const names = depts.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["Executive", "Product", "Engineering", "Verification", "Commercial", "Control"]));
    // QA independence (§24): Verification is its own department, not under Engineering.
    const qa = store.listOrgRoles().find((r) => r.id === "role_qa_verification");
    expect(qa?.department_id).toBe("dept_verification");
  });

  it("seeds the 12 role manifests with valid department and critic references", () => {
    const roles = store.listOrgRoles();
    expect(roles.length).toBe(12);
    const deptIds = new Set(store.listDepartments().map((d) => d.id));
    for (const role of roles) {
      expect(deptIds.has(role.department_id), `role ${role.id} references missing department ${role.department_id}`).toBe(true);
      expect(role.lineage_id.startsWith("lineage_")).toBe(true);
      expect(["L0", "L1", "L2", "L3"]).toContain(role.default_autonomy);
      if (role.critic_role_id) {
        expect(store.getOrgRole(role.critic_role_id), `role ${role.id} critic missing`).toBeTruthy();
      }
    }
    // Independent verification relationship: engineering is verified by QA.
    expect(store.getOrgRole("role_dsp_engineering")?.critic_role_id).toBe("role_qa_verification");
    expect(store.getOrgRole("role_software_engineering")?.critic_role_id).toBe("role_qa_verification");
  });

  it("registers NO agent instances from seed alone (instances ≠ roles, §7/§42)", () => {
    expect(store.listOrgAgents().length).toBe(0);
  });

  it("registers a runtime instance on first heartbeat and preserves started_at", async () => {
    store.upsertOrgAgent({
      id: "executive_do_01",
      roleId: "role_coa",
      kind: "cloud",
      model: "deepseek-v4",
      capabilitiesJson: JSON.stringify(["planning"]),
    });
    const first = store.getOrgAgent("executive_do_01")!;
    expect(first.status).toBe("ACTIVE");
    expect(first.started_at).toBeTruthy();
    expect(first.last_seen).toBeTruthy();

    // Re-heartbeat must refresh last_seen but never rewrite started_at.
    await new Promise((r) => setTimeout(r, 5));
    store.upsertOrgAgent({ id: "executive_do_01", roleId: "role_coa", kind: "cloud" });
    const second = store.getOrgAgent("executive_do_01")!;
    expect(second.started_at).toBe(first.started_at);
    expect(second.last_seen! >= first.last_seen!).toBe(true);
    expect(second.capabilities_json).toBe(first.capabilities_json); // preserved
  });

  it("writes the first real task contract (tsk_ztame_p8) through the migration", () => {
    const contract = store.getTaskContract("tsk_ztame_p8");
    expect(contract).toBeTruthy();
    expect(contract!.acceptance_criteria).toContain("A/B listening");
    expect(contract!.verification_role_id).toBe("role_qa_verification");
    expect(contract!.autonomy_level).toBe("L2");
    expect(contract!.escalation_path).toContain("founder");
  });

  it("updates task contracts via setTaskContract and lists contracted tasks", () => {
    const updated = store.setTaskContract("tsk_zscorch_gate10", {
      acceptance_criteria: "Founder approves or rejects the ZScorch v1.0.0 release decision.",
      verification_role_id: "role_qa_verification",
      deadline_at: "2026-09-30T00:00:00.000Z",
      escalation_path: "founder",
    });
    expect(updated).toBeTruthy();
    const contracts = store.listTaskContracts();
    expect(contracts.some((t) => t.id === "tsk_zscorch_gate10")).toBe(true);
    // A task without a contract must not appear as one.
    expect(contracts.some((t) => t.id === "tsk_zscorch_signing")).toBe(false);
    // Unknown task id → null, not an exception.
    expect(store.setTaskContract("tsk_does_not_exist", { acceptance_criteria: "x" })).toBeNull();
  });

  it("Doctor org.registry check passes on a coherent, fresh registry", async () => {
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "org.registry")!;
    expect(check.status).toBe("OK");
    expect(check.detail).toContain("12 role manifests");
  });

  it("Doctor org.registry check warns when a registered instance stops heartbeating", async () => {
    store.upsertOrgAgent({
      id: "ghost_agent_01",
      roleId: "role_strategy_intelligence",
      kind: "cloud",
    });
    // Simulate a dead instance: no heartbeat for 3 days.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE org_agents SET last_seen = ? WHERE id = 'ghost_agent_01'").run(threeDaysAgo);

    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "org.registry")!;
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("ghost_agent_01");
  });
});
