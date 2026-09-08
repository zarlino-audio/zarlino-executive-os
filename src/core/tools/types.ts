/**
 * Tool contract types (spec §7, §13). Every tool flows through the typed
 * registry + authority engine: permission class, risk level, reversibility,
 * audit requirement, and a zod-validated input schema.
 */
import { z } from "zod";
import type { ExecutiveStore } from "../../db/store";
import type { ModelCallRecord } from "../model/types";

export type Permission = "read" | "analyze" | "modify" | "create" | "execute";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ToolContext {
  env: Record<string, string | undefined>;
  store?: ExecutiveStore;
  /** Record an audit event (actor/action/entity). Never throws. */
  audit(
    actor: string,
    action: string,
    entityType?: string,
    entityId?: string,
    detail?: Record<string, unknown>,
  ): void;
  /** Record a model call's cost (if a cost store is attached). */
  recordCost?(call: ModelCallRecord): void;
  runId?: string;
  sessionId?: string;
}

export interface Tool<TSchema extends z.ZodType = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  requiredPermission: Permission;
  riskLevel: RiskLevel;
  reversible: boolean;
  auditRequired: boolean;
  run(ctx: ToolContext, input: z.infer<TSchema>): Promise<unknown> | unknown;
}

/** Record the registry writes for every tool execution (persisted to
 *  `tool_executions`). */
export interface ToolExecutionRecord {
  id: string;
  tool_name: string;
  input_json: string;
  output_json?: string;
  permission: Permission;
  verdict: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  cost_estimate?: number;
  reversible: boolean;
  run_id?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
  source?: string;
  created_at: string;
}
