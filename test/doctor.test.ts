import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { runDoctor, DOCTOR_CHECKS, doctorTools } from "../src/core/doctor";

describe("System Doctor", () => {
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

  it("runs every check and logs the run", async () => {
    const report = await runDoctor(
      { store, env: { DEEPSEEK_API_KEY: "x" }, registry: { functionSchemas: () => [{ function: { name: "ok_tool" } }] } as never, now: () => new Date().toISOString() },
      { autoFix: true, trigger: "test" },
    );
    expect(report.summary.total).toBe(DOCTOR_CHECKS.length);
    expect(report.healthy).toBe(true); // missing non-required secrets are WARN, not FAIL
    const logs = store.listDoctorLogs();
    expect(logs.length).toBe(1);
    expect(logs[0]!.trigger).toBe("test");
  });

  it("auto-fixes a stale RUNNING agent run", async () => {
    const now = new Date().toISOString();
    store.createAgentRun({
      id: "run_bad", prompt: "x", status: "RUNNING", iterations: 0, tools_called: 0,
      started_at: now, source: "test", created_at: now, updated_at: now,
      last_heartbeat: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: true, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "jobs.stale_runs")!;
    expect(check.fixed).toBeTruthy();
    // Reaped to FAILED; the maintenance sweep (not the doctor) then resumes it
    // in lockstep with execution.
    expect(store.getAgentRun("run_bad")?.status).toBe("FAILED");
  });

  it("flags interrupted 0-iteration runs and the sweep primitive resumes them", async () => {
    const now = new Date().toISOString();
    // Reaped by reapStaleAgentRuns — the exact orphan the doctor must surface.
    store.createAgentRun({
      id: "run_interrupted", prompt: "y", status: "FAILED", iterations: 0, tools_called: 0,
      started_at: now, source: "test", created_at: now, updated_at: now,
      error: "Interrupted by a restart — use Continue to resume from the checkpoint.",
    });
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: true, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "jobs.interrupted_runs")!;
    expect(check.status).toBe("FAIL"); // the doctor surfaces the pile…
    expect(check.detail).toMatch(/\d+/);
    // …and the maintenance sweep's primitive resumes it with a fresh heartbeat
    // (so it is not immediately reaped as stale again).
    const resumed = store.resetInterruptedRuns(10);
    expect(resumed).toContain("run_interrupted");
    const run = store.getAgentRun("run_interrupted")!;
    expect(run.status).toBe("RUNNING");
    expect(run.last_heartbeat).toBeTruthy();
    expect(run.error).toBeNull();
  });

  it("auto-fixes an expired local-task lease", async () => {
    const now = new Date().toISOString();
    store.createLocalTask({
      id: "lt_expired", prompt: "y", status: "RUNNING", claimed_by: "ghost", source: "test",
      created_at: now, updated_at: now,
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: true, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "tasks.expired_leases")!;
    expect(check.fixed).toBeTruthy();
    expect(store.getLocalTask("lt_expired")?.status).toBe("PENDING");
  });

  it("reports missing secrets as WARN without reading values", async () => {
    const report = await runDoctor(
      { store, env: { DEEPSEEK_API_KEY: "x" }, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "secrets.required")!;
    expect(check.status).toBe("WARN");
    expect(check.detail).not.toContain("x"); // never echo values
  });

  it("features.agent_ready flags invalid tool names (chat would 400)", async () => {
    // A registry that still sends dotted names — the exact bug that broke chat.
    const badRegistry = {
      functionSchemas: () => [
        { function: { name: "finance.get_snapshot" } },
        { function: { name: "ok_tool" } },
      ],
    };
    const report = await runDoctor(
      { store, env: { DEEPSEEK_API_KEY: "k" }, registry: badRegistry as never, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "features.agent_ready")!;
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("finance.get_snapshot");
  });

  it("features.agent_ready passes when names are provider-safe and key present", async () => {
    const goodRegistry = {
      functionSchemas: () => [{ function: { name: "finance_get_snapshot" } }],
    };
    const report = await runDoctor(
      { store, env: { DEEPSEEK_API_KEY: "k" }, registry: goodRegistry as never, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "features.agent_ready")!;
    expect(check.status).toBe("OK");
  });

  it("features.agent_ready fails when the DeepSeek key is missing", async () => {
    const report = await runDoctor(
      { store, env: {}, registry: { functionSchemas: () => [] } as never, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "features.agent_ready")!;
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("DEEPSEEK_API_KEY");
  });

  it("local_agent.health flags an offline daemon with aging pending tasks", async () => {
    // Seed an aging PENDING task and no heartbeat record.
    const now = new Date().toISOString();
    store.createLocalTask({
      id: "lt_stale_pending", prompt: "do something", status: "PENDING", source: "test",
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      updated_at: now,
    });
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "local_agent.health")!;
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("no daemon");
    // Cleanup so other tests are unaffected.
    db.exec("DELETE FROM local_tasks WHERE id = 'lt_stale_pending'");
  });

  it("local_agent.health passes when the daemon heartbeat is fresh", async () => {
    store.upsertLocalAgentHeartbeat({ host: "test-host", version: "test", pid: "1", claimed: false });
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "local_agent.health")!;
    // There may be other pending tasks (from prior tests), so it can be WARN;
    // it must NOT be FAIL (daemon is online).
    expect(["OK", "WARN"]).toContain(check.status);
  });

  it("local_agent.health fails when the heartbeat is stale", async () => {
    // Backdate the heartbeat to 10 minutes ago (older than the 5-min window).
    db.prepare("UPDATE local_agent_status SET last_seen = ? WHERE id = 'local'").run(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "local_agent.health")!;
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("offline");
    // Restore a fresh heartbeat.
    store.upsertLocalAgentHeartbeat({ host: "test-host", version: "test", pid: "1" });
  });

  it("exposes system.doctor / system.self_test / system.maintenance tools", () => {
    const names = doctorTools().map((t) => t.name);
    expect(names).toContain("system.doctor");
    expect(names).toContain("system.self_test");
    expect(names).toContain("system.maintenance");
  });

  it("system.self_test passes on a healthy store", async () => {
    const tool = doctorTools().find((t) => t.name === "system.self_test")!;
    const out = (await tool.run(
      { store, env: {}, audit: () => {} } as never,
      {},
    )) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(out.ok).toBe(true);
    expect(out.checks.length).toBeGreaterThan(5);
  });
});
