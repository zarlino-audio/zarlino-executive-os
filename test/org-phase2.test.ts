/**
 * AOrgI Phase 2 tests (migration v24) — organizational memory with optimistic
 * concurrency, PostObjectiveRecords, trust per agent × capability with decay,
 * inter-agent message contracts, and critic-lineage vote discounting.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { discountCorrelatedVotes } from "../src/core/org/voting";
import { runDoctor } from "../src/core/doctor";

describe("AOrgI Phase 2 (migration v24)", () => {
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

  describe("org_memory (§14 — versioned, never silently overwritten)", () => {
    it("writes a version-1 entry with provenance", () => {
      const entry = store.writeOrgMemory({
        key: "release_policy_decision",
        value: { rule: "Ship only after Gate 10", decidedBy: "founder" },
        author: "role_coa",
        taskId: "tsk_zscorch_gate10",
      });
      expect(entry.version).toBe(1);
      expect(entry.status).toBe("ACTIVE");
      expect(entry.author).toBe("role_coa");
      expect(entry.task_id).toBe("tsk_zscorch_gate10");
      expect(JSON.parse(entry.value_json).rule).toBe("Ship only after Gate 10");
    });

    it("conflicts on stale version instead of overwriting", () => {
      const entry = store.listOrgMemory({ limit: 10 }).find((m) => m.key === "release_policy_decision")!;
      // Writer A read version 1, wrote version 2.
      store.updateOrgMemory(entry.id, { value: { rule: "Ship only after Gate 10 + signing" }, expectedVersion: 1 });
      // Writer B still holds version 1 — must get a conflict, not a silent overwrite.
      const result = store.updateOrgMemory(entry.id, { value: { rule: "Ship immediately" }, expectedVersion: 1 });
      expect(result.status).toBe("conflict");
      expect(result.record!.version).toBe(2);
      expect(JSON.parse(result.record!.value_json).rule).toContain("signing");
      // Nothing changed.
      expect(store.getOrgMemory(entry.id)!.version).toBe(2);
    });

    it("updates cleanly when the read version matches", () => {
      const entry = store.listOrgMemory({ limit: 10 }).find((m) => m.key === "release_policy_decision")!;
      const result = store.updateOrgMemory(entry.id, { value: { rule: "v3" }, expectedVersion: entry.version });
      expect(result.status).toBe("updated");
      expect(result.record!.version).toBe(entry.version + 1);
    });

    it("supersedes entries with a version link instead of deleting history", () => {
      const old = store.writeOrgMemory({ key: "qt_release", value: { verdict: "approve" } });
      const next = store.writeOrgMemory({ key: "qt_release", value: { verdict: "reject" }, supersedes: old.id });
      expect(next.supersedes).toBe(old.id);
      const history = store.listOrgMemory({ includeSuperseded: true, limit: 20 }).filter((m) => m.key === "qt_release");
      expect(history.some((m) => m.id === old.id && m.status === "SUPERSEDED")).toBe(true);
      expect(store.listOrgMemory({ limit: 20 }).filter((m) => m.key === "qt_release").length).toBe(1);
    });
  });

  describe("post_objective_records (§38)", () => {
    it("creates and finds a PostObjectiveRecord", () => {
      const now = new Date().toISOString();
      store.createPostObjectiveRecord({
        id: "por_test_01",
        objective_id: "obj_01",
        outcome: "SHIPPED",
        expected_outcome: "Ship commercially",
        actual_outcome: "Two plugins live",
        successful_roles_json: '["role_dsp_engineering"]',
        failed_roles_json: "[]",
        bottlenecks_json: "[]",
        incidents_json: "[]",
        useful_workflows_json: "[]",
        unnecessary_work_json: "[]",
        decisions_json: "[]",
        deviations_json: "[]",
        trust_updates_json: "[]",
        lessons_json: '["A/B tests must precede release decisions"]',
        topology_changes_json: "[]",
        policy_changes_json: "[]",
        source: "test",
        created_at: now,
        updated_at: now,
      });
      expect(store.hasPostObjectiveRecord("obj_01")).toBe(true);
      expect(store.listPostObjectiveRecords().some((r) => r.id === "por_test_01")).toBe(true);
    });
  });

  describe("org_trust (§21 — per capability, evidence-based, decaying)", () => {
    it("moves with evidence and counts it", () => {
      store.recordTrustEvidence("local_daemon_01", "local_execution", true);
      store.recordTrustEvidence("local_daemon_01", "local_execution", true);
      const row = store.listOrgTrust().find((t) => t.agent_id === "local_daemon_01" && t.capability === "local_execution")!;
      expect(row.evidence_count).toBe(2);
      expect(row.value).toBeGreaterThan(0.5); // two successes moved it up
      // Failure moves it back down — evidence, not reputation.
      store.recordTrustEvidence("local_daemon_01", "local_execution", false);
      const after = store.listOrgTrust().find((t) => t.agent_id === "local_daemon_01" && t.capability === "local_execution")!;
      expect(after.value).toBeLessThan(row.value);
    });

    it("decays stale trust toward zero effective value", () => {
      const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE org_trust SET value = 0.99, last_updated = ? WHERE agent_id = 'local_daemon_01' AND capability = 'local_execution'").run(longAgo);
      const row = store.listOrgTrust().find((t) => t.agent_id === "local_daemon_01" && t.capability === "local_execution")!;
      expect(row.effective_value).toBeLessThan(0.01); // ~400 days ≫ 30-day half-life
    });
  });

  describe("org_messages (§16 — typed contracts, not chat)", () => {
    it("accepts core message types and rejects invented ones", () => {
      const ok = store.sendOrgMessage({ fromRole: "role_qa_verification", toRole: "role_coa", type: "ESCALATION", taskId: "tsk_ztame_p8", payload: { blocker: true } });
      expect("error" in ok).toBe(false);
      const bad = store.sendOrgMessage({ fromRole: "x", toRole: "y", type: "CHIT_CHAT" });
      expect("error" in bad).toBe(true);
    });

    it("lists and filters by type", () => {
      store.sendOrgMessage({ fromRole: "role_coa", toRole: "role_dsp_engineering", type: "REQUEST", taskId: "tsk_a" });
      // Filter to the P8 escalation specifically — the memory-conflict test
      // above also emits a (governance) ESCALATION, by design (§14).
      const escalations = store.listOrgMessages({ type: "ESCALATION", limit: 20 });
      const p8 = escalations.filter((m) => m.task_id === "tsk_ztame_p8");
      expect(p8.length).toBe(1);
      expect(p8[0]!.task_id).toBe("tsk_ztame_p8");
      const all = store.listOrgMessages({ limit: 50 });
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("critic-lineage discounting (§20)", () => {
    it("discounts correlated same-lineage votes", () => {
      // Two same-lineage approvers vs one independent rejecter: raw majority
      // says APPROVE, but the correlated pair must not overwhelm the lone
      // independent vote — root-n discounting pulls the score toward 0.
      const votes = [
        { agentId: "a1", lineageId: "lineage_dsp_engineering", verdict: 1 as const, confidence: 1 },
        { agentId: "a2", lineageId: "lineage_dsp_engineering", verdict: 1 as const, confidence: 1 },
        { agentId: "b1", lineageId: "lineage_qa_verification", verdict: -1 as const, confidence: 1 },
      ];
      const result = discountCorrelatedVotes(votes);
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(0.25); // discounted: 2 correlated votes ≈ 1.41 independent
      expect(result.lineageWeights.find((w) => w.lineageId === "lineage_dsp_engineering")!.weight).toBeCloseTo(1 / Math.sqrt(2));
    });

    it("marks a balanced cross-lineage vote DIVERGED", () => {
      const result = discountCorrelatedVotes([
        { agentId: "a1", lineageId: "l1", verdict: 1, confidence: 1 },
        { agentId: "b1", lineageId: "l2", verdict: -1, confidence: 1 },
      ]);
      expect(result.verdict).toBe("DIVERGED");
    });
  });

  describe("doctor org.post_objective (§38 obligation)", () => {
    it("warns when a completed objective lacks a PostObjectiveRecord, then clears", async () => {
      const now = new Date().toISOString();
      store.insertObjective({
        id: "obj_completed_test", title: "Test completed objective", status: "COMPLETED",
        priority: 9, source: "test", created_at: now, updated_at: now,
      });
      let report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
      let check = report.checks.find((c) => c.id === "org.post_objective")!;
      expect(check.status).toBe("WARN");
      expect(check.detail).toContain("obj_completed_test");

      store.createPostObjectiveRecord({
        id: "por_test_02", objective_id: "obj_completed_test", outcome: "DONE",
        successful_roles_json: "[]", failed_roles_json: "[]", bottlenecks_json: "[]",
        incidents_json: "[]", useful_workflows_json: "[]", unnecessary_work_json: "[]",
        decisions_json: "[]", deviations_json: "[]", trust_updates_json: "[]",
        lessons_json: "[]", topology_changes_json: "[]", policy_changes_json: "[]",
        source: "test", created_at: now, updated_at: now,
      });
      report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
      check = report.checks.find((c) => c.id === "org.post_objective")!;
      expect(check.status).toBe("OK");
    });
  });
});
