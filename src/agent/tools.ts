/**
 * Tool wiring for the Executive Agent (spec §13).
 *
 * Builds the full ToolRegistry: external integrations (GitHub, Cloudflare,
 * website) plus internal store-backed tools (finance, projects, marketing,
 * executive). All tools flow through the typed registry + authority engine.
 */

import { z } from "zod";
import { ToolRegistry } from "../core/tools/registry";
import type { Tool, ToolContext } from "../core/tools/types";
import { githubTools } from "../integrations/github";
import { cloudflareTools } from "../integrations/cloudflare";
import { websiteTools } from "../integrations/website";
import { webTools } from "../integrations/web";
import { visionTools } from "../integrations/vision";
import { paystackTools } from "../integrations/paystack";
import { doctorTools } from "../core/doctor";
import { assessFinancials } from "../core/finance/calc";
import { createTask } from "../core/tasks/model";
import { createApprovalRequest } from "../core/approvals/queue";
import {
  assignTask,
  budgetStatus,
  detectContradictions,
  inferTaskSkills,
  optimize,
  productivityReport,
  recommendAssignment,
} from "../core/productivity/manager";
import { newId, nowIso } from "../ids";
import type { Decision, ProductValidation } from "../types";
import {
  aggregateTestResults,
  attentionCheckFailed,
  deriveKnowledge,
  evaluateProductGates,
  failureRecord,
  perceptualKpi,
  scoreProduct,
} from "../core/perceptual/manager";

/** Decode a base64 string to UTF-8 text (works in the Worker runtime). */
function atobSafe(b64: string): string {
  // Cloudflare Workers provide atob; Buffer is available via nodejs_compat.
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Internal tool input schemas
// ---------------------------------------------------------------------------

const snapSchema = z.object({});
const expenseSchema = z.object({ amount: z.number().positive(), category: z.string().max(64), note: z.string().max(500).optional() });
const revenueSchema = z.object({ amount: z.number().positive(), source: z.string().max(64), note: z.string().max(500).optional() });
const taskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  projectId: z.string().optional(),
  dueDate: z.string().optional(),
});
const taskUpdateSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  dueDate: z.string().optional(),
});
const taskIdSchema = z.object({ taskId: z.string().min(1) });
const campaignIdSchema = z.object({ campaignId: z.string().min(1) });
const experimentSchema = z.object({
  name: z.string().min(1).max(200),
  channel: z.string().max(64).optional(),
  budget: z.number().nonnegative().optional(),
  objective: z.string().max(1000).optional(),
});
const decisionCreateSchema = z.object({
  title: z.string().min(1).max(200),
  problem: z.string().min(1).max(2000),
  category: z.enum(["STRATEGIC", "FINANCIAL", "TECHNICAL", "OPERATIONAL", "MARKETING"]).optional(),
});
const approvalCreateSchema = z.object({
  action_label: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  expected_upside: z.string().max(500).optional(),
  max_downside: z.string().max(500).optional(),
  budget_available: z.string().max(500).optional(),
});
const execTaskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  decisionId: z.string().optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
});

/** Internal tools operate on the durable store via ctx.store. */
function internalTools(): Tool[] {
  return [
    {
      name: "finance.get_snapshot",
      description: "Get the latest financial snapshot (cash, revenue, expenses, runway)",
      inputSchema: snapSchema,
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: z.infer<typeof snapSchema>) => {
        const snap = ctx.store?.latestSnapshot() ?? null;
        return snap ?? { status: "UNKNOWN", note: "No financial snapshot recorded yet. Do not fabricate figures." };
      },
    },
    {
      name: "finance.calculate_runway",
      description: "Calculate runway months from the latest financial snapshot",
      inputSchema: snapSchema,
      requiredPermission: "analyze",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: z.infer<typeof snapSchema>) => {
        const snap = ctx.store?.latestSnapshot() ?? null;
        if (!snap) return { runwayMonths: null, unknown: ["no snapshot"] };
        const assessment = assessFinancials({
          cash: snap.cash,
          monthlyRevenue: snap.revenue,
          monthlyExpenses: snap.expenses,
        });
        return {
          runwayMonths: assessment.runwayMonths,
          netBurn: assessment.netBurn,
          unknown: assessment.unknown,
        };
      },
    },
    {
      name: "finance.record_expense",
      description: "Record an expense entry on the current financial snapshot",
      inputSchema: expenseSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof expenseSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const snap = store.latestSnapshot() ?? {
          id: newId("fin"),
          period: new Date().toISOString().slice(0, 7),
          confidence: "ESTIMATE" as const,
          source: "tool" as const,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        const expenses = (snap.expenses ?? 0) + input.amount;
        store.insertSnapshot({
          ...snap,
          id: newId("fin"),
          period: new Date().toISOString().slice(0, 7),
          expenses,
          notes: [snap.notes, `+$${input.amount} ${input.category}${input.note ? ` (${input.note})` : ""}`].filter(Boolean).join("; "),
          source: "tool",
          updated_at: nowIso(),
        });
        return { recorded: true, amount: input.amount, category: input.category };
      },
    },
    {
      name: "finance.record_revenue",
      description: "Record a revenue entry on the current financial snapshot",
      inputSchema: revenueSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof revenueSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const snap = store.latestSnapshot() ?? {
          id: newId("fin"),
          period: new Date().toISOString().slice(0, 7),
          confidence: "ESTIMATE" as const,
          source: "tool" as const,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        const revenue = (snap.revenue ?? 0) + input.amount;
        store.insertSnapshot({
          ...snap,
          id: newId("fin"),
          period: new Date().toISOString().slice(0, 7),
          revenue,
          notes: [snap.notes, `+$${input.amount} ${input.source}${input.note ? ` (${input.note})` : ""}`].filter(Boolean).join("; "),
          source: "tool",
          updated_at: nowIso(),
        });
        return { recorded: true, amount: input.amount, source: input.source };
      },
    },
    {
      name: "projects.create_task",
      description: "Create an internal task",
      inputSchema: taskCreateSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof taskCreateSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const task = createTask({
          title: input.title,
          description: input.description,
          project_id: input.projectId,
          priority: input.priority,
          due_date: input.dueDate,
          source: "executive",
        });
        store.insertTask(task);
        return { id: task.id, title: task.title, status: task.status };
      },
    },
    {
      name: "projects.update_task",
      description: "Update a task (status, priority, assignee, due date)",
      inputSchema: taskUpdateSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof taskUpdateSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const existing = store.getTask(input.taskId);
        if (!existing) throw new Error(`Task ${input.taskId} not found`);
        const patch: Record<string, string> = {};
        if (input.status) patch.status = input.status;
        if (input.priority) patch.priority = input.priority;
        if (input.dueDate) patch.due_date = input.dueDate;
        store.updateTask(input.taskId, patch as never);
        return { id: input.taskId, updated: true };
      },
    },
    {
      name: "projects.complete_task",
      description: "Mark a task as DONE",
      inputSchema: taskIdSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof taskIdSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        store.updateTask(input.taskId, { status: "DONE", completed_at: nowIso() } as never);
        return { id: input.taskId, status: "DONE" };
      },
    },
    {
      name: "marketing.get_campaign",
      description: "Get a marketing campaign by id",
      inputSchema: campaignIdSchema,
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof campaignIdSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const campaigns = store.listCampaigns();
        return campaigns.find((c) => c.id === input.campaignId) ?? { status: "NOT_FOUND" };
      },
    },
    {
      name: "marketing.create_experiment",
      description: "Create a small marketing experiment campaign",
      inputSchema: experimentSchema,
      requiredPermission: "execute",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof experimentSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = nowIso();
        store.insertCampaign({
          id: newId("cmp"),
          created_at: now,
          updated_at: now,
          source: "executive",
          name: input.name,
          channel: input.channel,
          budget: input.budget,
          spent: 0,
          objective: input.objective,
          status: "PLANNED",
        });
        return { created: true, name: input.name, status: "PLANNED" };
      },
    },
    {
      name: "marketing.list_campaigns",
      description: "List all marketing campaigns with status/budget/spent",
      inputSchema: z.object({ status: z.string().max(32).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const campaigns = store.listCampaigns();
        const filtered = input.status ? campaigns.filter((c) => c.status === input.status) : campaigns;
        return {
          campaigns: filtered.map((c) => ({
            id: c.id,
            name: c.name,
            channel: c.channel,
            status: c.status,
            budget: c.budget,
            spent: c.spent,
            objective: c.objective,
          })),
        };
      },
    },
    {
      name: "executive.list_approvals",
      description: "List approval requests pending for the Founder (or all by status)",
      inputSchema: z.object({ status: z.string().max(32).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const approvals = store.listApprovals(input.status ? { status: input.status as never } : undefined);
        return {
          approvals: approvals.map((a) => ({
            id: a.id,
            actionLabel: a.action_label,
            reason: a.reason,
            status: a.status,
            requestedBy: a.requested_by,
            created_at: a.created_at,
          })),
        };
      },
    },
    {
      name: "executive.list_decisions",
      description: "List recent decisions with status/outcome",
      inputSchema: z.object({ status: z.string().max(32).optional(), limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const decisions = store.listDecisions(input.status ? { status: input.status as never, limit: input.limit } : { limit: input.limit });
        return {
          decisions: decisions.map((d) => ({
            id: d.id,
            title: d.title,
            category: d.category,
            status: d.status,
            outcome_status: d.outcome_status,
            created_at: d.created_at,
          })),
        };
      },
    },
    {
      name: "executive.list_risks",
      description: "List open risks (or all by status/level)",
      inputSchema: z.object({ status: z.string().max(32).optional(), level: z.string().max(16).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string; level?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const risks = store.listRisks(
          input.status || input.level
            ? { status: input.status as never, level: input.level as never }
            : undefined,
        );
        return {
          risks: risks.map((r) => ({
            id: r.id,
            title: r.title,
            level: r.level,
            category: r.category,
            status: r.status,
            mitigation: r.mitigation,
          })),
        };
      },
    },
    {
      name: "executive.list_tasks",
      description: "List tasks (optionally by status or project)",
      inputSchema: z.object({ status: z.string().max(32).optional(), limit: z.number().int().min(1).max(200).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const tasks = store.listTasks(input.status ? { status: input.status as never } : undefined);
        const limited = input.limit ? tasks.slice(0, input.limit) : tasks;
        return {
          tasks: limited.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            assignee_person_id: t.assignee_person_id,
            project_id: t.project_id,
            created_at: t.created_at,
          })),
        };
      },
    },
    {
      name: "executive.list_products",
      description: "List all products (plugins) with their status and version",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return {
          products: store.listProducts().map((p) => ({
            id: p.id,
            name: p.name,
            status: p.status,
            version: p.version,
            category: p.category,
          })),
        };
      },
    },
    {
      name: "executive.list_activity",
      description: "List recent audit activity (who did what, when)",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const events = store.listAudit(input.limit ?? 25);
        return {
          events: events.map((e) => ({
            id: e.id,
            actor: e.actor,
            action: e.action,
            entity_type: e.entity_type,
            entity_id: e.entity_id,
            created_at: e.created_at,
          })),
        };
      },
    },
    {
      name: "executive.create_decision",
      description: "Create a decision record (does not execute)",
      inputSchema: decisionCreateSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof decisionCreateSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = nowIso();
        store.insertDecision({
          id: newId("dec"),
          created_at: now,
          updated_at: now,
          source: "executive",
          title: input.title,
          problem: input.problem,
          category: input.category ?? "OPERATIONAL",
          status: "DRAFT",
          approval_required: 0,
          outcome_status: "PENDING",
        });
        return { created: true, title: input.title };
      },
    },
    {
      name: "executive.request_approval",
      description: "Create an approval request for the Founder",
      inputSchema: approvalCreateSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof approvalCreateSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const request = createApprovalRequest({
          action_label: input.action_label,
          reason: input.reason,
          expected_upside: input.expected_upside,
          max_downside: input.max_downside,
          budget_available: input.budget_available,
          requested_by: "executive",
          source: "executive",
        });
        store.insertApproval(request);
        return { id: request.id, status: request.status };
      },
    },
    {
      name: "executive.create_task",
      description: "Create a task from an executive decision",
      inputSchema: execTaskCreateSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof execTaskCreateSchema>) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const task = createTask({
          title: input.title,
          decision_id: input.decisionId,
          priority: input.priority,
          source: "executive",
        });
        store.insertTask(task);
        return { id: task.id, title: task.title };
      },
    },
    {
      name: "executive.request_local_task",
      description:
        "Queue a task for the LOCAL machine (this dev machine, where the repo + plugin UI source live). The local daemon claims it, inspects plugin UI / repo files locally, runs commands or builds if needed, and posts a report back. Use this when you need to inspect something that only exists on the local machine (plugin UI source, local files, local builds). Returns a taskId to poll with executive.get_local_task.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000),
        taskId: z.string().max(64).optional(),
      }),
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { prompt: string; taskId?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const id = newId("ltk");
        const now = nowIso();
        store.createLocalTask({
          id,
          created_at: now,
          updated_at: now,
          source: "executive",
          task_id: input.taskId,
          prompt: input.prompt,
          status: "PENDING",
        });
        return {
          queued: true,
          taskId: id,
          note: "Queued for the local machine. Poll executive.get_local_task (or the web console Local Work card) for the result — the local daemon must be running.",
        };
      },
    },
    {
      name: "executive.delegate_idea",
      description:
        "Turn a high-level idea into concrete LOCAL implementation work (the bridge between the CEO's idea and the machine that can build it). You provide the idea + optional context; this tool creates a task for the local machine WITH a structured brief (goal, context, acceptance criteria, deliverable) so the local agent knows exactly what 'done' means. Returns a taskId to poll with executive.get_local_task.",
      inputSchema: z.object({
        idea: z.string().min(1).max(4000),
        context: z.string().max(4000).optional(),
        acceptance: z.string().max(2000).optional(),
        deliverable: z.string().max(1000).optional(),
        taskId: z.string().max(64).optional(),
      }),
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { idea: string; context?: string; acceptance?: string; deliverable?: string; taskId?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const id = newId("ltk");
        const now = nowIso();
        // Convert the idea into an implementation brief with explicit
        // acceptance criteria — the single biggest idea→implementation
        // failure is ambiguous 'done'. Structure it up front.
        const brief = {
          goal: input.idea,
          context: input.context ?? "",
          acceptance: input.acceptance ?? "The change works and the relevant tests/builds pass.",
          deliverable: input.deliverable ?? "",
        };
        const prompt = [
          `GOAL: ${input.idea}`,
          input.context ? `CONTEXT: ${input.context}` : "",
          `ACCEPTANCE CRITERIA (verify each before reporting DONE):\n${brief.acceptance}`,
          input.deliverable ? `DELIVERABLE: ${input.deliverable}` : "",
          "Work through PLAN → IMPLEMENT → VERIFY → REPORT using your local tools, then confirm every acceptance criterion.",
        ]
          .filter(Boolean)
          .join("\n\n");
        store.createLocalTask({
          id,
          created_at: now,
          updated_at: now,
          source: "executive",
          task_id: input.taskId,
          prompt,
          status: "PENDING",
          meta_json: JSON.stringify(brief),
        });
        ctx.audit("executive", "local.task.delegated", "local_task", id, { taskId: input.taskId });
        return {
          queued: true,
          taskId: id,
          brief,
          note: "Delegated to the local machine with a structured brief. Poll executive.get_local_task for the result.",
        };
      },
    },
    {
      name: "executive.get_local_task",
      description: "Get the current status + result of a local machine task (queued via executive.request_local_task).",
      inputSchema: z.object({ taskId: z.string().min(1).max(64) }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { taskId: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const task = store.getLocalTask(input.taskId);
        if (!task) return { taskId: input.taskId, status: "NOT_FOUND" };
        return {
          taskId: task.id,
          status: task.status,
          result: task.result,
          error: task.error,
          claimed_by: task.claimed_by,
          created_at: task.created_at,
          finished_at: task.finished_at,
        };
      },
    },
    {
      name: "executive.list_local_tasks",
      description: "List recent local machine tasks and their statuses/results.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return {
          tasks: store.listLocalTasks(input.limit ?? 25).map((t) => ({
            taskId: t.id,
            status: t.status,
            prompt: t.prompt.slice(0, 200),
            result: t.result,
            error: t.error,
            claimed_by: t.claimed_by,
            created_at: t.created_at,
            finished_at: t.finished_at,
          })),
        };
      },
    },
    {
      name: "executive.list_files",
      description: "List files the Founder uploaded from the web console (metadata: name, kind, size, when).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return {
          files: store.listUploadedFiles(input.limit ?? 50).map((f) => ({
            fileId: f.id,
            name: f.name,
            kind: f.kind,
            mime: f.mime,
            sizeBytes: f.size_bytes,
            created_at: f.created_at,
          })),
        };
      },
    },
    {
      name: "executive.get_file",
      description:
        "Read a file the Founder uploaded from the web console. For text files, returns the decoded content (up to ~30k chars). For images, returns a base64 data URL you can hand to vision.analyze_image. For audio/other, returns metadata only.",
      inputSchema: z.object({ fileId: z.string().min(1).max(64) }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { fileId: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const f = store.getUploadedFile(input.fileId);
        if (!f) return { fileId: input.fileId, status: "NOT_FOUND" };
        const base: Record<string, unknown> = {
          fileId: f.id,
          name: f.name,
          kind: f.kind,
          mime: f.mime,
          sizeBytes: f.size_bytes,
          created_at: f.created_at,
        };
        if (f.kind === "image" && f.data_base64) {
          base.dataUrl = `data:${f.mime ?? "image/png"};base64,${f.data_base64}`;
          // Directly consumable by vision.analyze_image (imageBase64 + mimeType).
          base.imageBase64 = f.data_base64;
          base.mimeType = f.mime ?? "image/png";
          base.note = "Call vision.analyze_image with imageBase64 = the imageBase64 field above and mimeType = the mimeType field above.";
        } else if (f.kind === "text" && f.data_base64) {
          try {
            const text = atobSafe(f.data_base64);
            base.content = text.length > 30_000 ? text.slice(0, 30_000) + "\n…(truncated)" : text;
          } catch {
            base.content = "(could not decode)";
          }
        }
        return base;
      },
    },
    {
      name: "pipeline.list_gates",
      description: "List the 10-gate pipeline status for all plugins (or a single plugin)",
      inputSchema: z.object({ pluginId: z.string().max(64).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { pluginId?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const gates = input.pluginId ? store.listPipelineGates(input.pluginId) : store.listPipelineGates();
        return {
          gates: gates.map((g) => ({
            id: g.id,
            pluginId: g.plugin_id,
            gateNumber: g.gate_number,
            gateName: g.gate_name,
            status: g.status,
            note: g.note,
            ownerRole: g.owner_role,
          })),
        };
      },
    },
    {
      name: "pipeline.update_gate",
      description: "Update a pipeline gate's status (NOT_STARTED/IN_PROGRESS/PASSED/FAILED/BLOCKED) and optional note",
      inputSchema: z.object({
        gateId: z.string().min(1).max(128),
        status: z.enum(["NOT_STARTED", "IN_PROGRESS", "PASSED", "FAILED", "BLOCKED"]),
        note: z.string().max(1000).optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { gateId: string; status: "NOT_STARTED" | "IN_PROGRESS" | "PASSED" | "FAILED" | "BLOCKED"; note?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const gate = store.listPipelineGates().find((g) => g.id === input.gateId);
        if (!gate) throw new Error(`Gate ${input.gateId} not found`);
        const patch: Record<string, string> = { status: input.status };
        if (input.note !== undefined) patch.note = input.note;
        store.updatePipelineGate(input.gateId, patch as never);
        return { id: input.gateId, pluginId: gate.plugin_id, gateNumber: gate.gate_number, status: input.status };
      },
    },


    // -- calendar (migration v14) ---------------------------------------
    {
      name: "calendar.list_events",
      description: "List calendar events. Pass from/to ISO dates to bound the range (default: this week). Returns title, times, status.",
      inputSchema: z.object({
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { from?: string; to?: string; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const from = validIso(input.from) ?? new Date().toISOString().slice(0, 10);
        const to = validIso(input.to) ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
        const events = store.listCalendarEvents(from, to, input.limit ?? 100);
        return {
          count: events.length,
          from,
          to,
          events: events.map((e) => ({
            id: e.id,
            title: e.title,
            startAt: e.start_at,
            endAt: e.end_at ?? null,
            allDay: Boolean(e.all_day),
            status: e.status,
            location: e.location ?? null,
          })),
        };
      },
    },
    {
      name: "calendar.create_event",
      description: "Create a calendar event. startAt/endAt are ISO-8601 (e.g. 2026-08-26T15:00:00Z); endAt optional. Returns the created event.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        startAt: z.string().min(8).max(40),
        endAt: z.string().min(8).max(40).optional(),
        allDay: z.boolean().optional(),
        location: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { title: string; startAt: string; endAt?: string; allDay?: boolean; location?: string; description?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const start = validIso(input.startAt);
        if (!start) throw new Error(`Invalid startAt (expected ISO-8601): ${input.startAt}`);
        const end = input.endAt ? validIso(input.endAt) : undefined;
        if (input.endAt && !end) throw new Error(`Invalid endAt (expected ISO-8601): ${input.endAt}`);
        if (end && end <= start) throw new Error("endAt must be after startAt");
        const now = nowIso();
        const ev = {
          id: newId("evt"),
          title: input.title.trim(),
          description: input.description?.trim() ?? null,
          start_at: start,
          end_at: end ?? null,
          all_day: input.allDay ? 1 : 0,
          location: input.location?.trim() ?? null,
          attendees_json: "[]",
          status: "SCHEDULED" as const,
          source: "executive" as const,
          created_at: now,
          updated_at: now,
        };
        store.createCalendarEvent(ev as never);
        return { id: ev.id, title: ev.title, startAt: start, endAt: end ?? null, status: "SCHEDULED" };
      },
    },
    {
      name: "calendar.update_event",
      description: "Update an existing calendar event (title, times, status SCHEDULED/CANCELLED/DONE). Returns the updated event.",
      inputSchema: z.object({
        eventId: z.string().min(1).max(128),
        title: z.string().min(1).max(200).optional(),
        startAt: z.string().min(8).max(40).optional(),
        endAt: z.string().min(8).max(40).optional(),
        status: z.enum(["SCHEDULED", "CANCELLED", "DONE"]).optional(),
        location: z.string().max(200).optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { eventId: string; title?: string; startAt?: string; endAt?: string; status?: "SCHEDULED" | "CANCELLED" | "DONE"; location?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const patch: Record<string, string | number> = {};
        if (input.title !== undefined) patch.title = input.title.trim();
        if (input.startAt !== undefined) {
          const s = validIso(input.startAt);
          if (!s) throw new Error(`Invalid startAt: ${input.startAt}`);
          patch.start_at = s;
        }
        if (input.endAt !== undefined) {
          const e = validIso(input.endAt);
          if (!e) throw new Error(`Invalid endAt: ${input.endAt}`);
          patch.end_at = e;
        }
        if (input.status !== undefined) patch.status = input.status;
        if (input.location !== undefined) patch.location = input.location.trim();
        const updated = store.updateCalendarEvent(input.eventId, patch as never);
        if (!updated) throw new Error(`Event ${input.eventId} not found`);
        return { id: updated.id, title: updated.title, startAt: updated.start_at, status: updated.status };
      },
    },
    {
      name: "calendar.delete_event",
      description: "Delete a calendar event by id. Returns { deleted: boolean }.",
      inputSchema: z.object({ eventId: z.string().min(1).max(128) }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { eventId: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return { deleted: store.deleteCalendarEvent(input.eventId) };
      },
    },

    // -- notes (migration v14) ------------------------------------------
    {
      name: "notes.create_note",
      description: "Capture a note (meeting notes, decision context, idea, follow-up). Returns the created note.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).optional(),
        tags: z.array(z.string().max(40)).max(10).optional(),
        pinned: z.boolean().optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { title: string; body?: string; tags?: string[]; pinned?: boolean }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = nowIso();
        const note = {
          id: newId("nt"),
          title: input.title.trim(),
          body: input.body?.trim() ?? null,
          tags_json: JSON.stringify((input.tags ?? []).slice(0, 10)),
          pinned: input.pinned ? 1 : 0,
          source: "executive" as const,
          created_at: now,
          updated_at: now,
        };
        store.createNote(note as never);
        return { id: note.id, title: note.title, pinned: Boolean(input.pinned) };
      },
    },
    {
      name: "notes.list_notes",
      description: "List saved notes (pinned first, then most recently updated).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const notes = store.listNotes(input.limit ?? 50);
        return {
          count: notes.length,
          notes: notes.map((n) => ({
            id: n.id,
            title: n.title,
            pinned: Boolean(n.pinned),
            tags: safeJsonArray(n.tags_json),
            bodyPreview: (n.body ?? "").slice(0, 300),
          })),
        };
      },
    },
    {
      name: "notes.delete_note",
      description: "Delete a note by id. Returns { deleted: boolean }.",
      inputSchema: z.object({ noteId: z.string().min(1).max(128) }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { noteId: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return { deleted: store.deleteNote(input.noteId) };
      },
    },

    // -- reminders (migration v14) --------------------------------------
    {
      name: "reminders.create_reminder",
      description: "Set a reminder with a due time (ISO-8601). The Executive surfaces overdue reminders. Returns the created reminder.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        dueAt: z.string().min(8).max(40),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { title: string; dueAt: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const due = validIso(input.dueAt);
        if (!due) throw new Error(`Invalid dueAt (expected ISO-8601): ${input.dueAt}`);
        const now = nowIso();
        const rem = {
          id: newId("rem"),
          title: input.title.trim(),
          due_at: due,
          done: 0,
          done_at: null,
          source: "executive" as const,
          created_at: now,
          updated_at: now,
        };
        store.createReminder(rem as never);
        return { id: rem.id, title: rem.title, dueAt: due, overdue: due < now };
      },
    },
    {
      name: "reminders.list_reminders",
      description: "List open reminders (soonest first). Set overdueOnly=true to see only overdue ones the Founder should act on.",
      inputSchema: z.object({ overdueOnly: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { overdueOnly?: boolean; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = new Date().toISOString();
        const reminders = store.listReminders({ overdueOnly: input.overdueOnly, limit: input.limit ?? 50 });
        return {
          count: reminders.length,
          reminders: reminders.map((r) => ({
            id: r.id,
            title: r.title,
            dueAt: r.due_at,
            overdue: r.due_at < now,
          })),
        };
      },
    },
    {
      name: "reminders.mark_done",
      description: "Mark a reminder as done by id. Returns the updated reminder.",
      inputSchema: z.object({ reminderId: z.string().min(1).max(128) }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { reminderId: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const updated = store.markReminderDone(input.reminderId);
        if (!updated) throw new Error(`Reminder ${input.reminderId} not found`);
        return { id: updated.id, title: updated.title, done: true };
      },
    },
    {
      name: "reminders.delete_reminder",
      description: "Delete a reminder by id. Returns { deleted: boolean }.",
      inputSchema: z.object({ reminderId: z.string().min(1).max(128) }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { reminderId: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return { deleted: store.deleteReminder(input.reminderId) };
      },
    },

    // -- contacts (migration v14) ---------------------------------------
    {
      name: "contacts.list_contacts",
      description: "List external contacts (partners, vendors, testers, reviewers, channels).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const contacts = store.listContacts(input.limit ?? 100);
        return {
          count: contacts.length,
          contacts: contacts.map((c) => ({
            id: c.id,
            name: c.name,
            role: c.role ?? null,
            company: c.company ?? null,
            email: c.email ?? null,
            tags: safeJsonArray(c.tags_json),
          })),
        };
      },
    },
    {
      name: "contacts.add_contact",
      description: "Add an external contact (name required; role/company/email/phone/tags optional). Returns the created contact.",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        role: z.string().max(200).optional(),
        company: z.string().max(200).optional(),
        email: z.string().max(300).optional(),
        phone: z.string().max(100).optional(),
        tags: z.array(z.string().max(40)).max(10).optional(),
        notes: z.string().max(2000).optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { name: string; role?: string; company?: string; email?: string; phone?: string; tags?: string[]; notes?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = nowIso();
        const contact = {
          id: newId("ct"),
          name: input.name.trim(),
          role: input.role?.trim() ?? null,
          company: input.company?.trim() ?? null,
          email: input.email?.trim() ?? null,
          phone: input.phone?.trim() ?? null,
          tags_json: JSON.stringify((input.tags ?? []).slice(0, 10)),
          notes: input.notes?.trim() ?? null,
          source: "executive" as const,
          created_at: now,
          updated_at: now,
        };
        store.createContact(contact as never);
        return { id: contact.id, name: contact.name, company: contact.company ?? null };
      },
    },

    // -- export / ops (day-to-day hardening) -----------------------------
    {
      name: "executive.export_csv",
      description: "Export a business table as CSV (calendar_events, tasks, notes, contacts, decisions, risks, products, pipeline_gates, memories, tool_executions, model_costs, local_tasks, agent_jobs). Useful for spreadsheets / backups.",
      inputSchema: z.object({
        table: z.enum([
          "calendar_events", "notes", "contacts", "tasks", "decisions", "risks",
          "products", "pipeline_gates", "memories", "tool_executions", "model_costs",
          "local_tasks", "agent_jobs",
        ]),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { table: string; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const snap = store.exportSnapshot();
        const rows = (snap[input.table] ?? []) as Array<Record<string, unknown>>;
        const bounded = rows.slice(0, input.limit ?? 500);
        if (bounded.length === 0) return { table: input.table, rows: 0, csv: "no data" };
        const cols = Array.from(new Set(bounded.flatMap((r) => Object.keys(r))));
        const esc = (v: unknown) => {
          const s = v === null || v === undefined ? "" : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [cols.join(","), ...bounded.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
        // Bound what is fed back to the model (keep it readable).
        return { table: input.table, rows: bounded.length, total: rows.length, csv: csv.length > 20_000 ? csv.slice(0, 20_000) + "\n…(truncated)" : csv };
      },
    },
    {
      name: "website.sitemap_check",
      description: "Probe the website's sitemap.xml and return the URLs it declares, with live HTTP status for each. Useful for SEO/QA after a deploy.",
      inputSchema: z.object({ path: z.string().max(300).optional(), limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { path?: string; limit?: number }) => {
        const baseUrl = ctx.env.WEBSITE_URL ?? "https://zarlinoaudio.com";
        const sitemapUrl = `${baseUrl.replace(/\/$/, "")}/${(input.path ?? "sitemap.xml").replace(/^\/+/, "")}`;
        const res = await fetch(sitemapUrl, { redirect: "follow" });
        if (!res.ok) return { url: sitemapUrl, status: res.status, ok: false, note: "sitemap not reachable" };
        const xml = await res.text();
        const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]).filter((x): x is string => !!x).slice(0, input.limit ?? 60);
        const withStatus = await Promise.all(
          urls.map(async (u) => {
            try {
              const r = await fetch(u, { method: "HEAD", redirect: "follow" });
              return { url: u, status: r.status };
            } catch {
              return { url: u, status: 0, error: "unreachable" };
            }
          }),
        );
        return { url: sitemapUrl, status: res.status, ok: true, pageCount: urls.length, pages: withStatus };
      },
    },
    {
      name: "review.request_sound_approval",
      description:
        "File a SOUND review for the operator: when you have produced or discovered an audio A/B (e.g. a rendered plugin comparison, a saturation/tone change, an A/B WAV pair uploaded to files), submit it for the operator to LISTEN and approve/reject. Pass the uploaded-file ids for audioA and audioB, a short title, and a description of what differs and why it matters. This is how sound decisions are vetted remotely — not just text decisions.",
      inputSchema: z.object({
        title: z.string().min(3).max(300),
        description: z.string().max(2000).optional(),
        audioAFileId: z.string().optional(),
        audioBFileId: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { title: string; description?: string; audioAFileId?: string; audioBFileId?: string; meta?: Record<string, unknown> }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = new Date().toISOString();
        const id = newId("rev");
        store.createReviewItem({
          id,
          kind: "sound",
          title: input.title,
          description: input.description ?? "",
          status: "PENDING",
          payload_json: JSON.stringify({ audioA: input.audioAFileId, audioB: input.audioBFileId, meta: input.meta ?? {} }),
          source: "agent",
          created_at: now,
          updated_at: now,
        });
        return { ok: true, id, kind: "sound", status: "PENDING", note: "Operator can now listen and approve/reject from the console Reviews queue." };
      },
    },
    {
      name: "review.request_ui_approval",
      description:
        "File a UI review for the operator: when you have a plugin UI screenshot (uploaded file id) or a UI inspection/report that needs sign-off, submit it for the operator to LOOK and approve/reject. Pass the image fileId (or the report text), a title, and what to verify.",
      inputSchema: z.object({
        title: z.string().min(3).max(300),
        description: z.string().max(2000).optional(),
        imageFileId: z.string().optional(),
        report: z.string().max(4000).optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { title: string; description?: string; imageFileId?: string; report?: string; meta?: Record<string, unknown> }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const now = new Date().toISOString();
        const id = newId("rev");
        store.createReviewItem({
          id,
          kind: "ui",
          title: input.title,
          description: input.description ?? "",
          status: "PENDING",
          payload_json: JSON.stringify({ image: input.imageFileId, report: input.report ?? "", meta: input.meta ?? {} }),
          source: "agent",
          created_at: now,
          updated_at: now,
        });
        return { ok: true, id, kind: "ui", status: "PENDING", note: "Operator can now look and approve/reject from the console Reviews queue." };
      },
    },
    {
      name: "review.list_reviews",
      description: "List review-queue items (sound / UI / document / build) so you know what the operator is vetting and what is already approved or needs work.",
      inputSchema: z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "NEEDS_WORK"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const items = store.listReviewItems({ status: input.status as never, limit: input.limit ?? 50 });
        return {
          count: items.length,
          pending: store.countPendingReviews(),
          items: items.map((r) => ({
            id: r.id, kind: r.kind, title: r.title, status: r.status,
            decided_by: r.decided_by ?? null, note: r.note ?? null, created_at: r.created_at,
          })),
        };
      },
    },
  ];
}

/** Parse + validate an ISO-8601 datetime string; returns normalized ISO or null. */
function validIso(v: string | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/** Parse a JSON array string defensively (never throws). */
function safeJsonArray(json: string | undefined | null): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Productivity Manager tools
// ---------------------------------------------------------------------------

const productivityTaskIdSchema = z.object({ taskId: z.string().min(1) });
const productivityAssignSchema = z.object({
  taskId: z.string().min(1),
  roleId: z.string().optional(),
  assignee: z.string().max(200).optional(),
  modelTier: z.enum(["cheap", "medium", "strong"]).optional(),
  tokenBudget: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});
const productivityResolveSchema = z.object({
  contradictionId: z.string().min(1),
  status: z.enum(["RESOLVED", "DISMISSED"]).optional(),
  resolution: z.string().min(1).max(2000),
});
const productivityRecordTokensSchema = z.object({
  scope: z.enum(["global", "role", "task"]),
  scopeId: z.string().optional(),
  tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative().optional(),
});

/** Tools for the Productivity Manager (budgets, assignments, optimization, contradictions). */
function productivityTools(): Tool[] {
  return [
    {
      name: "productivity.report",
      description:
        "Get the Productivity Manager report: token budgets per scope with usage %, assignments by status, open contradictions, optimization events, daily metrics, and per-role cost efficiency (cost per completed task).",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        return productivityReport(ctx.store!);
      },
    },
    {
      name: "productivity.budget",
      description: "Get the current token-budget posture across all scopes (global/role/task), including usage percentages and OVER/WARN flags.",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        return { budgets: budgetStatus(ctx.store!) };
      },
    },
    {
      name: "productivity.recommend_assignment",
      description:
        "Recommend the best role for a task based on skill coverage and historical cost efficiency. Use before assigning so work goes to the cheapest competent role.",
      inputSchema: productivityTaskIdSchema,
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof productivityTaskIdSchema>) => {
        const task = ctx.store!.getTask(input.taskId);
        if (!task) return { error: `Task not found: ${input.taskId}` };
        return recommendAssignment(ctx.store!, task);
      },
    },
    {
      name: "productivity.assign",
      description:
        "Assign a task to a role/assignee for tracked execution. Creates a productivity assignment with a token budget and cost estimate; also sets the task's assignee. Pass roleId to override the automatic best-role recommendation.",
      inputSchema: productivityAssignSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof productivityAssignSchema>) => {
        const id = assignTask(ctx.store!, input.taskId, {
          roleId: input.roleId,
          assignee: input.assignee,
          modelTier: input.modelTier,
          tokenBudget: input.tokenBudget,
          note: input.note,
        });
        ctx.audit?.("executive", "productivity.assign", "productivity_assignments", id, {
          taskId: input.taskId,
          roleId: input.roleId,
        });
        return { ok: true, assignmentId: id };
      },
    },
    {
      name: "productivity.optimize",
      description:
        "Run Productivity optimizations: auto-fix stale assignments, recalibrate global budget to env defaults, reallocate budget from under-utilized to over-utilized scopes, and produce recommendations (batching, skill gaps, model-tier downgrades). Safe fixes are applied and recorded.",
      inputSchema: z.object({}),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        const result = optimize(ctx.store!, ctx.env ?? {});
        ctx.audit?.("executive", "productivity.optimize", "optimization_events", "productivity", {
          applied: result.summary.applied,
          recommended: result.summary.recommended,
        });
        return result;
      },
    },
    {
      name: "productivity.detect_contradictions",
      description:
        "Scan the store for contradictions and misconceptions (stale approved decisions, done-but-running tasks, duplicate open tasks, shipped products with open gates, auto-run blocked tasks, misassignments, budget-override mismatches). Opens records for resolution; identical findings are not duplicated.",
      inputSchema: z.object({}),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        return detectContradictions(ctx.store!);
      },
    },
    {
      name: "productivity.list_contradictions",
      description: "List contradiction/misconception records, optionally filtered by status (OPEN/RESOLVED/DISMISSED).",
      inputSchema: z.object({ status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { status?: string }) => {
        return { contradictions: ctx.store!.listContradictions({ status: input.status, limit: 200 }) };
      },
    },
    {
      name: "productivity.resolve_contradiction",
      description:
        "Resolve a contradiction/misconception: record the resolution and mark it RESOLVED (or DISMISSED). The resolution text is audited so the correction is traceable.",
      inputSchema: productivityResolveSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: false,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof productivityResolveSchema>) => {
        const existing = ctx.store!.getContradiction(input.contradictionId);
        if (!existing) return { error: `Contradiction not found: ${input.contradictionId}` };
        const status = input.status ?? "RESOLVED";
        ctx.store!.resolveContradiction(input.contradictionId, status, input.resolution, "executive");
        ctx.audit?.("executive", `productivity.contradiction.${status.toLowerCase()}`, "contradictions", input.contradictionId, {
          resolution: input.resolution,
        });
        return { ok: true, id: input.contradictionId, status };
      },
    },
    {
      name: "productivity.record_token_usage",
      description:
        "Record token/cost usage against a scope budget (global/role/task). Keeps budget tracking accurate so optimization can reallocate. Task scope also updates the linked assignment's actuals.",
      inputSchema: productivityRecordTokensSchema,
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof productivityRecordTokensSchema>) => {
        ctx.store!.addTokenUse(input.scope, input.scopeId, input.tokens, input.cost ?? input.tokens * 0.0000008);
        return { ok: true };
      },
    },
    {
      name: "productivity.skills",
      description: "Inspect the roles & skills inventory and infer required skills for a task. Useful for spotting skill gaps before assigning.",
      inputSchema: z.object({ taskId: z.string().optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { taskId?: string }) => {
        const roleSkills = ctx.store!.listRoleSkills();
        const byRole = new Map<string, Array<{ skill: string; proficiency: number }>>();
        for (const rs of roleSkills) {
          if (!byRole.has(rs.role_id)) byRole.set(rs.role_id, []);
          byRole.get(rs.role_id)!.push({ skill: rs.skill, proficiency: rs.proficiency });
        }
        let inferred: Array<{ skill: string; weight: number }> | null = null;
        if (input.taskId) {
          const task = ctx.store!.getTask(input.taskId);
          if (task) inferred = inferTaskSkills(task);
        }
        return { roles: [...byRole.entries()].map(([roleId, skills]) => ({ roleId, skills })), inferred };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Perceptual Intelligence tools (specs/zarlino-artificial-organization.md)
// ---------------------------------------------------------------------------

const perceptualEvaluatorSchema = z.object({
  name: z.string().min(1).max(120),
  actorType: z.enum(["external_human", "internal_agent", "customer"]).optional(),
  expertise: z.string().max(300).optional(),
  genres: z.array(z.string().max(40)).max(20).optional(),
  experienceLevel: z.string().max(80).optional(),
  compensationProfile: z.string().max(300).optional(),
  conflicts: z.array(z.string().max(120)).max(20).optional(),
});
const perceptualTestSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  testType: z.enum(["blind_preference", "abx_identification", "problem_solution", "workflow", "preference_reach"]).optional(),
  hypothesis: z.string().max(2000).optional(),
  objective: z.string().max(2000).optional(),
  protocol: z.string().max(4000).optional(),
  stimuli: z.array(z.string().max(200)).max(50).optional(),
  conditions: z.array(z.string().max(200)).max(20).optional(),
  evaluatorRequirements: z.string().max(1000).optional(),
  sampleSizeTarget: z.number().int().min(0).max(1000).optional(),
  blinding: z.enum(["blind", "double_blind", "unblinded"]).optional(),
  randomization: z.string().max(300).optional(),
  metrics: z.array(z.string().max(80)).max(20).optional(),
  acceptanceThreshold: z.string().max(500).optional(),
  tier: z.enum(["exploratory", "validation", "high_confidence", "commercial"]).optional(),
});
const perceptualResultSchema = z.object({
  testId: z.string().min(1),
  evaluatorId: z.string().min(1),
  responses: z.record(z.string(), z.unknown()),
  attentionChecksPassed: z.number().int().min(0).max(20).optional(),
  attentionChecksTotal: z.number().int().min(0).max(20).optional(),
  selfConfidence: z.number().min(0).max(1).optional(),
  completionMs: z.number().int().positive().max(7_200_000).optional(),
});
const perceptualValidationSchema = z.object({
  productId: z.string().min(1).max(64),
  stage: z.enum(["prototype", "validation", "beta", "ship"]).optional(),
  engineering: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
  measurement: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
  perceptual: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
  workflow: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
  commercial: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
  governance: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
  decision: z.string().max(40).optional(),
  decisionNote: z.string().max(1000).optional(),
  iteration: z.number().int().min(0).max(50).optional(),
});
const perceptualKnowledgeSchema = z.object({
  productCategory: z.string().min(1).max(120),
  musicalContext: z.string().max(500).optional(),
  desiredOutcome: z.string().max(500).optional(),
  observations: z.array(z.string().max(1000)).max(30).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sampleSize: z.number().int().min(0).max(10000).optional(),
  testProtocol: z.string().max(1000).optional(),
  sourceTestId: z.string().max(64).optional(),
  evidenceTier: z.enum(["engineering", "measurement", "perceptual", "workflow", "market"]).optional(),
});
const perceptualFailureSchema = z.object({
  productId: z.string().min(1).max(64),
  failureClass: z.enum(["discovery", "hypothesis", "dsp", "perceptual", "workflow", "positioning", "market", "execution"]),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  lessons: z.array(z.string().max(1000)).max(20).optional(),
});
const perceptualScoreSchema = z.object({
  perceptual: z.number().min(0).max(1).optional(),
  problemSeverity: z.number().min(0).max(1).optional(),
  differentiation: z.number().min(0).max(1).optional(),
  workflow: z.number().min(0).max(1).optional(),
  marketDemand: z.number().min(0).max(1).optional(),
  cpu: z.number().min(0).max(1).optional(),
  stability: z.number().min(0).max(1).optional(),
  monetization: z.number().min(0).max(1).optional(),
});

/**
 * Perceptual Intelligence tools. Rules baked in (spec):
 *   - results are append-only and can never be edited (spec §9 — product
 *     agents must not control the perceptual result);
 *   - evaluators are explicitly typed external_human | internal_agent |
 *     customer (spec §5);
 *   - the validation tool computes the decision matrix; it never overwrites a
 *     recorded founder decision, and it reports conflicts instead of hiding
 *     them (spec §24, §26).
 */
function perceptualTools(): Tool[] {
  return [
    {
      name: "perceptual.kpi",
      description:
        "Perceptual Intelligence KPIs: Validated Product Yield (commercially viable / serious experiments), tests by status and tier, active evaluators, evidence gaps (products with insufficient perceptual evidence), and average prototype→decision cycle days.",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        return perceptualKpi(ctx.store!);
      },
    },
    {
      name: "perceptual.list_tests",
      description: "List controlled listening tests from the registry, optionally filtered by product, status, or tier. Every significant perceptual decision must reference one of these records (spec §6).",
      inputSchema: z.object({
        productId: z.string().max(64).optional(),
        status: z.string().max(32).optional(),
        tier: z.string().max(32).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { productId?: string; status?: string; tier?: string; limit?: number }) => {
        return { tests: ctx.store!.listPerceptualTests({ productId: input.productId, status: input.status, tier: input.tier, limit: input.limit ?? 100 }) };
      },
    },
    {
      name: "perceptual.create_test",
      description:
        "Register a controlled listening test (blind preference, ABX identification, problem-solution, workflow, or preference/reach). Requires a product id, title, and optionally the protocol, blinding, sample-size target and tier (spec §6-7, §10, §13).",
      inputSchema: perceptualTestSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualTestSchema>) => {
        const now = nowIso();
        const id = newId("pt");
        ctx.store!.createPerceptualTest({
          id,
          product_id: input.productId,
          title: input.title,
          hypothesis: input.hypothesis ?? "",
          objective: input.objective ?? "",
          test_type: input.testType ?? "blind_preference",
          protocol: input.protocol ?? "",
          stimuli_json: JSON.stringify(input.stimuli ?? []),
          conditions_json: JSON.stringify(input.conditions ?? []),
          evaluator_requirements: input.evaluatorRequirements ?? "",
          sample_size_target: input.sampleSizeTarget ?? 0,
          blinding: input.blinding ?? "blind",
          randomization: input.randomization ?? "",
          metrics_json: JSON.stringify(input.metrics ?? []),
          acceptance_threshold: input.acceptanceThreshold ?? "",
          tier: input.tier ?? "exploratory",
          status: "designed",
          source: "executive",
          created_at: now,
          updated_at: now,
        });
        ctx.audit?.("executive", "perceptual.test.create", "perceptual_tests", id, { productId: input.productId, title: input.title });
        return { ok: true, id };
      },
    },
    {
      name: "perceptual.update_test",
      description: "Update a test's status or protocol (e.g. move designed → recruiting → in_progress → completed). Results themselves can never be edited.",
      inputSchema: z.object({ testId: z.string().min(1), status: z.string().max(32).optional(), protocol: z.string().max(4000).optional() }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { testId: string; status?: string; protocol?: string }) => {
        const t = ctx.store!.getPerceptualTest(input.testId);
        if (!t) return { error: `Test not found: ${input.testId}` };
        ctx.store!.updatePerceptualTest(input.testId, { status: input.status ?? t.status, protocol: input.protocol ?? t.protocol });
        ctx.audit?.("executive", "perceptual.test.update", "perceptual_tests", input.testId, { status: input.status });
        return { ok: true, id: input.testId };
      },
    },
    {
      name: "perceptual.list_evaluators",
      description: "List panel members of the external human ear network, with expertise, genres, per-domain reliability and availability (spec §4-5, §11).",
      inputSchema: z.object({ actorType: z.string().max(32).optional(), limit: z.number().int().min(1).max(200).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { actorType?: string; limit?: number }) => {
        return { evaluators: ctx.store!.listPerceptualEvaluators({ actorType: input.actorType, limit: input.limit ?? 100 }) };
      },
    },
    {
      name: "perceptual.register_evaluator",
      description:
        "Register a human evaluator on the panel. External humans are evaluators, NOT employees or agents (spec §5). Compensation must be for qualified participation, never for favorable results (spec §30); conflicts of interest must be disclosed and preserved as metadata (spec §31).",
      inputSchema: perceptualEvaluatorSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualEvaluatorSchema>) => {
        const now = nowIso();
        const id = newId("pev");
        ctx.store!.createPerceptualEvaluator({
          id,
          name: input.name,
          actor_type: input.actorType ?? "external_human",
          expertise: input.expertise ?? "",
          genres_json: JSON.stringify(input.genres ?? []),
          experience_level: input.experienceLevel ?? "",
          reliability_score: 0,
          calibration_score: 0,
          reliability_by_domain_json: "{}",
          availability: "active",
          compensation_profile: input.compensationProfile ?? "",
          conflicts_json: JSON.stringify(input.conflicts ?? []),
          test_count: 0,
          source: "executive",
          created_at: now,
          updated_at: now,
        });
        ctx.audit?.("executive", "perceptual.evaluator.register", "perceptual_evaluators", id, { name: input.name, actorType: input.actorType ?? "external_human" });
        return { ok: true, id };
      },
    },
    {
      name: "perceptual.record_result",
      description:
        "Record ONE evaluator's responses to ONE test. Append-only evidence: results can never be edited or deleted afterwards, so the product team cannot manipulate the perceptual outcome (spec §9). Failed attention checks reject the response automatically (spec §11).",
      inputSchema: perceptualResultSchema,
      requiredPermission: "modify",
      riskLevel: "MEDIUM",
      reversible: false,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualResultSchema>) => {
        const test = ctx.store!.getPerceptualTest(input.testId);
        if (!test) return { error: `Test not found: ${input.testId}` };
        const evaluator = ctx.store!.getPerceptualEvaluator(input.evaluatorId);
        if (!evaluator) return { error: `Evaluator not found: ${input.evaluatorId}` };
        const passed = input.attentionChecksPassed ?? 0;
        const total = input.attentionChecksTotal ?? 0;
        const rejected = attentionCheckFailed({ attention_checks_passed: passed, attention_checks_total: total });
        const id = newId("prs");
        ctx.store!.createPerceptualResult({
          id,
          test_id: input.testId,
          evaluator_id: input.evaluatorId,
          responses_json: JSON.stringify(input.responses),
          completion_ms: input.completionMs,
          attention_checks_passed: passed,
          attention_checks_total: total,
          self_confidence: input.selfConfidence,
          status: rejected ? "rejected" : "accepted",
          source: "executive",
          created_at: nowIso(),
        });
        ctx.store!.updatePerceptualEvaluator(input.evaluatorId, { test_count: evaluator.test_count + 1 });
        ctx.audit?.("executive", rejected ? "perceptual.result.rejected" : "perceptual.result.record", "perceptual_results", id, {
          testId: input.testId,
          evaluatorId: input.evaluatorId,
          attention: `${passed}/${total}`,
        });
        return { ok: true, id, status: rejected ? "rejected" : "accepted" };
      },
    },
    {
      name: "perceptual.analyze_test",
      description:
        "Analyze a completed test: aggregate accepted responses (rejected attention failures excluded), compute preference majority or ABX detection significance (binomial), flag weak evidence when the sample is below the tier minimum (spec §13), and preview the derived knowledge entry. Read-only — makes no product decision.",
      inputSchema: z.object({ testId: z.string().min(1) }),
      requiredPermission: "analyze",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { testId: string }) => {
        const test = ctx.store!.getPerceptualTest(input.testId);
        if (!test) return { error: `Test not found: ${input.testId}` };
        const results = ctx.store!.listPerceptualResults({ testId: input.testId, limit: 1000 });
        const agg = aggregateTestResults(test, results);
        return { aggregation: agg, knowledgeDraft: deriveKnowledge(test, agg) };
      },
    },
    {
      name: "perceptual.list_validations",
      description: "List product validation gates (six evidence layers per product: engineering, measurement, perceptual, workflow, commercial, governance) with the decision-matrix recommendation for each (spec §14, §26).",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, _input: Record<string, never>) => {
        return {
          validations: ctx.store!.listProductValidations().map((v) => ({ ...v, evaluation: evaluateProductGates(v) })),
        };
      },
    },
    {
      name: "perceptual.set_validation",
      description:
        "Set or update a product's validation gate (PASS/FAIL/INCONCLUSIVE per evidence layer). This does NOT make the decision — it records evidence. The decision matrix computes a recommendation; a recorded founder decision is never overwritten, and conflicts stay visible (spec §24, §26). Technical completion is NOT product validation (spec §14).",
      inputSchema: perceptualValidationSchema,
      requiredPermission: "modify",
      riskLevel: "MEDIUM",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualValidationSchema>) => {
        const existing = ctx.store!.getProductValidation(input.productId);
        const now = nowIso();
        const row: ProductValidation = {
          product_id: input.productId,
          stage: input.stage ?? existing?.stage ?? "prototype",
          engineering: input.engineering ?? existing?.engineering ?? "INCONCLUSIVE",
          measurement: input.measurement ?? existing?.measurement ?? "INCONCLUSIVE",
          perceptual: input.perceptual ?? existing?.perceptual ?? "INCONCLUSIVE",
          workflow: input.workflow ?? existing?.workflow ?? "INCONCLUSIVE",
          commercial: input.commercial ?? existing?.commercial ?? "INCONCLUSIVE",
          governance: input.governance ?? existing?.governance ?? "PASS",
          decision: input.decision ?? existing?.decision ?? "NONE",
          decision_by: input.decision ? "executive" : existing?.decision_by,
          decision_note: input.decisionNote ?? existing?.decision_note,
          iteration: input.iteration ?? existing?.iteration ?? 0,
          notes_json: existing?.notes_json ?? "[]",
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        ctx.store!.upsertProductValidation(row);
        ctx.audit?.("executive", "perceptual.validation.set", "product_validations", input.productId, {
          stage: row.stage,
          perceptual: row.perceptual,
          decision: row.decision,
        });
        return { ok: true, validation: { ...row, evaluation: evaluateProductGates(row) } };
      },
    },
    {
      name: "perceptual.add_knowledge",
      description:
        "Store validated perceptual knowledge in organizational memory: DSP behavior → perceptual consequence → musical context → producer preference (spec §27-29, §40). Store the underlying knowledge, not just a score. Raw evaluator conversation is never stored.",
      inputSchema: perceptualKnowledgeSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualKnowledgeSchema>) => {
        const now = nowIso();
        const id = newId("pk");
        ctx.store!.createPerceptualKnowledge({
          id,
          product_category: input.productCategory,
          musical_context: input.musicalContext ?? "",
          desired_outcome: input.desiredOutcome ?? "",
          observation_json: JSON.stringify(input.observations ?? []),
          confidence: input.confidence ?? 0,
          sample_size: input.sampleSize ?? 0,
          test_protocol: input.testProtocol ?? "",
          source_test_id: input.sourceTestId,
          evidence_tier: input.evidenceTier ?? "perceptual",
          source: "executive",
          created_at: now,
          updated_at: now,
        });
        ctx.audit?.("executive", "perceptual.knowledge.add", "perceptual_knowledge", id, { productCategory: input.productCategory });
        return { ok: true, id };
      },
    },
    {
      name: "perceptual.list_knowledge",
      description: "Retrieve structured perceptual knowledge from organizational memory, optionally filtered by product category or evidence tier. This is what future product hypotheses should draw on (spec §29, §40).",
      inputSchema: z.object({ productCategory: z.string().max(120).optional(), evidenceTier: z.string().max(32).optional(), limit: z.number().int().min(1).max(200).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { productCategory?: string; evidenceTier?: string; limit?: number }) => {
        return { knowledge: ctx.store!.listPerceptualKnowledge({ productCategory: input.productCategory, evidenceTier: input.evidenceTier, limit: input.limit ?? 100 }) };
      },
    },
    {
      name: "perceptual.record_failure",
      description:
        "Classify a product failure using the taxonomy (discovery / hypothesis / dsp / perceptual / workflow / positioning / market / execution) and record the lesson (spec §39). Engineering hours are not wasted — they become organizational learning (spec §33).",
      inputSchema: perceptualFailureSchema,
      requiredPermission: "create",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualFailureSchema>) => {
        const rec = failureRecord({
          id: newId("pfl"),
          productId: input.productId,
          failureClass: input.failureClass,
          title: input.title,
          description: input.description ?? "",
          lessons: input.lessons,
          now: nowIso(),
        });
        ctx.store!.createFailureAnalysis(rec);
        ctx.audit?.("executive", "perceptual.failure.record", "failure_analyses", rec.id, { productId: input.productId, failureClass: rec.failure_class });
        return { ok: true, id: rec.id };
      },
    },
    {
      name: "perceptual.score_product",
      description:
        "Score a product with the versioned scoring model (default weights: perceptual 30%, problem severity 20%, differentiation 15%, workflow 10%, market 10%, CPU 5%, stability 5%, monetization 5%). Weights are configurable and versioned — never permanent truth (spec §16).",
      inputSchema: perceptualScoreSchema,
      requiredPermission: "analyze",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: z.infer<typeof perceptualScoreSchema>) => {
        const result = scoreProduct(
          {
            perceptual: input.perceptual,
            problem_severity: input.problemSeverity,
            differentiation: input.differentiation,
            workflow: input.workflow,
            market_demand: input.marketDemand,
            cpu: input.cpu,
            stability: input.stability,
            monetization: input.monetization,
          },
          ctx.store,
        );
        return result;
      },
    },
  ];
}

export function buildToolRegistry(deps: {
  env: Record<string, string | undefined>;
  sink: { recordExecution(record: unknown): void };
}): ToolRegistry {
  const registry = new ToolRegistry({
    recordExecution: (record) => deps.sink.recordExecution(record),
  });
  const env = deps.env;
  for (const tool of [
    ...githubTools(env),
    ...cloudflareTools(env),
    ...websiteTools(env),
    ...webTools(env),
    ...visionTools(env),
    ...paystackTools({ env }),
    ...doctorTools(),
    ...productivityTools(),
    ...perceptualTools(),
    ...internalTools(),
  ]) {
    registry.register(tool);
  }
  return registry;
}
