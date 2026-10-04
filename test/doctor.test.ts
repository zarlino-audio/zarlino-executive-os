import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
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

  it("flags the WhatsApp bridge when it is offline with queued founder messages", async () => {
    store.setSetting(
      "whatsapp_bridge_last_seen",
      JSON.stringify({ at: new Date(Date.now() - 3_600_000).toISOString(), host: "ghost-machine" }),
    );
    store.insertNotification({
      id: "ntf_bridge_test",
      channel: "whatsapp",
      provider: "bridge",
      recipient: "+233546778438",
      subject: "1 item awaiting the founder",
      body: "• Something important",
      status: "QUEUED_UNCONFIGURED",
      error: null,
      source: "test",
      created_at: new Date().toISOString(),
    });

    const stale = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    expect(stale.checks.find((c) => c.id === "whatsapp.bridge")!.status).toBe("FAIL");

    // A fresh heartbeat on whatever machine hosts the channel clears it.
    store.setSetting(
      "whatsapp_bridge_last_seen",
      JSON.stringify({ at: new Date().toISOString(), host: "always-on-pc", linkedAs: "233597987855:2" }),
    );
    const fresh = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    expect(fresh.checks.find((c) => c.id === "whatsapp.bridge")!.status).toBe("OK");

    // Clean up so later tests in this shared store see no pending queue.
    store.updateNotification("ntf_bridge_test", { status: "SENT", error: null, provider: "bridge" });
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

  const agentReady = async (ctx: Record<string, unknown>) => {
    const tool = doctorTools().find((t) => t.name === "system.doctor")!;
    const out = (await tool.run(ctx as never, { autoFix: false, trigger: "test" })) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    return out.checks.find((c) => c.id === "features.agent_ready")!;
  };

  it("warns on an AI budget override the deployed env knob never authorised", async () => {
    const run = (autoFix: boolean) =>
      runDoctor(
        { store, env: { AI_DAILY_BUDGET: "5", AI_MONTHLY_BUDGET: "80" }, now: () => new Date().toISOString() },
        { autoFix, trigger: "test" },
      );
    store.setSetting("ai_daily_budget", "100");
    const warn = (await run(false)).checks.find((c) => c.id === "settings.budget_fundability")!;
    expect(warn.status).toBe("WARN"); // $100/day override vs $5/day deploy = unfunded belief
    expect(warn.detail).toContain("ai_daily_budget=$100");

    const fixed = (await run(true)).checks.find((c) => c.id === "settings.budget_fundability")!;
    expect(fixed.status).toBe("FAIL"); // autoFix clamped it — reported, not hidden
    expect(store.getSetting("ai_daily_budget")).toBe("5");

    const ok = (await run(false)).checks.find((c) => c.id === "settings.budget_fundability")!;
    expect(ok.status).toBe("OK");
  });

  it("cancelled tasks no longer keep the task-contract register noisy", async () => {
    const task = createTask({ title: "Stale blocked item already disposed of", priority: "P0", source: "test" });
    task.status = "CANCELLED";
    store.insertTask(task);
    const report = await runDoctor(
      { store, env: {}, now: () => new Date().toISOString() },
      { autoFix: false, trigger: "test" },
    );
    const check = report.checks.find((c) => c.id === "org.task_contracts")!;
    if (check.status !== "OK") {
      // Other legacy BLOCKED tasks may exist in this database — the cancelled
      // one must never be the reason.
      expect(check.detail).not.toContain(task.id);
    }
  });

  it("system.doctor verifies real tool names when the caller passes a registry", async () => {
    // Regression: the tool path used to drop the registry, so the agent's own
    // doctor call reported a phantom FAIL ("Registry not attached").
    const ok = await agentReady({
      store,
      env: { DEEPSEEK_API_KEY: "test" },
      audit: () => {},
      registry: { functionSchemas: () => [{ function: { name: "finance_get_snapshot" } }] },
    });
    expect(ok.status).toBe("OK");
  });

  it("system.doctor still flags dotted tool names (or a missing registry)", async () => {
    const dotted = await agentReady({
      store,
      env: { DEEPSEEK_API_KEY: "test" },
      audit: () => {},
      registry: { functionSchemas: () => [{ function: { name: "finance.get_snapshot" } }] },
    });
    expect(dotted.status).toBe("FAIL");
    expect(dotted.detail).toContain("finance.get_snapshot");

    const none = await agentReady({ store, env: { DEEPSEEK_API_KEY: "test" }, audit: () => {} });
    expect(none.status).toBe("FAIL");
    expect(none.detail).toContain("Registry not attached");
  });

  it("system.doctor sees a bound ZARLINO_KV binding (no phantom KV warning)", async () => {
    const tool = doctorTools().find((t) => t.name === "system.doctor")!;
    const out = (await tool.run(
      {
        store,
        env: { DEEPSEEK_API_KEY: "test", ZARLINO_KV: { get: async () => null, list: async () => ({ keys: [] }) } },
        audit: () => {},
      } as never,
      { autoFix: false, trigger: "test" },
    )) as { checks: Array<{ id: string; status: string; detail: string }> };
    const check = out.checks.find((c) => c.id === "kv.health")!;
    expect(check.status).toBe("OK");
  });
});
