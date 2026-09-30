/**
 * MCP (Model Context Protocol) — READ-ONLY plane for the Executive OS.
 *
 * The OS exposes a single JSON-RPC 2.0 endpoint at POST /mcp, authenticated
 * with the same bearer token/session as the console. It is deliberately
 * READ-ONLY: the tool surface consists exclusively of inspection tools
 * (overview, tasks, approvals, org, CEO reports, notifications, doctor,
 * artifacts, audit). Mutating tools do not exist here, and any unknown tool
 * name is rejected with a JSON-RPC error — there is no code path from MCP
 * into the store's write methods.
 *
 * Protocol: MCP "streamable HTTP" (single JSON response per request; no SSE
 * session state — the OS is stateless per request beyond its DO store).
 */
import type { ExecutiveStore } from "../db/store";

export interface McpEnv {
  ARTIFACTS?: { list(opts: { prefix?: string; limit?: number }): Promise<{ objects: Array<{ key: string; size: number; uploaded?: unknown }> }> };
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "zarlino-executive-os";
export const MCP_SERVER_VERSION = "1.0.0";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (store: ExecutiveStore, env: McpEnv, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function intArg(args: Record<string, unknown>, key: string, def: number, max: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length ? v : undefined;
}

function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The complete (read-only) tool surface. Adding a tool here is the ONLY way
 * to expose functionality over MCP — keep this list inspection-only.
 */
export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "zarlino_overview",
    description:
      "Executive overview: open task/approval/incident counts, open contradictions, registered agents, and the latest CEO report digest.",
    inputSchema: { type: "object", properties: {} },
    run: (store) => ({
      tasks: { open: store.listTasks({ limit: 500 }).filter((t) => t.status !== "DONE" && t.status !== "CANCELLED").length },
      approvals: { pending: store.listApprovals({ status: "PENDING", limit: 100 }).length },
      incidents: { open: store.listOrgIncidents({ status: "OPEN", limit: 100 }).length },
      contradictionsOpen: store.countOpenContradictions(),
      agents: store.listOrgAgents({ limit: 100 }).map((a) => ({ id: a.id, roleId: a.role_id, kind: a.kind, status: a.status, host: a.host })),
      lastCeoReport: store.latestCeoReport(),
    }),
  },
  {
    name: "zarlino_tasks",
    description: "List tasks (read-only) with optional status filter.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional exact status filter (e.g. RUNNING, QUEUED, DONE, CANCELLED)." },
        limit: { type: "number", description: "Max rows (default 25, max 200)." },
      },
    },
    run: (store, _env, args) =>
      store
        .listTasks({ status: strArg(args, "status"), limit: intArg(args, "limit", 25, 200) })
        .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee_person_id ?? null, createdAt: t.created_at })),
  },
  {
    name: "zarlino_approvals",
    description: "List approval requests (read-only). Defaults to PENDING.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Exact status filter; default PENDING. Use 'all' for every status." },
        limit: { type: "number", description: "Max rows (default 25, max 100)." },
      },
    },
    run: (store, _env, args) => {
      const statusArg = strArg(args, "status") ?? "PENDING";
      const status = statusArg.toLowerCase() === "all" ? undefined : statusArg;
      return store
        .listApprovals({ status, limit: intArg(args, "limit", 25, 100) })
        .map((a) => ({ id: a.id, label: a.action_label, status: a.status, requestedBy: a.requested_by, decidedBy: a.decided_by ?? null, createdAt: a.created_at }));
    },
  },
  {
    name: "zarlino_org",
    description: "Organization state: registered agents and open incidents (read-only).",
    inputSchema: { type: "object", properties: {} },
    run: (store) => ({
      agents: store.listOrgAgents({ limit: 100 }).map((a) => ({ id: a.id, roleId: a.role_id, kind: a.kind, model: a.model, status: a.status, host: a.host, lastSeen: a.last_seen ?? null })),
      incidentsOpen: store.listOrgIncidents({ status: "OPEN", limit: 100 }).map((i) => ({ id: i.id, title: i.title, severity: i.severity, createdAt: i.created_at })),
    }),
  },
  {
    name: "zarlino_ceo_reports",
    description: "Recent CEO agent cycle reports (decisions, escalations, summary, model, neurons) — read-only.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max rows (default 10, max 50)." } } },
    run: (store, _env, args) => store.listCeoReports(intArg(args, "limit", 10, 50)),
  },
  {
    name: "zarlino_notifications",
    description: "Founder notification log (WhatsApp escalations, with delivery status) — read-only.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max rows (default 20, max 100)." } } },
    run: (store, _env, args) => store.listNotifications(intArg(args, "limit", 20, 100)),
  },
  {
    name: "zarlino_doctor",
    description: "Latest system doctor run: summary counts and any failing/warning checks — read-only.",
    inputSchema: { type: "object", properties: {} },
    run: (store) => {
      const log = store.latestDoctorLog();
      if (!log) return { ranAt: null, summary: null, problems: [] };
      const summary = safeJson(log.summary_json);
      const checks = safeJson(log.checks_json);
      return {
        ranAt: log.run_at,
        summary,
        problems: (Array.isArray(checks) ? checks : [])
          .filter((c) => (c as { status?: string }).status && (c as { status: string }).status !== "OK")
          .map((c) => {
            const chk = c as { id?: string; status?: string; detail?: string };
            return { id: chk.id ?? "?", status: chk.status ?? "?", detail: chk.detail ?? "" };
          }),
      };
    },
  },
  {
    name: "zarlino_artifacts",
    description: "List stored artifacts (R2) by key prefix — read-only.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Key prefix (default 'artifacts/')." },
        limit: { type: "number", description: "Max rows (default 50, max 200)." },
      },
    },
    run: async (_store, env, args) => {
      if (!env.ARTIFACTS) return { configured: false, artifacts: [] };
      const listed = await env.ARTIFACTS.list({ prefix: strArg(args, "prefix") ?? "artifacts/", limit: intArg(args, "limit", 50, 200) });
      return {
        configured: true,
        artifacts: listed.objects.map((o) => ({
          key: o.key,
          sizeBytes: o.size,
          uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded ?? ""),
        })),
      };
    },
  },
  {
    name: "zarlino_audit",
    description: "Recent audit-trail events (who did what, when) — read-only.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max rows (default 25, max 200)." } } },
    run: (store, _env, args) =>
      store.listAudit(intArg(args, "limit", 25, 200)).map((e) => ({ id: e.id, actor: e.actor, action: e.action, entityType: e.entity_type, entityId: e.entity_id, at: e.created_at })),
  },
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

function rpcResult(id: JsonRpcId, result: unknown): { body: unknown } {
  return { body: { jsonrpc: "2.0", id: id ?? null, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string): { body: unknown } {
  return { body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

/**
 * Handle one JSON-RPC message (or batch). Returns null for notifications
 * (no response is sent for those), otherwise the JSON-RPC response body.
 * READ-ONLY by construction: only whitelisted inspection tools execute.
 */
export async function handleMcpMessage(
  store: ExecutiveStore,
  env: McpEnv,
  raw: unknown,
): Promise<unknown | null> {
  if (Array.isArray(raw)) {
    const out: unknown[] = [];
    for (const m of raw) {
      const r = await handleMcpMessage(store, env, m);
      if (r !== null) out.push(r);
    }
    return out.length ? out : null;
  }
  if (typeof raw !== "object" || raw === null) {
    return rpcError(null, -32700, "Parse error: expected a JSON-RPC 2.0 object.").body;
  }
  const msg = raw as JsonRpcRequest;
  const id = msg.id ?? null;
  const method = msg.method ?? "";

  // Notifications (no id) never get a response.
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, readOnly: true },
        instructions:
          "Zarlino Executive OS — READ-ONLY inspection plane. All tools observe state; there are no tools that change anything. Mutations happen through the CEO agent's governance cycle, not through MCP.",
      }).body;

    case "ping":
      return rpcResult(id, {}).body;

    case "tools/list":
      return rpcResult(id, {
        tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }).body;

    case "resources/list":
      return rpcResult(id, { resources: [] }).body;

    case "prompts/list":
      return rpcResult(id, { prompts: [] }).body;

    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        return rpcError(
          id,
          -32602,
          `Unknown tool '${name}'. This server is READ-ONLY and exposes only: ${MCP_TOOLS.map((t) => t.name).join(", ")}.`,
        ).body;
      }
      try {
        const result = await tool.run(store, env, params.arguments ?? {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        }).body;
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }).body;
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`).body;
  }
}
