/**
 * AOrgI Phase 3 tests (migration v25) — capability governance (fail-closed),
 * hierarchical plans with deviation events, negotiation with hard round caps,
 * and explicit arbitration.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { capabilityVerdictForRole, evaluateGrant } from "../src/core/org/governance";
import { arbiterForClass, negotiationPhase } from "../src/core/org/negotiation";
import { runDoctor } from "../src/core/doctor";
import type { OrgCapabilityGrant } from "../src/types";

function grant(over: Partial<OrgCapabilityGrant>): OrgCapabilityGrant {
  const now = new Date().toISOString();
  return {
    id: "g1", role_id: "r1", capability: "read", allowed_actions_json: '["*"]',
    autonomy_level: "L2", requires_review: 0, source: "test",
    created_at: now, updated_at: now, ...over,
  };
}

describe("AOrgI Phase 3 (migration v25)", () => {
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

  describe("capability governance (§10, §12)", () => {
    it("seeds grants for every active role (fail-closed coverage)", () => {
      expect(store.listRolesWithoutCapabilityGrants()).toEqual([]);
      expect(store.listCapabilityGrants().length).toBeGreaterThanOrEqual(24);
    });

    it("evaluates autonomy levels correctly", () => {
      expect(evaluateGrant(grant({ autonomy_level: "L0" }), "read").verdict).toBe("DENY");
      expect(evaluateGrant(grant({ autonomy_level: "L1" }), "read").verdict).toBe("REVIEW");
      expect(evaluateGrant(grant({ autonomy_level: "L2" }), "read").verdict).toBe("ALLOW");
      expect(evaluateGrant(grant({ autonomy_level: "L2", allowed_actions_json: '["write"]' }), "read").verdict).toBe("REVIEW");
      expect(evaluateGrant(grant({ autonomy_level: "L3" }), "read").verdict).toBe("ALLOW");
      // requires_review wins over autonomy.
      expect(evaluateGrant(grant({ autonomy_level: "L3", requires_review: 1 }), "read").verdict).toBe("REVIEW");
    });

    it("is fail-closed: exact grant, wildcard, then DENY", () => {
      const wildcard = grant({ capability: "*" });
      const none: OrgCapabilityGrant[] = [];
      expect(capabilityVerdictForRole([wildcard], "modify", "edit").verdict).toBe("ALLOW");
      expect(capabilityVerdictForRole(none, "modify", "edit").verdict).toBe("DENY");
      // Exact restrictive grant overrides the wildcard.
      const spendL0 = grant({ capability: "spend", autonomy_level: "L0" });
      expect(capabilityVerdictForRole([wildcard, spendL0], "spend", "pay").verdict).toBe("DENY");
    });

    it("resolves the registered agent instance through its role", () => {
      store.upsertOrgAgent({ id: "executive_do_01", roleId: "role_coa", kind: "cloud" });
      expect(store.capabilityVerdictForAgent("executive_do_01", "read", "list").verdict).toBe("ALLOW"); // wildcard L2
      expect(store.capabilityVerdictForAgent("executive_do_01", "spend", "pay").verdict).toBe("DENY"); // L0 founder-gated
      const unknown = store.capabilityVerdictForAgent("ghost", "read", "list");
      expect(unknown.verdict).toBe("DENY");
    });

    it("upserts grants and validates autonomy levels", () => {
      const g = store.upsertCapabilityGrant({ roleId: "role_coa", capability: "external", autonomyLevel: "L1" });
      expect(g.autonomy_level).toBe("L1");
      const g2 = store.upsertCapabilityGrant({ roleId: "role_coa", capability: "external", autonomyLevel: "L2", requiresReview: true });
      expect(g2.id).toBe(g.id); // updated in place
      expect(g2.requires_review).toBe(1);
      expect(() => store.upsertCapabilityGrant({ roleId: "x", capability: "y", autonomyLevel: "L9" })).toThrow();
    });
  });

  describe("hierarchical plans (§19)", () => {
    it("creates plans with versions and records every change as a deviation", () => {
      const plan = store.createOrgPlan({ objectiveId: "obj_01", title: "Ship ZVocals", ownerRole: "role_coa" });
      expect(plan.version).toBe(1);
      const revised = store.reviseOrgPlan(plan.id, { title: "Ship ZVocals v0.2", description: "Scope reduced after founder review" })!;
      expect(revised.version).toBe(2);
      const deviations = store.listOrgPlanDeviations(plan.id);
      expect(deviations.length).toBe(1);
      expect(deviations[0]!.kind).toBe("revision");
    });

    it("sequences steps, blocks with a deviation event, and links tasks", () => {
      const plan = store.createOrgPlan({ title: "P8 retest plan", ownerRole: "role_coa" });
      const s1 = store.addOrgPlanStep(plan.id, { title: "Render A/B set", ownerRole: "role_dsp_engineering" })!;
      const s2 = store.addOrgPlanStep(plan.id, { title: "Founder listens", ownerRole: "role_qa_verification", dependencies: [s1.id] })!;
      expect(s2.seq).toBeGreaterThan(s1.seq);
      expect(JSON.parse(s2.dependencies_json)).toEqual([s1.id]);

      const blocked = store.updateOrgPlanStepStatus(s1.id, "BLOCKED")!;
      expect(blocked.status).toBe("BLOCKED");
      expect(store.listOrgPlanDeviations(plan.id).some((d) => d.kind === "blocker")).toBe(true);

      const task = store.linkTaskToPlanStep("tsk_ztame_p8", plan.id, s1.id)!;
      expect(task.plan_id).toBe(plan.id);
      expect(task.plan_step_id).toBe(s1.id);
      expect(store.linkTaskToPlanStep("tsk_ztame_p8", plan.id, "missing_step")).toBeNull();
      expect(store.linkTaskToPlanStep("missing_task", plan.id, s1.id)).toBeNull();
    });
  });

  describe("negotiation + arbitration (§22, §23)", () => {
    it("phases proceed PROPOSAL → CRITIQUE → REVISION then force arbitration", () => {
      expect(negotiationPhase(0, 3)).toBe("PROPOSAL");
      expect(negotiationPhase(1, 3)).toBe("CRITIQUE");
      expect(negotiationPhase(2, 3)).toBe("REVISION");
      expect(negotiationPhase(3, 3)).toBe("ARBITRATE");
    });

    it("enforces phase kinds and the hard round cap, then arbitrates", () => {
      const n = store.createOrgNegotiation({ topic: "ZTame P8: pump or remap?", taskId: "tsk_ztame_p8" });
      expect(n.max_rounds).toBe(3);

      // Round 1 must be a PROPOSAL — a CRITIQUE is rejected.
      expect(store.addNegotiationRound(n.id, { kind: "CRITIQUE", role: "role_qa_verification", content: "Too early." }).ok).toBe(false);
      const r1 = store.addNegotiationRound(n.id, { kind: "PROPOSAL", role: "role_dsp_engineering", content: "Add peak-hold smoothing." });
      expect(r1.ok).toBe(true);
      const r2 = store.addNegotiationRound(n.id, { kind: "CRITIQUE", role: "role_qa_verification", content: "Smoothing adds latency." });
      expect(r2.ok).toBe(true);
      const r3 = store.addNegotiationRound(n.id, { kind: "REVISION", role: "role_dsp_engineering", content: "Peak-hold with 5ms lookahead." });
      expect(r3.ok).toBe(true);
      expect(r3.ok && r3.negotiation.status).toBe("ARBITRATED"); // round cap hit

      // No infinite debate: further rounds are rejected.
      expect(store.addNegotiationRound(n.id, { kind: "REVISION", role: "x", content: "More." }).ok).toBe(false);

      const resolved = store.arbitrateNegotiation(n.id, "REMOVE SELECTIVITY OVERLAP", "role_product_architect")!;
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.verdict).toContain("SELECTIVITY");
      expect(store.arbitrateNegotiation(n.id, "again", "role_x")).toBeNull(); // already resolved
    });

    it("maps disagreement classes to explicit arbiters (§23)", () => {
      const rules = store.listOrgArbiters();
      expect(arbiterForClass(rules as never, "technical").arbiterRoleId).toBe("role_product_architect");
      expect(arbiterForClass(rules as never, "quality").arbiterRoleId).toBe("role_qa_verification");
      expect(arbiterForClass(rules as never, "cross_functional").arbiterRoleId).toBe("role_coa");
      expect(arbiterForClass(rules as never, "strategic").arbiterKind).toBe("human_ceo");
      expect(arbiterForClass(rules as never, "unknown_class").arbiterRoleId).toBe("role_coa"); // cross-functional fallback
    });
  });

  describe("doctor org.capability.coverage", () => {
    it("passes when every active role is covered and fails on a gap", async () => {
      let report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
      let check = report.checks.find((c) => c.id === "org.capability.coverage")!;
      expect(check.status).toBe("OK");

      // An uncovered role: grant-less → its instances would be fully blocked.
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO org_roles (id, name, department_id, lineage_id, model, scope, responsibilities_json, obligations_json, capabilities_json, default_autonomy, critic_role_id, escalation_threshold, version, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 'L1', NULL, '', 1, 'ACTIVE', 'test', ?, ?)",
      ).run("role_uncovered_test", "Uncovered Test Role", "dept_engineering", "lineage_test", "", "", now, now);

      report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
      check = report.checks.find((c) => c.id === "org.capability.coverage")!;
      expect(check.status).toBe("FAIL");
      expect(check.detail).toContain("role_uncovered_test");

      db.prepare("DELETE FROM org_roles WHERE id = 'role_uncovered_test'").run();
    });
  });
});
