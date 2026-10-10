/**
 * Execution boundary + remote execution + objectives (spec §2.3–§2.5, §4, §9).
 *
 * These tests pin the architectural contract this repo was corrected for:
 *   - engineering work NEVER queues for a machine (remote-only),
 *   - a machine daemon can only claim explicitly tagged machine_maintenance,
 *   - remote runs are dispatched idempotently, synced, and attach evidence,
 *   - objectives gate completion on criteria + closed tasks,
 *   - the internal secret fails closed (no hardcoded fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { classifyLocalWork, isEngineeringPrompt, applyExecutionBoundarySweep } from "../src/core/org/execution-boundary";
import { dispatchRemoteWorkflow, syncRemoteRun } from "../src/core/remote/execution";
import { createIntakeTask } from "../src/core/org/intake";
import { buildToolRegistry } from "../src/agent/tools";
import { DOCTOR_CHECKS } from "../src/core/doctor";
import { newId, nowIso } from "../src/ids";

let db: DatabaseSync;
let store: ExecutiveStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new ExecutiveStore(createNodeSql(db as never));
  store.migrate();
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

function makeLocalTask(prompt: string, opts: { taskId?: string; target?: string; meta?: unknown } = {}): string {
  const id = newId("ltk");
  const at = nowIso();
  store.createLocalTask({
    id,
    created_at: at,
    updated_at: at,
    source: "test",
    task_id: opts.taskId,
    prompt,
    status: "PENDING",
    execution_target: opts.target,
    meta_json: opts.meta ? JSON.stringify(opts.meta) : undefined,
  });
  return id;
}

describe("classifyLocalWork (execution boundary)", () => {
  it("refuses engineering prompts even with an acknowledgement", () => {
    const v = classifyLocalWork("build and package the ZTame installer", true);
    expect(v.local_allowed).toBe(false);
    expect(v.target).toBe("engineering");
    expect(v.reason).toMatch(/remote-only/i);
  });

  it("refuses prompts without an explicit machine_maintenance acknowledgement", () => {
    const v = classifyLocalWork("check the bridge heartbeat");
    expect(v.local_allowed).toBe(false);
    expect(v.reason).toMatch(/machine_maintenance/i);
  });

  it("allows non-engineering maintenance with an explicit acknowledgement", () => {
    const v = classifyLocalWork("check the bridge heartbeat and report disk space", true);
    expect(v.local_allowed).toBe(true);
    expect(v.target).toBe("machine_maintenance");
  });

  it("classifies common engineering verbs", () => {
    for (const p of ["compile the plugin", "run the tests", "deploy the website", "edit the source file", "sign the installer"]) {
      expect(isEngineeringPrompt(p)).toBe(true);
      expect(classifyLocalWork(p, true).local_allowed).toBe(false);
    }
  });
});

describe("machine queue cannot carry engineering work", () => {
  it("does not claim untagged legacy rows (fail closed)", () => {
    makeLocalTask("fix the DSP bug in ZScorch"); // no execution_target
    expect(store.claimLocalTask("daemon-test")).toBeNull();
  });

  it("claims only rows explicitly tagged machine_maintenance", () => {
    makeLocalTask("check bridge liveness", { target: "machine_maintenance" });
    const claimed = store.claimLocalTask("daemon-test");
    expect(claimed).not.toBeNull();
    expect(claimed?.execution_target).toBe("machine_maintenance");
  });

  it("sweep cancels legacy engineering rows and tags the rest", () => {
    const engId = makeLocalTask("build the VST3 and run ctest");
    const safeId = makeLocalTask("report hostname and uptime");
    const result = applyExecutionBoundarySweep(store);
    expect(result.cancelledIds).toContain(engId);
    expect(result.tagged).toBeGreaterThanOrEqual(1);
    const eng = store.getLocalTask(engId);
    expect(eng?.status).toBe("CANCELLED");
    expect(eng?.error).toMatch(/remote/i);
    const safe = store.getLocalTask(safeId);
    expect(safe?.execution_target).toBe("machine_maintenance");
    expect(store.claimLocalTask("daemon-test")?.id).toBe(safeId);
  });

  it("sweep classifies the ORIGINAL ask, not the OS dispatch wrapper", () => {
    // A wrapped prompt quotes the constitution ("build/test run...") — the
    // sweep must not cancel a benign maintenance ask because of the wrapper.
    const wrapped =
      "[OS DISPATCH DIRECTIVE - Zarlino Constitution, binding]\n" +
      "You are executing real work on this machine. Your deliverable is a CHANGE plus proof: files edited, a build/test run...\n" +
      "[END DIRECTIVE]\n\nReport the bridge heartbeat state";
    const id = makeLocalTask(wrapped);
    applyExecutionBoundarySweep(store);
    expect(store.getLocalTask(id)?.status).toBe("PENDING");
    expect(store.getLocalTask(id)?.execution_target).toBe("machine_maintenance");
  });

  it("sweep cancels a wrapped row whose recorded original ask is engineering", () => {
    const wrapped = "[OS DISPATCH DIRECTIVE]\n[END DIRECTIVE]\n\nRewrite the preset browser code";
    const id = makeLocalTask(wrapped, { meta: { original_prompt: "implement the preset browser and build it" } });
    applyExecutionBoundarySweep(store);
    expect(store.getLocalTask(id)?.status).toBe("CANCELLED");
  });
});

describe("executive.request_local_task enforces the boundary at creation", () => {
  function registry() {
    return buildToolRegistry({ env: {}, sink: { recordExecution: () => {} } });
  }

  it("refuses engineering with REMOTE_ONLY", async () => {
    const r = await registry().run("executive.request_local_task", { prompt: "build and test the plugin" }, { env: {}, store, audit: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.output as { queued: boolean; code?: string };
      expect(out.queued).toBe(false);
      expect(out.code).toBe("REMOTE_ONLY");
    }
  });

  it("refuses without machine_maintenance acknowledgement", async () => {
    const r = await registry().run("executive.request_local_task", { prompt: "check the bridge heartbeat" }, { env: {}, store, audit: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { queued: boolean }).queued).toBe(false);
  });

  it("queues an acknowledged maintenance ask with the right target", async () => {
    const r = await registry().run(
      "executive.request_local_task",
      { prompt: "check the bridge heartbeat", machine_maintenance: true },
      { env: {}, store, audit: () => {} },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.output as { queued: boolean; taskId: string; execution_target: string };
      expect(out.queued).toBe(true);
      expect(out.execution_target).toBe("machine_maintenance");
      expect(store.getLocalTask(out.taskId)?.execution_target).toBe("machine_maintenance");
    }
  });
});

/** Minimal fetch double for the GitHub API used by remote execution. */
function githubFetchMock(opts: { failRun?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
      json: async () => body,
    });
    if (url.includes("/actions/workflows/") && url.includes("/dispatches") && method === "POST") {
      return ok(204, undefined) as unknown as Response;
    }
    if (url.includes("/actions/workflows/")) {
      return ok(200, { id: 7, name: "CI" }) as unknown as Response;
    }
    if (url.includes("/actions/runs?") || url.endsWith("/actions/runs")) {
      const createdAt = new Date(Date.now() - 5_000).toISOString();
      return ok(200, {
        workflow_runs: [
          { id: 555, workflow_id: 7, path: ".github/workflows/ci.yml", status: "queued", conclusion: null, created_at: createdAt, html_url: "https://github.com/o/r/actions/runs/555" },
        ],
      }) as unknown as Response;
    }
    if (/\/actions\/runs\/555\/artifacts/.test(url)) {
      return ok(200, { artifacts: [{ name: "build-output", expired: false, size_in_bytes: 1234 }] }) as unknown as Response;
    }
    if (/\/actions\/runs\/555$/.test(url)) {
      return ok(200, {
        id: 555,
        status: "completed",
        conclusion: opts.failRun ? "failure" : "success",
        html_url: "https://github.com/o/r/actions/runs/555",
        head_sha: "abc123",
      }) as unknown as Response;
    }
    return ok(404, { message: "not found" }) as unknown as Response;
  });
}

describe("remote execution", () => {
  it("fails closed without GITHUB_TOKEN", async () => {
    const d = await dispatchRemoteWorkflow(store, {}, { repo: "o/r", workflow: "ci.yml" });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("NOT_CONFIGURED");
  });

  it("rejects malformed references", async () => {
    const d = await dispatchRemoteWorkflow(store, { GITHUB_TOKEN: "t" }, { repo: "bad repo", workflow: "../x.yml" });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("INVALID");
  });

  it("dispatches, records the run, refuses duplicates, syncs evidence on success", async () => {
    const fetchMock = githubFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const task = store.getTask("tsk_ztame_p8") ?? null;
    // Create a task of our own (the seed may not include the old ids).
    const taskId = (() => {
      const t = {
        id: newId("tsk"),
        title: "Verify remote path",
        status: "OPEN",
        priority: "P2",
        source: "test",
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      store.insertTask(t as never);
      return t.id;
    })();
    void task;

    const d1 = await dispatchRemoteWorkflow(store, { GITHUB_TOKEN: "t" }, { repo: "o/r", workflow: "ci.yml", taskId });
    expect(d1.ok).toBe(true);
    expect(d1.run?.status === "QUEUED" || d1.run?.status === "DISPATCHED").toBe(true);

    // Duplicate active dispatch for the same task+workflow is refused.
    const d2 = await dispatchRemoteWorkflow(store, { GITHUB_TOKEN: "t" }, { repo: "o/r", workflow: "ci.yml", taskId });
    expect(d2.ok).toBe(false);
    expect(d2.code).toBe("DUPLICATE");
    expect(d2.existingId).toBe(d1.run?.id);

    // Sync → completed success → evidence attached + verified.
    const synced = await syncRemoteRun(store, { GITHUB_TOKEN: "t" }, d1.run!.id);
    expect(synced?.run.status).toBe("COMPLETED");
    expect(synced?.run.conclusion).toBe("success");
    const evidence = store.listTaskEvidence(taskId);
    expect(evidence.length).toBe(1);
    expect(evidence[0]?.verified).toBe(true);
    expect(evidence[0]?.verification_output).toContain("conclusion=success");
    expect(evidence[0]?.verification_output).toContain("build-output");
  });

  it("records a failing run as FAILED and never marks the task done", async () => {
    vi.stubGlobal("fetch", githubFetchMock({ failRun: true }));
    const taskId = (() => {
      const t = { id: newId("tsk"), title: "Fail path", status: "OPEN", priority: "P2", source: "test", created_at: nowIso(), updated_at: nowIso() };
      store.insertTask(t as never);
      return t.id;
    })();
    const d = await dispatchRemoteWorkflow(store, { GITHUB_TOKEN: "t" }, { repo: "o/r", workflow: "ci.yml", taskId });
    expect(d.ok).toBe(true);
    const synced = await syncRemoteRun(store, { GITHUB_TOKEN: "t" }, d.run!.id);
    expect(synced?.run.status).toBe("FAILED");
    expect(synced?.run.conclusion).toBe("failure");
    expect(store.getTask(taskId)?.status).toBe("OPEN");
    const evidence = store.listTaskEvidence(taskId);
    expect(evidence.length).toBe(1);
    expect(evidence[0]?.verified).toBe(false);
  });

  it("records a NON-EXISTENT workflow as a failure (controlled failure case)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        void url;
        return { ok: false, status: 404, text: async () => JSON.stringify({ message: "Not Found" }), json: async () => ({ message: "Not Found" }) } as unknown as Response;
      }),
    );
    const d = await dispatchRemoteWorkflow(store, { GITHUB_TOKEN: "t" }, { repo: "o/r", workflow: "does-not-exist.yml" });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("WORKFLOW_NOT_FOUND");
    // Nothing was recorded as a run, and no evidence exists anywhere.
    expect(store.listRemoteRuns(10).length).toBe(0);
  });
});

describe("objectives (persistent, gated completion)", () => {
  it("intake creates a persistent objective linked to its task", () => {
    const created = createIntakeTask(store, {
      title: "Prepare the ZScorch release checklist",
      acceptance: "Checklist exists and every gate row is filled",
      roleId: "role_coa",
      from: "233546778438",
      sourceText: "please prepare the ZScorch release checklist",
    });
    expect(created).not.toBeNull();
    expect(created?.objectiveId).toBeTruthy();
    const objective = store.getObjective(created!.objectiveId);
    expect(objective?.status).toBe("ACTIVE");
    expect(objective?.criteria_json).toMatch(/Checklist/);
    const linked = store.listTasksForObjective(created!.objectiveId);
    expect(linked.map((t) => t.id)).toContain(created!.taskId);
  });

  it("refuses ACHIEVED while linked tasks are open; allows it after closure", async () => {
    const created = createIntakeTask(store, {
      title: "Close the DSP verification loop",
      acceptance: "Verification evidence attached and accepted",
      roleId: "role_coa",
      from: "233546778438",
    });
    expect(created).not.toBeNull();
    const registry = buildToolRegistry({ env: {}, sink: { recordExecution: () => {} } });

    const open = await registry.run(
      "executive.update_objective",
      { id: created!.objectiveId, status: "ACHIEVED" },
      { env: {}, store, audit: () => {} },
    );
    expect(open.ok).toBe(true);
    if (open.ok) expect((open.output as { ok: boolean }).ok).toBe(false);

    // Close the task properly: evidence first, then DONE (evidence gate).
    store.addTaskEvidence(created!.taskId, {
      kind: "review",
      locator: "review://dsp-verification",
      summary: "Verification recorded for the objective gate test",
      verification_output: "listening notes: no artefacts detected across 3 blind passes",
      verified: true,
      source: "test",
    });
    store.setTaskStatus(created!.taskId, "DONE", { mode: "manual" });

    const done = await registry.run(
      "executive.update_objective",
      { id: created!.objectiveId, status: "ACHIEVED", evidence: "CI run + review attached" },
      { env: {}, store, audit: () => {} },
    );
    expect(done.ok).toBe(true);
    if (done.ok) expect((done.output as { ok: boolean }).ok).toBe(true);
    expect(store.getObjective(created!.objectiveId)?.status).toBe("ACHIEVED");
    expect(store.getObjective(created!.objectiveId)?.verified_at).toBeTruthy();
  });
});

describe("doctor: boundary + security checks", () => {
  function ctx(env: Record<string, string | undefined> = {}) {
    return { store, env, now: () => nowIso() };
  }
  const check = (id: string) => DOCTOR_CHECKS.find((c) => c.id === id)!;

  it("security.internal_secret fails closed when unset and passes when configured", async () => {
    const missing = await check("security.internal_secret").run(ctx({}), false);
    expect(missing.status).toBe("FAIL");
    const configured = await check("security.internal_secret").run(ctx({ INTERNAL_SECRET: "s3cret" }), false);
    expect(configured.status).toBe("OK");
  });

  it("execution.boundary flags an engineering row tagged machine_maintenance", async () => {
    makeLocalTask("compile the plugin and run ctest", { target: "machine_maintenance" });
    const r = await check("execution.boundary").run(ctx(), false);
    expect(r.status).toBe("FAIL");
  });

  it("execution.boundary auto-fixes ungoverned rows via the sweep", async () => {
    makeLocalTask("build the VST3");
    const r = await check("execution.boundary").run(ctx(), true);
    // The sweep cancelled the engineering row during the check → healthy.
    expect(r.status).toBe("OK");
  });

  it("remote.execution requires a configured GitHub token", async () => {
    const r = await check("remote.execution").run(ctx({}), false);
    expect(r.status).toBe("FAIL");
    const okCtx = ctx({ GITHUB_TOKEN: "t" });
    const r2 = await check("remote.execution").run(okCtx, false);
    expect(r2.status).toBe("OK");
  });
});
