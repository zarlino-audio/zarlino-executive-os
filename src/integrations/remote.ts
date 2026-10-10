/**
 * Remote execution tools — the virtual CEO's engineering dispatch plane.
 *
 * Engineering work runs on GitHub Actions. These tools are the ONLY sanctioned
 * path from an objective/task to real engineering execution (spec §2.5, §8):
 *
 *   remote.dispatch_workflow — validate + dispatch + persist a remote run
 *   remote.sync_runs         — poll status, collect artifacts/evidence
 *   remote.list_runs         — inspect remote execution state
 *   remote.cancel_run        — propagate cancellation to GitHub
 *
 * Local machine dispatch (executive.request_local_task) is restricted to
 * non-engineering machine maintenance by the execution boundary and can never
 * replace a remote run.
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";
import {
  cancelRemoteRun,
  dispatchRemoteWorkflow,
  remoteRunsSummary,
  syncActiveRemoteRuns,
  syncRemoteRun,
} from "../core/remote/execution";
import type { RemoteRun } from "../types";

function runView(r: RemoteRun) {
  return {
    id: r.id,
    taskId: r.task_id ?? null,
    objectiveId: r.objective_id ?? null,
    repo: r.repo,
    workflow: r.workflow_file,
    ref: r.ref,
    status: r.status,
    conclusion: r.conclusion ?? null,
    runId: r.github_run_id ?? null,
    url: r.run_url ?? null,
    evidenceId: r.evidence_id ?? null,
    error: r.error ?? null,
    dispatchedAt: r.dispatched_at,
    finishedAt: r.finished_at ?? null,
  };
}

export function remoteTools(): Tool[] {
  return [
    {
      name: "remote.dispatch_workflow",
      description:
        "Dispatch an authorized GitHub Actions workflow (engineering execution runs REMOTELY — never on the local machine/VM). Validates the workflow exists, refuses duplicate active dispatches for the same task, records a persistent remote run, and returns its id/url for tracking. Use remote.sync_runs to collect status and artifacts. Attach the run to a task (taskId) so completion evidence lands on the board.",
      inputSchema: z.object({
        repo: z.string().min(3).max(200),
        workflow: z.string().min(5).max(200),
        ref: z.string().max(120).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        taskId: z.string().max(64).optional(),
        objectiveId: z.string().max(64).optional(),
      }),
      requiredPermission: "execute",
      riskLevel: "MEDIUM",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { repo: string; workflow: string; ref?: string; inputs?: Record<string, string>; taskId?: string; objectiveId?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        if (input.taskId && !store.getTask(input.taskId)) return { dispatched: false, error: `task ${input.taskId} not found` };
        if (input.objectiveId && !store.getObjective(input.objectiveId)) return { dispatched: false, error: `objective ${input.objectiveId} not found` };
        const decision = await dispatchRemoteWorkflow(store, ctx.env as { GITHUB_TOKEN?: string }, {
          repo: input.repo,
          workflow: input.workflow,
          ref: input.ref,
          inputs: input.inputs,
          taskId: input.taskId,
          objectiveId: input.objectiveId,
        });
        return decision.ok && decision.run
          ? { dispatched: true, run: runView(decision.run), note: "Remote run recorded. Poll with remote.sync_runs; evidence attaches to the linked task automatically." }
          : { dispatched: false, code: decision.code ?? "ERROR", error: decision.error, existingId: decision.existingId ?? null };
      },
    },
    {
      name: "remote.sync_runs",
      description:
        "Poll GitHub for the status of dispatched runs. Without runId: syncs a bounded batch of active runs. With runId: syncs that one. On completion, artifacts and conclusion are recorded and verification evidence is attached to the linked task (verified only when the conclusion is success). Failed runs are recorded as failures — they never mark anything complete.",
      inputSchema: z.object({ runId: z.string().max(80).optional(), limit: z.number().int().min(1).max(10).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { runId?: string; limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const env = ctx.env as { GITHUB_TOKEN?: string };
        if (input.runId) {
          const r = await syncRemoteRun(store, env, input.runId);
          return r ? { synced: 1, run: runView(r.run), note: r.note ?? null } : { synced: 0, error: `remote run ${input.runId} not found` };
        }
        const sweep = await syncActiveRemoteRuns(store, env, input.limit ?? 3);
        const runs = store.listActiveRemoteRuns(10).map(runView);
        return { synced: sweep.synced, notes: sweep.notes, active: runs.length, runs };
      },
    },
    {
      name: "remote.list_runs",
      description: "List recent remote (GitHub Actions) runs with status, conclusion, url and linked evidence.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { limit?: number }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        return { summary: remoteRunsSummary(store), runs: store.listRemoteRuns(input.limit ?? 20).map(runView) };
      },
    },
    {
      name: "remote.cancel_run",
      description:
        "Cancel an active remote run (propagates to GitHub where supported). If the GitHub run already finished, the true terminal state is recorded instead of pretending it was cancelled.",
      inputSchema: z.object({ runId: z.string().min(3).max(80), reason: z.string().max(300).optional() }),
      requiredPermission: "modify",
      riskLevel: "MEDIUM",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { runId: string; reason?: string }) => {
        const store = ctx.store;
        if (!store) throw new Error("store unavailable");
        const r = await cancelRemoteRun(store, ctx.env as { GITHUB_TOKEN?: string }, input.runId, input.reason);
        return { ok: r.ok, note: r.note };
      },
    },
  ];
}
