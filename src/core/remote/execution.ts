/**
 * Remote execution — engineering work runs on GitHub Actions, never the VM.
 *
 * Architectural contract (spec §2.5): the virtual CEO dispatches authorized
 * engineering work to remote infrastructure (GitHub Actions), tracks it,
 * collects the evidence, and records the outcome. The machine/VM is the
 * communication and intelligence environment only; it may not claim
 * engineering tasks (see core/org/execution-boundary.ts).
 *
 * Lifecycle of one remote run (all states persisted in `remote_runs`):
 *
 *   dispatchRemoteWorkflow()        → row DISPATCHED, GitHub run located
 *   syncRemoteRun() (poll few min)  → QUEUED / IN_PROGRESS
 *   syncRemoteRun() terminal        → COMPLETED (conclusion success)
 *                                     FAILED   (any other conclusion)
 *                                     CANCELLED (conclusion cancelled)
 *                                     UNMATCHED (dispatch never appeared)
 *   finalize: evidence attached to the linked task (verified only on success),
 *   audit + org message recorded. A failed run NEVER auto-completes anything.
 *
 * Bounds: one HTTP call per sync per run, 15s timeout, max `limit` runs per
 * sweep, 45s minimum sync interval, no retry loops. Idempotency: an active run
 * for the same (task, repo, workflow) is refused — duplicate dispatches of the
 * same work are a bug, not a retry.
 */
import type { ExecutiveStore } from "../../db/store";
import type { RemoteRun } from "../../types";
import { newId, nowIso } from "../../ids";

export interface RemoteEnv {
  GITHUB_TOKEN?: string;
}

export const ACTIVE_REMOTE_STATUSES = ["DISPATCHED", "QUEUED", "IN_PROGRESS", "CANCEL_REQUESTED"] as const;

export function isActiveRemoteStatus(status: string): boolean {
  return (ACTIVE_REMOTE_STATUSES as readonly string[]).includes(status);
}

/** How long a dispatch may stay unmatched before it is declared UNMATCHED. */
export const UNMATCHED_AFTER_MS = 15 * 60_000;
/** Minimum gap between two syncs of the same run. */
export const SYNC_MIN_GAP_MS = 45_000;
/** Dispatch → wait at most this long before first locate attempt is final. */
const GITHUB_API = "https://api.github.com";

interface GhResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}

async function gh(env: RemoteEnv, path: string, init?: { method?: string; body?: unknown }): Promise<GhResult> {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, status: 0, json: null, text: "GITHUB_TOKEN not configured" };
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "zarlino-executive-os",
        Authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: err instanceof Error ? err.message : String(err) };
  }
}

export interface DispatchInput {
  repo: string;
  workflow: string;
  ref?: string;
  inputs?: Record<string, string>;
  taskId?: string;
  objectiveId?: string;
  source?: string;
}

export interface DispatchDecision {
  ok: boolean;
  code?: "NOT_CONFIGURED" | "INVALID" | "DUPLICATE" | "WORKFLOW_NOT_FOUND" | "DISPATCH_FAILED";
  error?: string;
  run?: RemoteRun;
  existingId?: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

/**
 * Dispatch an authorized workflow and persist the run. Refuses:
 *   - missing GITHUB_TOKEN (fail closed — remote execution is unavailable),
 *   - a malformed repo / workflow reference,
 *   - a workflow that does not exist in the repository,
 *   - a duplicate: an ACTIVE run already exists for the same task + workflow.
 */
export async function dispatchRemoteWorkflow(
  store: ExecutiveStore,
  env: RemoteEnv,
  input: DispatchInput,
): Promise<DispatchDecision> {
  const repo = (input.repo ?? "").trim();
  const workflow = (input.workflow ?? "").trim();
  const ref = (input.ref ?? "main").trim() || "main";
  if (!REPO_RE.test(repo)) return { ok: false, code: "INVALID", error: `repo must be owner/name (received "${repo}")` };
  if (!WORKFLOW_RE.test(workflow)) {
    return { ok: false, code: "INVALID", error: `workflow must be a file name ending in .yml/.yaml (received "${workflow}")` };
  }
  if (!env.GITHUB_TOKEN) {
    return { ok: false, code: "NOT_CONFIGURED", error: "GITHUB_TOKEN not configured — remote execution via GitHub Actions is unavailable." };
  }

  // Idempotency: never dispatch the same workflow twice for the same task
  // while a previous run is still active. A duplicate dispatch is work
  // duplication, not a retry.
  if (input.taskId) {
    const active = store.findActiveRemoteRun(input.taskId, repo, workflow);
    if (active) {
      return {
        ok: false,
        code: "DUPLICATE",
        existingId: active.id,
        error:
          `DUPLICATE: ${workflow} is already ${active.status} for task ${input.taskId} (run ${active.id}` +
          `${active.run_url ? `, ${active.run_url}` : ""}). Sync it instead of dispatching again.`,
      };
    }
  }

  // Validate the workflow exists before dispatching — a dispatch to a
  // non-existent workflow is recorded as a failure, not a silent no-op.
  const check = await gh(env, `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}`);
  if (check.status === 404) {
    return { ok: false, code: "WORKFLOW_NOT_FOUND", error: `workflow ${workflow} not found in ${repo}` };
  }
  if (!check.ok) {
    return { ok: false, code: "DISPATCH_FAILED", error: `workflow lookup failed (HTTP ${check.status}): ${check.text.slice(0, 160)}` };
  }
  const workflowJson = (check.json ?? {}) as { id?: number; name?: string };

  const dispatchedAtMs = Date.now();
  const dispatch = await gh(env, `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    body: { ref, ...(input.inputs && Object.keys(input.inputs).length ? { inputs: input.inputs } : {}) },
  });
  if (!dispatch.ok) {
    return {
      ok: false,
      code: "DISPATCH_FAILED",
      error: `GitHub dispatch failed (HTTP ${dispatch.status}): ${dispatch.text.slice(0, 200)}`,
    };
  }

  const at = nowIso();
  const id = newId("rrun");
  store.createRemoteRun({
    id,
    task_id: input.taskId,
    objective_id: input.objectiveId,
    repo,
    workflow_file: workflow,
    ref,
    inputs_json: input.inputs && Object.keys(input.inputs).length ? JSON.stringify(input.inputs) : undefined,
    status: "DISPATCHED",
    dispatched_at: at,
    source: input.source ?? "executive",
    created_at: at,
    updated_at: at,
  });
  store.insertAudit({
    id: newId("aud"),
    actor: "executive",
    action: "remote.dispatched",
    entity_type: "remote_runs",
    entity_id: id,
    detail_json: JSON.stringify({ repo, workflow, ref, task_id: input.taskId ?? null, objective_id: input.objectiveId ?? null }),
    source: "runtime",
    created_at: at,
    updated_at: at,
  });

  let run = store.getRemoteRun(id);
  if (!run) return { ok: false, code: "DISPATCH_FAILED", error: "remote run row missing after insert" };
  // Best-effort immediate locate; syncRemoteRun retries on the maintenance sweep.
  try {
    run = (await locateDispatchedRun(store, env, run, dispatchedAtMs, workflowJson.id)) ?? run;
  } catch {
    /* locate is best-effort; the sweep will retry */
  }
  return { ok: true, run };
}

/** Find the GitHub run created by our dispatch (dispatch API returns no id). */
async function locateDispatchedRun(
  store: ExecutiveStore,
  env: RemoteEnv,
  run: RemoteRun,
  dispatchedAtMs: number,
  workflowId?: number,
): Promise<RemoteRun | null> {
  const listing = await gh(
    env,
    `/repos/${run.repo}/actions/runs?event=workflow_dispatch&branch=${encodeURIComponent(run.ref)}&per_page=10`,
  );
  if (!listing.ok) return null;
  const runs = ((listing.json ?? {}) as { workflow_runs?: Array<Record<string, unknown>> }).workflow_runs ?? [];
  const candidates = runs
    .filter((r) => {
      const createdAt = Date.parse(String(r.created_at ?? ""));
      if (!Number.isFinite(createdAt) || createdAt < dispatchedAtMs - 120_000) return false;
      if (workflowId !== undefined && r.workflow_id !== undefined && Number(r.workflow_id) !== workflowId) return false;
      const path = String(r.path ?? "");
      return !path || path.endsWith(`/${run.workflow_file}`) || path === run.workflow_file;
    })
    .sort((a, b) => Date.parse(String(b.created_at ?? "")) - Date.parse(String(a.created_at ?? "")));
  const best = candidates[0];
  if (!best) return null;
  return applyGithubRun(store, run, best, { located: true });
}

/** Map a GitHub run object into the persisted remote run. */
function applyGithubRun(
  store: ExecutiveStore,
  run: RemoteRun,
  ghRun: Record<string, unknown>,
  opts: { located?: boolean; artifacts?: Array<Record<string, unknown>> } = {},
): RemoteRun {
  const ghStatus = String(ghRun.status ?? "");
  const conclusion = ghRun.conclusion ? String(ghRun.conclusion) : undefined;
  let status = run.status;
  if (ghStatus === "queued" || ghStatus === "requested" || ghStatus === "waiting" || ghStatus === "pending") status = "QUEUED";
  else if (ghStatus === "in_progress") status = "IN_PROGRESS";
  else if (ghStatus === "completed") {
    status = conclusion === "success" ? "COMPLETED" : conclusion === "cancelled" ? "CANCELLED" : "FAILED";
  }
  const patch: Partial<RemoteRun> = {
    status,
    conclusion,
    github_run_id: ghRun.id !== undefined ? String(ghRun.id) : run.github_run_id,
    run_url: ghRun.html_url ? String(ghRun.html_url) : run.run_url,
    last_synced_at: nowIso(),
    updated_at: nowIso(),
    error: status === "FAILED" ? `GitHub Actions concluded ${conclusion ?? "unknown"}` : status === "UNMATCHED" ? run.error : undefined,
  };
  if (opts.artifacts) patch.artifacts_json = JSON.stringify(opts.artifacts);
  if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") patch.finished_at = nowIso();
  store.updateRemoteRun(run.id, patch);
  const next = store.getRemoteRun(run.id) ?? { ...run, ...patch };
  if ((status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") && !run.finished_at) {
    finalizeRemoteRun(store, next, ghRun);
  }
  return next;
}

/** On terminal state: attach task evidence + org message + audit. Never throws. */
function finalizeRemoteRun(store: ExecutiveStore, run: RemoteRun, ghRun: Record<string, unknown>): void {
  const at = nowIso();
  const success = run.status === "COMPLETED";
  let evidenceId: string | undefined;
  if (run.task_id) {
    try {
      const artifacts = safeArtifactNames(run.artifacts_json);
      const output = [
        `conclusion=${run.conclusion ?? "unknown"}`,
        `url=${run.run_url ?? "(no url)"}`,
        ghRun.head_sha ? `head_sha=${String(ghRun.head_sha)}` : "",
        artifacts.length ? `artifacts=${artifacts.join(", ")}` : "artifacts=none",
      ]
        .filter(Boolean)
        .join("\n");
      const evidence = store.addTaskEvidence(run.task_id, {
        kind: "command_output",
        locator: run.run_url ?? `github:${run.repo}/${run.workflow_file}@${run.ref}`,
        summary: `Remote CI ${run.workflow_file} on ${run.repo} @ ${run.ref} concluded ${run.conclusion ?? "unknown"}`,
        verification_command: `GitHub Actions (${run.workflow_file} @ ${run.ref}) run ${run.github_run_id ?? "unmatched"}`,
        verification_output: output,
        verified: success,
        source: "remote_ci",
      });
      evidenceId = evidence.id;
      store.updateRemoteRun(run.id, { evidence_id: evidenceId, updated_at: at });
    } catch {
      /* evidence attach must never break sync */
    }
  }
  try {
    store.sendOrgMessage({
      fromRole: "role_qa_verification",
      toRole: "role_coa",
      type: success ? "RESULT" : "DEVIATION",
      taskId: run.task_id ?? undefined,
      payload: {
        remote_run: run.id,
        repo: run.repo,
        workflow: run.workflow_file,
        conclusion: run.conclusion ?? "unknown",
        url: run.run_url ?? null,
        verified: success,
      },
    });
  } catch {
    /* protocol message is best-effort */
  }
  try {
    store.insertAudit({
      id: newId("aud"),
      actor: "executive",
      action: success ? "remote.completed" : "remote.failed",
      entity_type: "remote_runs",
      entity_id: run.id,
      detail_json: JSON.stringify({
        repo: run.repo,
        workflow: run.workflow_file,
        conclusion: run.conclusion ?? null,
        url: run.run_url ?? null,
        evidence_id: evidenceId ?? null,
        task_id: run.task_id ?? null,
      }),
      source: "runtime",
      created_at: at,
      updated_at: at,
    });
  } catch {
    /* audit is best-effort */
  }
}

export interface SyncResult {
  run: RemoteRun;
  changed: boolean;
  note?: string;
}

/** Poll one run's status (and artifacts on completion). */
export async function syncRemoteRun(store: ExecutiveStore, env: RemoteEnv, runId: string): Promise<SyncResult | null> {
  let run = store.getRemoteRun(runId);
  if (!run) return null;

  if (!run.github_run_id) {
    const ageMs = Date.now() - Date.parse(run.dispatched_at);
    const located = await locateDispatchedRun(store, env, run, Date.parse(run.dispatched_at), undefined);
    if (located) return { run: located, changed: true, note: "run located" };
    if (Number.isFinite(ageMs) && ageMs > UNMATCHED_AFTER_MS && run.status === "DISPATCHED") {
      store.updateRemoteRun(run.id, {
        status: "UNMATCHED",
        error: "Dispatched but no GitHub run appeared within 15 minutes — the workflow may lack workflow_dispatch on this ref, or dispatch permission is missing.",
        last_synced_at: nowIso(),
        updated_at: nowIso(),
      });
      const next = store.getRemoteRun(run.id) ?? run;
      finalizeRemoteRun(store, next, {});
      return { run: next, changed: true, note: "unmatched" };
    }
    store.updateRemoteRun(run.id, { last_synced_at: nowIso(), updated_at: nowIso() });
    return { run: store.getRemoteRun(run.id) ?? run, changed: false, note: "awaiting run id" };
  }

  const res = await gh(env, `/repos/${run.repo}/actions/runs/${run.github_run_id}`);
  if (!res.ok) {
    store.updateRemoteRun(run.id, { last_synced_at: nowIso(), updated_at: nowIso() });
    return { run: store.getRemoteRun(run.id) ?? run, changed: false, note: `sync failed (HTTP ${res.status})` };
  }
  const ghRun = (res.json ?? {}) as Record<string, unknown>;
  let artifacts: Array<Record<string, unknown>> | undefined;
  const ghStatus = String(ghRun.status ?? "");
  if (ghStatus === "completed") {
    const list = await gh(env, `/repos/${run.repo}/actions/runs/${run.github_run_id}/artifacts?per_page=50`);
    if (list.ok) {
      artifacts = ((list.json ?? {}) as { artifacts?: Array<Record<string, unknown>> }).artifacts ?? [];
    }
  }
  const before = run.status;
  const next = applyGithubRun(store, run, ghRun, { located: true, artifacts });
  return { run: next, changed: next.status !== before || ghStatus !== "", note: artifacts ? `${artifacts.length} artifact(s)` : undefined };
}

/** Bounded sync sweep for the maintenance loop: a few runs per wake. */
export async function syncActiveRemoteRuns(
  store: ExecutiveStore,
  env: RemoteEnv,
  limit = 3,
): Promise<{ synced: number; notes: string[] }> {
  const active = store.listActiveRemoteRuns(limit * 2).filter((r) => {
    if (!r.last_synced_at) return true;
    const age = Date.now() - Date.parse(r.last_synced_at);
    return !Number.isFinite(age) || age >= SYNC_MIN_GAP_MS;
  });
  const notes: string[] = [];
  let synced = 0;
  for (const run of active.slice(0, limit)) {
    try {
      const r = await syncRemoteRun(store, env, run.id);
      if (r) {
        synced += 1;
        if (r.note) notes.push(`${run.id}: ${r.note}`);
      }
    } catch (err) {
      notes.push(`${run.id}: sync error ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { synced, notes };
}

export interface CancelRemoteResult {
  ok: boolean;
  note: string;
}

/** Request cancellation of one active run (propagates to GitHub where supported). */
export async function cancelRemoteRun(store: ExecutiveStore, env: RemoteEnv, runId: string, reason?: string): Promise<CancelRemoteResult> {
  const run = store.getRemoteRun(runId);
  if (!run) return { ok: false, note: `remote run ${runId} not found` };
  if (!isActiveRemoteStatus(run.status)) {
    return { ok: false, note: `remote run ${runId} is ${run.status} — nothing to cancel` };
  }
  const at = nowIso();
  store.updateRemoteRun(run.id, {
    status: "CANCEL_REQUESTED",
    cancel_requested_at: at,
    error: reason ? `cancelled: ${reason}` : run.error,
    updated_at: at,
  });
  if (!run.github_run_id) {
    return { ok: true, note: `cancel recorded for ${run.id}; no GitHub run id yet (sync will finalize)` };
  }
  const res = await gh(env, `/repos/${run.repo}/actions/runs/${run.github_run_id}/cancel`, { method: "POST" });
  if (res.ok || res.status === 202) {
    return { ok: true, note: `cancellation requested for GitHub run ${run.github_run_id}` };
  }
  if (res.status === 409) {
    // Already completed — sync immediately to record the true terminal state.
    try {
      await syncRemoteRun(store, env, run.id);
    } catch {
      /* sync is best-effort */
    }
    const after = store.getRemoteRun(run.id);
    return { ok: true, note: `GitHub run already finished (${after?.status ?? "unknown"}); recorded the real state instead of a fake cancel` };
  }
  return { ok: false, note: `GitHub cancel failed (HTTP ${res.status}): ${res.text.slice(0, 140)}` };
}

/** Cancel every active run for a task (used by executive.cancel_task). */
export async function cancelRemoteRunsForTask(
  store: ExecutiveStore,
  env: RemoteEnv,
  taskId: string,
  reason?: string,
): Promise<{ attempted: number; notes: string[] }> {
  const active = store.listRemoteRunsForTask(taskId).filter((r) => isActiveRemoteStatus(r.status));
  const notes: string[] = [];
  for (const run of active) {
    try {
      const r = await cancelRemoteRun(store, env, run.id, reason);
      notes.push(`${run.id}: ${r.note}`);
    } catch (err) {
      notes.push(`${run.id}: cancel error ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { attempted: active.length, notes };
}

/** Compact executive-facing summary for reports and the CEO digest. */
export function remoteRunsSummary(store: ExecutiveStore): {
  active: number;
  completedLast7d: number;
  failedLast7d: number;
  latest: Array<{ id: string; repo: string; workflow: string; status: string; conclusion?: string; url?: string }>;
} {
  const runs = store.listRemoteRuns(50);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let completed = 0;
  let failed = 0;
  for (const r of runs) {
    const at = Date.parse(r.finished_at ?? r.updated_at ?? "");
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (r.status === "COMPLETED") completed += 1;
    if (r.status === "FAILED" || r.status === "UNMATCHED") failed += 1;
  }
  return {
    active: runs.filter((r) => isActiveRemoteStatus(r.status)).length,
    completedLast7d: completed,
    failedLast7d: failed,
    latest: runs.slice(0, 8).map((r) => ({
      id: r.id,
      repo: r.repo,
      workflow: r.workflow_file,
      status: r.status,
      conclusion: r.conclusion ?? undefined,
      url: r.run_url ?? undefined,
    })),
  };
}

function safeArtifactNames(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<{ name?: unknown; expired?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a) => a && a.expired !== true)
      .map((a) => String(a.name ?? ""))
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}
