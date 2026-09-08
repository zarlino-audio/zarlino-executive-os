import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
import { createApprovalRequest } from "../src/core/approvals/queue";

describe("ExecutiveStore (node:sqlite)", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
  });

  afterAll(() => {
    db.close();
  });

  it("runs all migrations, then is idempotent", () => {
    const first = store.migrate();
    expect(first.length).toBeGreaterThan(0);
    expect(first[first.length - 1]!).toBeGreaterThanOrEqual(17);
    const again = store.migrate();
    expect(again.length).toBe(0);
  });

  it("seeds products, pipeline gates, doctrine and baseline finance", () => {
    const products = store.listProducts();
    expect(products.length).toBeGreaterThanOrEqual(2);
    expect(products.some((p) => p.name === "ZScorch")).toBe(true);
    const gates = store.listPipelineGates();
    expect(gates.length).toBeGreaterThanOrEqual(20); // 2 plugins × 10 gates
    const doctrine = store.listActiveDoctrine();
    expect(doctrine.length).toBeGreaterThanOrEqual(4);
    expect(store.latestSnapshot()).not.toBeNull();
  });

  it("creates, updates, and lists tasks", () => {
    const task = createTask({ title: "Test task", priority: "P1", source: "test" });
    store.insertTask(task);
    expect(store.getTask(task.id)?.title).toBe("Test task");
    store.updateTask(task.id, { status: "IN_PROGRESS" } as never);
    expect(store.getTask(task.id)?.status).toBe("IN_PROGRESS");
    expect(store.countOpenTasks()).toBeGreaterThanOrEqual(1);
  });

  it("creates approval requests and lists pending", () => {
    const appr = createApprovalRequest({ action_label: "Approve test", reason: "testing", source: "test" });
    store.insertApproval(appr);
    expect(store.listApprovals({ status: "PENDING" }).some((a) => a.id === appr.id)).toBe(true);
  });

  it("maintenance reaps stale runs, expired leases, and expired sessions", () => {
    const now = new Date().toISOString();
    store.createAgentRun({
      id: "run_stale", prompt: "x", status: "RUNNING", iterations: 0, tools_called: 0,
      started_at: now, source: "test", created_at: now, updated_at: now,
      last_heartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const stale = store.reapStaleAgentRuns(1000);
    expect(stale).toContain("run_stale");

    store.createLocalTask({
      id: "lt_lease", prompt: "y", status: "CLAIMED", claimed_by: "ghost", source: "test",
      created_at: now, updated_at: now,
      lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const reaped = store.reapExpiredLocalTasks();
    expect(reaped).toContain("lt_lease");
    expect(store.getLocalTask("lt_lease")?.status).toBe("PENDING");

    store.createSession({ token: "tok_exp", username: "founder", expires_at: new Date(Date.now() - 1000).toISOString() });
    // getSession reads the row regardless of expiry; the sweep deletes it.
    expect(store.getSession("tok_exp")).not.toBeNull();
    store.deleteExpiredSessions();
    expect(store.getSession("tok_exp")).toBeNull();
  });

  it("records tool executions idempotently (upsert on same id)", () => {
    const rec = {
      id: "tex_1", tool_name: "test.tool", input_json: "{}", permission: "read" as const,
      verdict: "APPROVED", status: "RUNNING" as const, reversible: 1, source: "test", created_at: new Date().toISOString(),
    };
    store.recordToolExecution(rec);
    store.recordToolExecution({ ...rec, status: "SUCCESS", output_json: "{}" });
    const list = store.listToolExecutions();
    expect(list.filter((t) => t.id === "tex_1")).toHaveLength(1);
    expect(list.find((t) => t.id === "tex_1")?.status).toBe("SUCCESS");
  });

  it("exports and re-imports a snapshot", () => {
    const snap = store.exportSnapshot();
    expect(Array.isArray(snap.tasks)).toBe(true);
    expect(Array.isArray(snap.pipeline_gates)).toBe(true);
    const result = store.importSnapshot(snap);
    expect(result.tables).toBeGreaterThan(0);
    expect(result.rows).toBeGreaterThan(0);
  });

  it("local task claim lease round-trips", () => {
    store.createLocalTask({
      id: "lt_claim", prompt: "do work", status: "PENDING", source: "test",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // claimLocalTask claims the OLDEST pending task — lt_lease (re-queued by
    // the maintenance test) precedes lt_claim, so claim until lt_claim.
    const first = store.claimLocalTask("daemon-a");
    expect(first?.status).toBe("CLAIMED");
    const claimed = store.claimLocalTask("daemon-a");
    expect(claimed?.id).toBe("lt_claim");
    expect(claimed?.status).toBe("CLAIMED");
    // A third claim should grab nothing (no PENDING tasks left).
    expect(store.claimLocalTask("daemon-b")).toBeNull();
  });

  it("requeues local tasks that finished with the tool-call limit, skipping 402s", () => {
    const now = new Date().toISOString();
    // DONE with the limit message (runTurn returns it instead of throwing).
    store.createLocalTask({
      id: "lt_limited", prompt: "long task", status: "DONE", result: "Reached the tool-call limit — please rephrase or narrow the task.",
      source: "test", created_at: now, updated_at: now,
    });
    // FAILED with the limit message in error.
    store.createLocalTask({
      id: "lt_limited2", prompt: "long task 2", status: "FAILED", error: "Reached the tool-call limit",
      source: "test", created_at: now, updated_at: now,
    });
    // DONE with a funding error — must NOT be requeued.
    store.createLocalTask({
      id: "lt_nomoney", prompt: "paywall", status: "FAILED", error: "DeepSeek HTTP 402: Insufficient Balance",
      source: "test", created_at: now, updated_at: now,
    });
    // DONE normally — must NOT be requeued.
    store.createLocalTask({
      id: "lt_ok", prompt: "fine", status: "DONE", result: "all good",
      source: "test", created_at: now, updated_at: now,
    });

    const ids = store.requeueLocalTasks();
    expect(ids).toContain("lt_limited");
    expect(ids).toContain("lt_limited2");
    expect(ids).not.toContain("lt_nomoney");
    expect(ids).not.toContain("lt_ok");
    expect(store.getLocalTask("lt_limited")?.status).toBe("PENDING");
    expect(store.getLocalTask("lt_limited")?.result).toBeNull();
    expect(store.getLocalTask("lt_nomoney")?.status).toBe("FAILED");
    expect(store.getLocalTask("lt_ok")?.status).toBe("DONE");
  });

  it("lists and resumes limit-reached (auto-continue) long-horizon runs", () => {
    const now = new Date().toISOString();
    store.createAgentRun({
      id: "run_limit", prompt: "long work", status: "STOPPED", iterations: 40, tools_called: 120,
      started_at: now, source: "system", created_at: now, updated_at: now,
      checkpoint_json: JSON.stringify([{ role: "system", content: "ctx" }, { role: "user", content: "long work" }]),
      error: "Hit the 40-iteration per-sweep limit — auto-continue scheduled.",
    });
    // A STOPPED run with a different reason must NOT be auto-resumed.
    store.createAgentRun({
      id: "run_halted", prompt: "x", status: "STOPPED", iterations: 3, tools_called: 5,
      started_at: now, source: "test", created_at: now, updated_at: now,
      error: "Stopped by founder",
    });
    expect(store.countLimitReachedRuns()).toBe(1);
    expect(store.listLimitReachedRuns(10).map((r) => r.id)).toContain("run_limit");
    expect(store.listLimitReachedRuns(10).map((r) => r.id)).not.toContain("run_halted");
    const resumed = store.resetLimitReachedRuns(10);
    expect(resumed).toContain("run_limit");
    const run = store.getAgentRun("run_limit")!;
    expect(run.status).toBe("RUNNING");
    expect(run.last_heartbeat).toBeTruthy();
    expect(run.checkpoint_json).toBeTruthy(); // checkpoint preserved for continuation
  });

  it("deletes superseded restart-orphan runs and reports provider payment failures", () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Orphan whose task now has a newer RUNNING run → superseded, delete it.
    store.createAgentRun({
      id: "run_orphan_superseded", task_id: "tsk_a", prompt: "x", status: "FAILED", iterations: 0, tools_called: 0,
      started_at: old, source: "system", created_at: old, updated_at: old,
      error: "Interrupted by a restart — use Continue to resume from the checkpoint.",
    });
    store.createAgentRun({
      id: "run_newer", task_id: "tsk_a", prompt: "x", status: "RUNNING", iterations: 5, tools_called: 10,
      started_at: now, source: "system", created_at: now, updated_at: now, last_heartbeat: now,
    });
    // Orphan whose task has NO newer run → must survive (still actionable).
    store.createAgentRun({
      id: "run_orphan_alone", task_id: "tsk_b", prompt: "y", status: "FAILED", iterations: 0, tools_called: 0,
      started_at: old, source: "system", created_at: old, updated_at: old,
      error: "Interrupted by a restart — use Continue to resume from the checkpoint.",
    });
    const deleted = store.cleanupSupersededOrphanRuns();
    expect(deleted).toContain("run_orphan_superseded");
    expect(deleted).not.toContain("run_orphan_alone");
    expect(store.getAgentRun("run_orphan_superseded")).toBeNull();
    expect(store.getAgentRun("run_orphan_alone")).not.toBeNull();
    // 402 surfacing (a prior test already left a local 402 task — that's fine).
    expect(store.recentProviderFailure()).not.toBeNull();
    store.createAgentRun({
      id: "run_402", prompt: "z", status: "FAILED", iterations: 1, tools_called: 0,
      started_at: now, source: "system", created_at: now, updated_at: now,
      error: 'DeepSeek HTTP 402: {"error":{"message":"Insufficient Balance"}}',
    });
    const f = store.recentProviderFailure();
    expect(f?.kind).toBe("cloud");
  });

  it("files and decides review items (sound/UI vetting)", () => {
    const now = new Date().toISOString();
    store.createReviewItem({
      id: "rev_sound1", kind: "sound", title: "ZTame A/B — tighter low end", description: "B tames 200Hz",
      status: "PENDING", payload_json: JSON.stringify({ audioA: "f_a", audioB: "f_b" }),
      source: "agent", created_at: now, updated_at: now,
    });
    store.createReviewItem({
      id: "rev_ui1", kind: "ui", title: "ZScorch editor screenshot", status: "PENDING",
      payload_json: JSON.stringify({ image: "f_img", report: "knobs laid out" }),
      source: "agent", created_at: now, updated_at: now,
    });
    expect(store.countPendingReviews()).toBe(2);
    const listed = store.listReviewItems({ limit: 10 }).map((r) => r.id);
    expect(listed).toContain("rev_sound1");
    expect(listed).toContain("rev_ui1");
    store.decideReviewItem("rev_sound1", "APPROVED", "B is better", "founder");
    expect(store.getReviewItem("rev_sound1")?.status).toBe("APPROVED");
    expect(store.getReviewItem("rev_sound1")?.decided_by).toBe("founder");
    expect(store.countPendingReviews()).toBe(1);
  });

  it("resets production progress to a clean slate (archive, never delete)", () => {
    const now = new Date().toISOString();
    store.insertTask({ id: "tsk_reset1", title: "old work", priority: "P1", source: "test", status: "IN_PROGRESS", created_at: now, updated_at: now } as never);
    store.insertTask({ id: "tsk_reset2", title: "done work", priority: "P2", source: "test", status: "DONE", created_at: now, updated_at: now } as never);
    // A gate and product to reset (seeded rows exist).
    const result = store.resetProductionProgress();
    expect(result.archivedTasks).toBeGreaterThanOrEqual(1);
    expect(result.resetGates).toBeGreaterThanOrEqual(1);
    expect(result.resetProducts).toBeGreaterThanOrEqual(1);
    // The old IN_PROGRESS task is archived (CANCELLED), the DONE one untouched.
    expect(store.getTask("tsk_reset1")?.status).toBe("CANCELLED");
    expect(store.getTask("tsk_reset2")?.status).toBe("DONE");
    // Gates/products back to clean slate.
    expect(store.listPipelineGates().every((g) => g.status === "NOT_STARTED")).toBe(true);
    expect(store.listProducts().every((p) => p.status === "CONCEPT")).toBe(true);
    // The reset returns counts only (the full backup is persisted to KV by the
    // route — shipping the snapshot through the response is what OOM'd the DO
    // isolate in production). Bounded export still works for quick exports.
    expect(result.archivedTasks).toBeGreaterThanOrEqual(1);
    expect(store.exportSnapshot().tasks).toBeDefined();
    expect(Array.isArray(store.exportSnapshot().tasks)).toBe(true);
    expect(store.exportTableRows("tasks").length).toBeGreaterThan(0);
  });

  it("adapts to a legacy schema_migrations table (no name column) — production bug", () => {
    // The production store's schema_migrations predates the `name` column.
    // Reproduce that exact shape and confirm migrate() adapts in place instead
    // of throwing "no column named name" on the first INSERT.
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const legacyStore = new ExecutiveStore(createNodeSql(legacy as never));
    expect(() => legacyStore.migrate()).not.toThrow();
    // All migrations applied, including doctor_logs (v17) — and the ALTER
    // recorded the applied versions into the adapted table.
    const rows = legacy.prepare("SELECT version, name FROM schema_migrations").all() as Array<{ version: number; name: string }>;
    expect(rows.some((r) => r.version === 17 && r.name.length > 0)).toBe(true);
    expect(legacyStore.latestDoctorLog()).toBeNull(); // doctor_logs exists, just empty
    legacy.close();
  });
});
