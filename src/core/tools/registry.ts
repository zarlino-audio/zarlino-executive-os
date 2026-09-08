/**
 * ToolRegistry — the typed registry + authority engine (spec §13).
 *
 * Every tool is registered once and executed through `run()`, which:
 *   1. validates input against the tool's zod schema,
 *   2. records a lifecycle record (RUNNING → SUCCESS/FAILED) via the sink,
 *   3. audits audit-required tools,
 *   4. returns a normalized `{ ok, output|error, executionId }` envelope.
 *
 * Risk/permission enforcement happens in the calling layer (the worker routes
 * gate HIGH/CRITICAL actions behind Founder approval before calling run()).
 */
import { z } from "zod";
import { newId, nowIso } from "../../ids";
import type { Tool, ToolContext, ToolExecutionRecord } from "./types";

export interface ToolRegistryOptions {
  recordExecution(record: ToolExecutionRecord): void;
}

export interface RegistryRunContext {
  env: Record<string, string | undefined>;
  store?: ToolContext["store"];
  audit?: ToolContext["audit"];
  recordCost?: ToolContext["recordCost"];
  runId?: string;
  sessionId?: string;
}

export type RegistryResult =
  | { ok: true; output: unknown; executionId: string }
  | { ok: false; error: string; executionId: string };

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly opts: ToolRegistryOptions) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async run(name: string, input: Record<string, unknown>, base: RegistryRunContext): Promise<RegistryResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}`, executionId: "" };

    const audit = base.audit ?? (() => {});
    const ctx: ToolContext = {
      env: base.env ?? {},
      store: base.store,
      audit,
      recordCost: base.recordCost,
      runId: base.runId,
      sessionId: base.sessionId,
    };

    const id = newId("tex");
    const now = nowIso();
    const record: ToolExecutionRecord = {
      id,
      tool_name: name,
      input_json: JSON.stringify(input ?? {}),
      permission: tool.requiredPermission,
      verdict: "APPROVED",
      status: "RUNNING",
      reversible: tool.reversible,
      run_id: base.runId,
      source: "executive",
      created_at: now,
      started_at: now,
    };
    this.opts.recordExecution(record);

    try {
      const parsed = tool.inputSchema.parse(input ?? {});
      const output = await tool.run(ctx, parsed);
      record.status = "SUCCESS";
      record.output_json = JSON.stringify(output ?? null);
      record.finished_at = nowIso();
      this.opts.recordExecution(record);
      if (tool.auditRequired) {
        audit("executive", `tool.${name}`, "tool_execution", id, { risk: tool.riskLevel, reversible: tool.reversible });
      }
      return { ok: true, output, executionId: id };
    } catch (err) {
      record.status = "FAILED";
      record.error = err instanceof Error ? err.message : String(err);
      record.finished_at = nowIso();
      this.opts.recordExecution(record);
      return { ok: false, error: record.error, executionId: id };
    }
  }

  /** Validate a tool's input without executing it (used for previews). */
  validate(name: string, input: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      return { ok: true, value: tool.inputSchema.parse(input ?? {}) };
    } catch (err) {
      return { ok: false, error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err) };
    }
  }

  /**
   * Provider-safe function schemas for OpenAI-compatible model APIs.
   *
   * DeepSeek (and several other providers) require tool names to match
   * `^[a-zA-Z0-9_-]+$` — dots are FORBIDDEN. Internal tool names use dotted
   * paths (e.g. `finance.get_snapshot`), so each is sanitized here
   * (dots → underscores) for the wire, and `resolveName()` maps a sanitized
   * name the model returns back to the real tool before execution.
   */
  functionSchemas(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return this.listTools().map((t) => ({
      type: "function" as const,
      function: {
        name: sanitizeToolName(t.name),
        description: t.description,
        parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
      },
    }));
  }

  /** Resolve a provider-sanitized tool name back to the real registered name. */
  resolveName(sanitized: string): string {
    for (const t of this.tools.values()) {
      if (sanitizeToolName(t.name) === sanitized) return t.name;
    }
    return sanitized;
  }
}

/** Sanitize a tool name for providers that forbid dots (DeepSeek). */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
