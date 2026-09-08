/**
 * AOrgI Phases 1–4 round-2 audit tests (migration v28) — explicit
 * DefinitionOfDone (§30), incident records + response loop (§15, §31), and
 * bottleneck measurement (§32).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { collectiveMetrics } from "../src/core/org/intelligence";
import { runDoctor } from "../src/core/doctor";

describe("AOrgI round-2 audit fixes (migration v28)", () => {
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

  it("seeds the explicit DefinitionOfDone as org memory (§30)", () => {
    const dod = store.getDefinitionOfDone();
    expect(dod).toBeTruthy();
    expect(dod!.value.functional_requirements).toBe("pass");
    expect(dod!.value.critical_defects).toBe(0);
    expect(dod!.value.governance).toBe("pass");
  });

  it("seeds the two REAL open failures as incidents (§31)", () => {
    const incidents = store.listOrgIncidents();
    expect(incidents.some((i) => i.id === "inc_provider_balance")).toBe(true);
    expect(incidents.some((i) => i.id === "inc_interrupted_runs")).toBe(true);
    for (const id of ["inc_provider_balance", "inc_interrupted_runs"]) {
      const inc = store.getOrgIncident(id)!;
      expect(inc.status).toBe("OPEN");
      expect(inc.severity).toBe("HIGH");
    }
  });

  it("tracks the incident response loop with timestamps", () => {
    const inc = store.createOrgIncident({ title: "Test outage", severity: "MEDIUM" });
    const contained = store.updateOrgIncidentStatus(inc.id, "CONTAINED")!;
    expect(contained.status).toBe("CONTAINED");
    expect(contained.contained_at).toBeTruthy();
    const resolved = store.updateOrgIncidentStatus(inc.id, "RESOLVED", "Restored and verified.")!;
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolved_at).toBeTruthy();
    expect(resolved.resolution).toBe("Restored and verified.");
    expect(store.updateOrgIncidentStatus("inc_missing", "RESOLVED")).toBeNull();
  });

  it("doctor enforces the DoD artifact and incident visibility", async () => {
    // DoD present, incidents open → OK + WARN respectively.
    let report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    let dod = report.checks.find((c) => c.id === "org.dod")!;
    let incs = report.checks.find((c) => c.id === "org.incidents_open")!;
    expect(dod.status).toBe("OK");
    expect(incs.status).toBe("WARN"); // two HIGH incidents open (real seeds)

    // Remove the DoD artifact → WARN.
    db.prepare("DELETE FROM org_memory WHERE key = 'definition_of_done'").run();
    report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    dod = report.checks.find((c) => c.id === "org.dod")!;
    expect(dod.status).toBe("WARN");

    // Resolve the real incidents → incidents check OK.
    store.updateOrgIncidentStatus("inc_provider_balance", "RESOLVED", "DeepSeek account topped up (example).");
    store.updateOrgIncidentStatus("inc_interrupted_runs", "RESOLVED", "Orphan queue drained (example).");
    report = await runDoctor({ store, env: {}, now: () => new Date().toISOString() }, { autoFix: false, trigger: "test" });
    incs = report.checks.find((c) => c.id === "org.incidents_open")!;
    expect(incs.status).toBe("OK");
  });

  it("measures bottleneck metrics from real tables (§32)", () => {
    const m = collectiveMetrics(store);
    expect(typeof m.bottlenecks.openTasks).toBe("number");
    expect(typeof m.bottlenecks.queueGrowth7d).toBe("number");
    expect(typeof m.bottlenecks.tasksCreated7d).toBe("number");
    expect(typeof m.bottlenecks.tasksDone7d).toBe("number");
    expect(typeof m.bottlenecks.verificationPending).toBe("number");
    // Decision quality from negotiations (§35 convergence).
    expect(typeof m.convergence.decisionsRendered).toBe("number");
    expect(m.convergence.avgResolutionHours === null || typeof m.convergence.avgResolutionHours === "number").toBe(true);
  });
});
