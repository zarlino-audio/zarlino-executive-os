import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createApprovalRequest } from "../src/core/approvals/queue";
import { runCeoCycle } from "../src/core/org/ceo";
import { DEFAULT_EXEC_MODEL, estimateNeurons } from "../src/integrations/workersai";

describe("CEO agent — autonomous decisions, founder-only escalation", () => {
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

  it("estimateNeurons uses the model rate table", () => {
    // llama-3.1-8b-fp8: 4119/M in + 25300/M out → 1000 in + 500 out ≈ 17 neurons
    expect(estimateNeurons("@cf/meta/llama-3.1-8b-instruct-fp8", 1000, 500)).toBe(17);
    // unknown model falls back to the default rate table (never throws)
    expect(estimateNeurons("@cf/unknown/model", 0, 0)).toBe(0);
  });

  it("the executive tier defaults to the Workers AI high tier", () => {
    expect(DEFAULT_EXEC_MODEL).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("registers itself, decides everything autonomously except the hard line, records everything", async () => {
    const benign = createApprovalRequest({
      action_label: "Update the internal docs index",
      reason: "Routine housekeeping",
      requested_by: "executive",
    });
    const deploy = createApprovalRequest({
      action_label: "Deploy ZTame 1.2 to production",
      reason: "Release the versioned build",
      requested_by: "executive",
    });
    const sensitive = createApprovalRequest({
      action_label: "Transfer the contractor payout from the business account",
      reason: "Monthly mastering invoice",
      requested_by: "executive",
    });
    store.insertApproval(benign);
    store.insertApproval(deploy);
    store.insertApproval(sensitive);

    // No AI binding and no WhatsApp config — both must degrade honestly.
    const result = await runCeoCycle(store, {}, "test");

    // CEO is a registered runtime instance with its own role.
    const ceo = store.getOrgAgent("ceo_agent_01");
    expect(ceo?.role_id).toBe("role_ceo");

    // The founder's replacement mandate: deploys/releases are decided
    // autonomously; only money/legal/credential/irreversible reach the founder.
    expect(result.decided.map((d) => d.id)).toContain(benign.id);
    expect(result.decided.map((d) => d.id)).toContain(deploy.id);
    expect(result.escalated.map((e) => e.id)).toContain(sensitive.id);
    expect(store.getApproval(benign.id)?.status).toBe("APPROVED");
    expect(store.getApproval(benign.id)?.decided_by).toBe("ceo_agent");
    expect(store.getApproval(deploy.id)?.status).toBe("APPROVED");
    expect(store.getApproval(sensitive.id)?.status).toBe("PENDING");

    // The escalation was recorded even though WhatsApp is unconfigured —
    // never silently dropped, never claimed as delivered. (The seeded pending
    // approval — the ZScorch gate — legitimately escalates as well.)
    const notes = store.listNotifications(10);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.status).toBe("QUEUED_UNCONFIGURED");
    expect(notes[0]!.subject ?? "").toContain("awaiting the founder");

    // The cycle itself is on record (report + audit), summary model honest.
    const reports = store.listCeoReports(10);
    expect(reports.length).toBe(1);
    expect(reports[0]!.summary_model ?? "").toBe("none");
    expect(reports[0]!.neurons_used ?? 0).toBe(0);
    expect(reports[0]!.summary ?? "").toContain("escalated=");
  });

  it("CEO_AUTO_APPROVE=off makes every approval wait for the founder", async () => {
    store.insertApproval(
      createApprovalRequest({ action_label: "Tidy the backlog labels", reason: "Cleanup", requested_by: "executive" }),
    );
    const result = await runCeoCycle(store, { CEO_AUTO_APPROVE: "off" }, "test");
    expect(result.decided.length).toBe(0);
    expect(result.escalated.length).toBeGreaterThan(0);

    // A second cycle must NOT re-nag the founder about items already escalated
    // in the last 24h — dedupe via the ceo.escalated audit trail.
    const again = await runCeoCycle(store, { CEO_AUTO_APPROVE: "off" }, "test");
    expect(again.escalated.length).toBe(0);
  });
});
