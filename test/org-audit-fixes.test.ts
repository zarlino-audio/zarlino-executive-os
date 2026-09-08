/**
 * AOrgI Phases 1–3 audit-fix tests (migration v26).
 *
 * Closes the gaps found in the phase review: structured reasoning traces
 * (§13), prompt_lineage_id on manifests (§9/§20), BLOCK→LOG→ESCALATE
 * completeness (§11), memory-conflict escalation (§14), task-contract
 * enforcement for substantial tasks (§18), and negotiation stall alerts (§23).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { runDoctor } from "../src/core/doctor";

describe("AOrgI phases 1-3 audit fixes (migration v26)", () => {
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

  it("adds prompt_lineage_id to every role manifest (§9/§20)", () => {
    for (const role of store.listOrgRoles()) {
      expect(role.prompt_lineage_id, `role ${role.id}`).toBe(role.lineage_id);
    }
  });

  it("records a reasoning trace when a negotiation is arbitrated (§13)", () => {
    const n = store.createOrgNegotiation({ topic: "Which filter topology?", taskId: "tsk_test_trace" });
    store.addNegotiationRound(n.id, { kind: "PROPOSAL", role: "role_dsp_engineering", content: "Use an SVF." });
    store.addNegotiationRound(n.id, { kind: "CRITIQUE", role: "role_qa_verification", content: "SVF is unstable at 48kHz." });
    store.addNegotiationRound(n.id, { kind: "REVISION", role: "role_dsp_engineering", content: "Biquad ladder instead." });
    store.arbitrateNegotiation(n.id, "USE BIQUAD LADDER", "role_product_architect");

    const traces = store.listReasoningTraces({ taskId: "tsk_test_trace" });
    expect(traces.length).toBe(1);
    const trace = traces[0]!;
    expect(trace.agent_id).toBe("role_product_architect");
    expect(trace.mode).toBe("arbitration");
    expect(trace.final_action).toBe("USE BIQUAD LADDER");
    expect(trace.trace_visibility).toBe("internal");
    const evidence = JSON.parse(trace.evidence_json);
    expect(evidence.length).toBe(3); // the actual rounds, nothing invented
    expect(evidence[0].kind).toBe("PROPOSAL");
  });

  it("escalates memory version conflicts to the governance arbiter (§14)", () => {
    const entry = store.writeOrgMemory({ key: "conflict_key", value: { v: 1 }, author: "role_coa" });
    store.updateOrgMemory(entry.id, { value: { v: 2 }, expectedVersion: 1 });
    // Stale writer now conflicts — must produce an ESCALATION to governance.
    const result = store.updateOrgMemory(entry.id, { value: { v: 999 }, expectedVersion: 1 });
    expect(result.status).toBe("conflict");
    const escalations = store.listOrgMessages({ type: "ESCALATION", limit: 20 });
    const conflictEscalation = escalations.find((m) => m.payload_json.includes("conflict_key") || m.payload_json.includes(entry.id));
    expect(conflictEscalation).toBeTruthy();
    expect(conflictEscalation!.to_role).toBe("role_finance_governance");
    expect(JSON.parse(conflictEscalation!.payload_json).currentVersion).toBe(2);
  });

  it("doctor flags substantial tasks without a full contract (§18)", async () => {
    const report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    const check = report.checks.find((c) => c.id === "org.task_contracts")!;
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("tsk_zscorch_gate10"); // P1, uncontracted
    expect(check.detail).toContain("tsk_ztame_signing"); // P1, uncontracted
    expect(check.detail).not.toContain("tsk_ztame_p8"); // has a full contract

    // Contract one of them — it must disappear from the warning.
    store.setTaskContract("tsk_zscorch_gate10", {
      acceptance_criteria: "Founder approves or rejects the ZScorch release decision.",
      verification_role_id: "role_qa_verification",
    });
    const report2 = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    const check2 = report2.checks.find((c) => c.id === "org.task_contracts")!;
    expect(check2.detail).not.toContain("tsk_zscorch_gate10");
    expect(check2.detail).toContain("tsk_ztame_signing");
  });

  it("doctor flags negotiations stalled at the arbitration stage (§23)", async () => {
    const n = store.createOrgNegotiation({ topic: "Stalled test" });
    store.addNegotiationRound(n.id, { kind: "PROPOSAL", role: "role_coa", content: "A" });
    store.addNegotiationRound(n.id, { kind: "CRITIQUE", role: "role_qa_verification", content: "No." });
    store.addNegotiationRound(n.id, { kind: "REVISION", role: "role_coa", content: "B" });
    expect(store.getOrgNegotiation(n.id)!.status).toBe("ARBITRATED");

    let report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    let check = report.checks.find((c) => c.id === "org.negotiations_stale")!;
    expect(check.status).toBe("OK"); // fresh — not stalled yet

    // Backdate beyond the 24h arbitration stall threshold.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE org_negotiations SET updated_at = ? WHERE id = ?").run(old, n.id);
    report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    check = report.checks.find((c) => c.id === "org.negotiations_stale")!;
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain(n.id);

    // Arbitration clears the stall.
    store.arbitrateNegotiation(n.id, "B WINS", "role_coa");
    report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    check = report.checks.find((c) => c.id === "org.negotiations_stale")!;
    expect(check.status).toBe("OK");
  });
});
