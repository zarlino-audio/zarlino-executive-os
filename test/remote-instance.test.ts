/**
 * Remote dev machine support tests — honest instance identity (§7).
 *
 * Each physical daemon registers under its own validated instance id
 * (local_daemon_01 / remote_daemon_01); a heartbeat can never grant itself
 * an arbitrary id or role. Health rows are per-instance, so two daemons
 * never clobber each other's liveness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { resolveDaemonAgentId, sanitizeInstanceId } from "../src/core/org/agents";

describe("remote dev machine instance identity", () => {
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

  it("validates instance ids strictly", () => {
    expect(sanitizeInstanceId("remote_daemon_01")).toBe("remote_daemon_01");
    expect(sanitizeInstanceId("local_daemon_01")).toBe("local_daemon_01");
    expect(sanitizeInstanceId("chaos_probe_live_01")).toBe("chaos_probe_live_01");
    // Rejected: unsafe characters, case, wrong length, empty.
    expect(sanitizeInstanceId("REMOTE_DAEMON")).toBeNull();
    expect(sanitizeInstanceId("a b")).toBeNull();
    expect(sanitizeInstanceId("x")).toBeNull();
    expect(sanitizeInstanceId("")).toBeNull();
    expect(sanitizeInstanceId(undefined)).toBeNull();
    expect(sanitizeInstanceId("../../etc")).toBeNull();
  });

  it("defaults unknown ids to the primary daemon identity", () => {
    expect(resolveDaemonAgentId(undefined)).toBe("local_daemon_01");
    expect(resolveDaemonAgentId("!!")).toBe("local_daemon_01");
    expect(resolveDaemonAgentId("remote_daemon_01")).toBe("remote_daemon_01");
  });

  it("keeps one health row per instance — two daemons never clobber", () => {
    store.upsertLocalAgentHeartbeat({ host: "FOUNDER-PC", pid: "1", id: "local_daemon_01" });
    store.upsertLocalAgentHeartbeat({ host: "ZARLINO1", pid: "2", id: "remote_daemon_01" });

    const local = store.getLocalAgentStatus(); // primary row
    expect(local?.host).toBe("FOUNDER-PC");
    const rows = db.prepare("SELECT id, host FROM local_agent_status ORDER BY id").all() as Array<{ id: string; host: string }>;
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.id === "remote_daemon_01" && r.host === "ZARLINO1")).toBe(true);
    expect(rows.some((r) => r.id === "local_daemon_01" && r.host === "FOUNDER-PC")).toBe(true);
  });

  it("registers each daemon as its own org instance (same pinned role)", () => {
    store.upsertOrgAgent({ id: "local_daemon_01", roleId: "role_software_engineering", kind: "local" });
    store.upsertOrgAgent({ id: "remote_daemon_01", roleId: "role_software_engineering", kind: "local" });
    const agents = store.listOrgAgents();
    expect(agents.some((a) => a.id === "local_daemon_01" && a.role_id === "role_software_engineering")).toBe(true);
    expect(agents.some((a) => a.id === "remote_daemon_01" && a.role_id === "role_software_engineering")).toBe(true);
    expect(agents.length).toBe(2);
  });

  it("deregisters a dead instance cleanly", () => {
    store.deleteOrgAgent("remote_daemon_01");
    expect(store.getOrgAgent("remote_daemon_01")).toBeNull();
    expect(store.getOrgAgent("local_daemon_01")).toBeTruthy();
  });
});
