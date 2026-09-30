import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createApprovalRequest } from "../src/core/approvals/queue";
import { handleMcpMessage, MCP_TOOLS } from "../src/mcp/server";

interface RpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: { tools?: Array<{ name: string }>; protocolVersion?: string; serverInfo?: { readOnly?: boolean }; content?: Array<{ type: string; text: string }>; structuredContent?: unknown };
  error?: { code: number; message: string };
}

describe("MCP read-only plane", () => {
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

  it("initialize reports the protocol and the read-only nature of the server", async () => {
    const r = (await handleMcpMessage(store, {}, { jsonrpc: "2.0", id: 1, method: "initialize" })) as RpcResponse;
    expect(r.result?.protocolVersion).toBe("2025-06-18");
    expect(r.result?.serverInfo?.readOnly).toBe(true);
  });

  it("notifications get no response at all", async () => {
    const r = await handleMcpMessage(store, {}, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r).toBeNull();
  });

  it("tools/list exposes only inspection tools", async () => {
    const r = (await handleMcpMessage(store, {}, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as RpcResponse;
    const names = (r.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("zarlino_overview");
    expect(names).toContain("zarlino_tasks");
    expect(names).toContain("zarlino_approvals");
    expect(names).toContain("zarlino_org");
    expect(names).toContain("zarlino_ceo_reports");
    expect(names).toContain("zarlino_notifications");
    expect(names).toContain("zarlino_doctor");
    expect(names).toContain("zarlino_artifacts");
    expect(names).toContain("zarlino_audit");
    // READ-ONLY: every exposed tool name is an inspection tool.
    for (const n of names) expect(n).toMatch(/^zarlino_(overview|tasks|approvals|org|ceo_reports|notifications|doctor|artifacts|audit)$/);
    expect(MCP_TOOLS.length).toBe(names.length);
  });

  it("tools/call runs a whitelisted read tool and returns structured content", async () => {
    store.insertApproval(
      createApprovalRequest({ action_label: "MCP visible approval", reason: "test", requested_by: "executive" }),
    );
    const r = (await handleMcpMessage(store, {}, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "zarlino_approvals", arguments: { status: "PENDING", limit: 10 } },
    })) as RpcResponse;
    expect(r.error).toBeUndefined();
    const structured = r.result?.structuredContent as Array<{ label: string }>;
    expect(structured.some((a) => a.label === "MCP visible approval")).toBe(true);
    // content mirrors structured content as text
    const text = r.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(text)).toBeTruthy();
  });

  it("rejects any tool outside the read-only whitelist with a JSON-RPC error", async () => {
    const r = (await handleMcpMessage(store, {}, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "zarlino_delete_everything", arguments: {} },
    })) as RpcResponse;
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message ?? "").toContain("READ-ONLY");
    // and no tool name that implies a mutation exists at all
    for (const t of MCP_TOOLS) {
      expect(t.name).not.toMatch(/(delete|remove|update|create|insert|write|set|run|deploy|upload)/);
    }
  });

  it("unknown methods and malformed input degrade as JSON-RPC errors, never throws", async () => {
    const m = (await handleMcpMessage(store, {}, { jsonrpc: "2.0", id: 5, method: "resources/subscribe" })) as RpcResponse;
    expect(m.error?.code).toBe(-32601);
    const bad = (await handleMcpMessage(store, {}, "not-an-object")) as RpcResponse;
    expect(bad.error?.code).toBe(-32700);
    const batch = (await handleMcpMessage(store, {}, [
      { jsonrpc: "2.0", id: 6, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ])) as RpcResponse[];
    expect(batch.length).toBe(1);
  });

  it("artifacts tool degrades honestly when R2 is not bound", async () => {
    const r = (await handleMcpMessage(store, {}, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "zarlino_artifacts", arguments: {} },
    })) as RpcResponse;
    expect((r.result?.structuredContent as { configured: boolean }).configured).toBe(false);
  });

  it("doctor tool reads the real log shape (counts in summary_json, checks in checks_json)", async () => {
    const at = new Date().toISOString();
    store.insertDoctorLog({
      id: "doc_mcp_test",
      run_at: at,
      trigger: "test",
      auto_fix: 0,
      summary_json: JSON.stringify({ total: 2, ok: 1, warn: 1, fail: 0, fixed: 0 }),
      checks_json: JSON.stringify([
        { id: "a.ok", status: "OK", detail: "fine" },
        { id: "b.warn", status: "WARN", detail: "watch this" },
      ]),
      source: "system",
      created_at: at,
      updated_at: at,
    } as never);
    const r = (await handleMcpMessage(store, {}, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "zarlino_doctor", arguments: {} },
    })) as RpcResponse;
    const sc = r.result?.structuredContent as {
      ranAt: string;
      summary: { warn: number; fail: number };
      problems: Array<{ id: string; status: string }>;
    };
    expect(sc.summary.warn).toBe(1);
    expect(sc.summary.fail).toBe(0);
    expect(sc.problems.map((p) => p.id)).toEqual(["b.warn"]);
  });
});
