/**
 * Factory build dispatch and reconciliation.
 *
 * One immutable build id, one durable record. This module is the only place
 * that talks to GitHub on the factory's behalf, and it never trusts a browser:
 *
 *   dispatch   create the durable row in QUEUED, then POST a workflow dispatch
 *              with the validated spec as an input value (never interpolated
 *              into a command line). A failed dispatch fails the build closed.
 *
 *   reconcile  READY is decided by the artifact store, not by a claim: the
 *              publish job uploads `build-record.json` only after the quality
 *              gate passed, and `completeBuild` still requires
 *              record.qaPassed === true AND record.qaReport.passed === true.
 *              Anything else â€” a failed run, a missing record past the build
 *              deadline, a provider error â€” becomes FAILED. There is no path
 *              from an unverified artifact to a downloadable product.
 */

import type { Sql } from "../../db/sql";
import {
  FactoryBuildError,
  attachBuildRun,
  completeBuild,
  createBuild,
  failBuild,
  getBuild,
  isTerminalState,
  type FactoryBuild,
} from "./builds";

export const FACTORY_WORKFLOW_FILE = "factory-build.yml";
export const FACTORY_REPO_DEFAULT = "zarlino-audio/Zarlino";
export const FACTORY_BUILD_REF_DEFAULT = "main";
export const DEFAULT_MAX_BUILD_MINUTES = 45;

export interface FactoryEnv {
  GITHUB_TOKEN?: string;
  FACTORY_REPO?: string;
  FACTORY_BUILD_REF?: string;
  GITHUB_API_BASE?: string;
  FACTORY_MAX_BUILD_MINUTES?: string;
}

/** Structural slice of the R2 bucket the factory reads. */
export interface ArtifactBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface DispatchDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface FactoryDispatchInput {
  buildId: string;
  requestId?: string;
  accountId?: string;
  productId: string;
  productName: string;
  productVersion: string;
  uiTemplate: string;
  spec: unknown;
  specSha256: string;
  sourceCommit?: string;
}

export type DispatchResult =
  | { ok: true; build: FactoryBuild }
  | { ok: false; code: string; message: string; build: FactoryBuild | null; status: number };

function gh(env: FactoryEnv, path: string, init: RequestInit = {}, fetchImpl: typeof fetch): Promise<Response> {
  const base = env.GITHUB_API_BASE ?? "https://api.github.com";
  return fetchImpl(`${base}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "zarlino-factory",
      authorization: "Bearer " + (env.GITHUB_TOKEN ?? ""),
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function factoryRepo(env: FactoryEnv): string {
  const repo = (env.FACTORY_REPO ?? FACTORY_REPO_DEFAULT).trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : FACTORY_REPO_DEFAULT;
}

function factoryRef(env: FactoryEnv): string {
  const ref = (env.FACTORY_BUILD_REF ?? FACTORY_BUILD_REF_DEFAULT).trim();
  return /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes("..") ? ref : FACTORY_BUILD_REF_DEFAULT;
}

export function maxBuildMinutes(env: FactoryEnv): number {
  const value = Number(env.FACTORY_MAX_BUILD_MINUTES);
  return Number.isFinite(value) && value >= 5 && value <= 180 ? Math.trunc(value) : DEFAULT_MAX_BUILD_MINUTES;
}

/**
 * Create the durable record and dispatch the workflow.
 * Fails closed: a build that could not be dispatched is FAILED, never QUEUED for ever.
 */
export async function dispatchFactoryBuild(
  sql: Sql,
  env: FactoryEnv,
  input: FactoryDispatchInput,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let build: FactoryBuild;
  try {
    build = createBuild(sql, {
      id: input.buildId,
      requestId: input.requestId,
      accountId: input.accountId,
      productId: input.productId,
      productName: input.productName,
      productVersion: input.productVersion,
      uiTemplate: input.uiTemplate,
      spec: input.spec,
      specSha256: input.specSha256,
      sourceCommit: input.sourceCommit,
      targetPlatform: "windows-x86_64",
    });
  } catch (error) {
    if (error instanceof FactoryBuildError) {
      return { ok: false, code: error.code, message: error.message, build: getBuild(sql, input.buildId), status: error.status };
    }
    throw error;
  }

  if (!env.GITHUB_TOKEN) {
    const failed = failBuild(sql, input.buildId, "DISPATCH_NOT_CONFIGURED", "GITHUB_TOKEN is not configured on this deployment.");
    return {
      ok: false,
      code: "DISPATCH_NOT_CONFIGURED",
      message: "The build service is not configured on this deployment.",
      build: failed,
      status: 503,
    };
  }

  const repo = factoryRepo(env);
  const ref = factoryRef(env);

  let response: Response;
  try {
    response = await gh(
      env,
      `/repos/${repo}/actions/workflows/${encodeURIComponent(FACTORY_WORKFLOW_FILE)}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref,
          inputs: {
            build_id: input.buildId,
            spec_json: JSON.stringify(input.spec),
            ui_template: input.uiTemplate,
            source_commit: input.sourceCommit ?? "",
            request_id: input.requestId ?? "",
          },
        }),
      },
      fetchImpl,
    );
  } catch (error) {
    const failed = failBuild(sql, input.buildId, "DISPATCH_FAILED", `network error: ${describe(error)}`);
    return { ok: false, code: "DISPATCH_FAILED", message: "Could not reach the build service.", build: failed, status: 502 };
  }

  if (response.status !== 204 && response.status !== 201 && response.status !== 200) {
    const detail = await response.text().catch(() => "");
    const failureState = response.status === 404 ? "WORKFLOW_NOT_FOUND" : response.status === 401 || response.status === 403 ? "DISPATCH_UNAUTHORIZED" : "DISPATCH_FAILED";
    const failed = failBuild(sql, input.buildId, failureState, { status: response.status, detail: detail.slice(0, 300) });
    return {
      ok: false,
      code: failureState,
      message: "The build service refused the request.",
      build: failed,
      status: 502,
    };
  }

  // The run id is not returned by the dispatch API; the reconciliation pass
  // discovers it (and the artifact record is the ground truth for READY).
  attachBuildRun(sql, input.buildId, null, `https://github.com/${repo}/actions/workflows/${encodeURIComponent(FACTORY_WORKFLOW_FILE)}`);

  const refreshed = getBuild(sql, input.buildId);
  return { ok: true, build: refreshed ?? build };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface SyncDeps {
  bucket?: ArtifactBucket | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxMinutes?: number;
}

export interface SyncResult {
  build: FactoryBuild;
  /** Where the decision came from â€” useful in logs and tests. */
  source: "terminal" | "record" | "run_failure" | "timeout" | "pending";
}

/** R2 key of a build's evidence record, written only after the gate passed. */
export function buildRecordKey(buildId: string): string {
  return `factory-builds/${buildId}/build-record.json`;
}

/**
 * Bring one build's state up to date with backend truth.
 * Idempotent: a terminal build is returned untouched.
 */
export async function syncFactoryBuild(sql: Sql, env: FactoryEnv, buildId: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const build = getBuild(sql, buildId);
  if (!build) throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${buildId} not found`, 404);
  if (isTerminalState(String(build.status))) return { build, source: "terminal" };

  // 1. The published evidence record is the only route to READY.
  if (deps.bucket) {
    const object = await deps.bucket.get(buildRecordKey(buildId)).catch(() => null);
    if (object) {
      const text = await object.text();
      let record: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text);
        record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        record = null;
      }
      if (record) {
        const completed = completeBuild(sql, buildId, {
          status: "READY",
          githubRunId: record.githubRunId === undefined ? undefined : String(record.githubRunId),
          record,
        });
        return { build: completed, source: "record" };
      }
      // A corrupt record must never be treated as success.
      const failed = failBuild(sql, buildId, "EVIDENCE_INVALID", "the published build record could not be parsed");
      return { build: failed, source: "record" };
    }
  }

  // 2. A finished, unsuccessful run is a failure now, not in an hour.
  const run = await findRunState(env, build, deps.fetchImpl ?? fetch);
  if (run && run.conclusion && run.conclusion !== "success") {
    const failed = failBuild(sql, buildId, run.conclusion === "cancelled" ? "BUILD_CANCELLED" : "BUILD_RUN_FAILED", {
      runId: run.id,
      conclusion: run.conclusion,
    });
    attachBuildRun(sql, buildId, run.id ? String(run.id) : null, run.html_url ?? null);
    return { build: getBuild(sql, buildId) ?? failed, source: "run_failure" };
  }
  if (run?.id) attachBuildRun(sql, buildId, String(run.id), run.html_url ?? null);

  // 3. Past the deadline nothing is coming: fail closed.
  const limit = deps.maxMinutes ?? maxBuildMinutes(env);
  const ageMinutes = (now().getTime() - new Date(build.created_at).getTime()) / 60_000;
  if (ageMinutes > limit) {
    const failed = failBuild(sql, buildId, "BUILD_TIMEOUT", {
      ageMinutes: Math.round(ageMinutes),
      limitMinutes: limit,
    });
    return { build: failed, source: "timeout" };
  }

  return { build: getBuild(sql, buildId) ?? build, source: "pending" };
}

interface RunState {
  id?: number;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

/**
 * Best-effort discovery of the run that belongs to this build.
 *
 * The dispatch API returns no run id, so the run is matched by workflow name and
 * by having been created at (or just after) the build row. This is a STATUS
 * HINT only: it can never make a build READY, and a wrong match can only make a
 * failure visible sooner â€” the evidence record still decides success.
 */
async function findRunState(env: FactoryEnv, build: FactoryBuild, fetchImpl: typeof fetch): Promise<RunState | null> {
  if (!env.GITHUB_TOKEN) return null;
  const repo = factoryRepo(env);
  const created = new Date(new Date(build.created_at).getTime() - 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  try {
    const response = await gh(env, `/repos/${repo}/actions/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(created)}&per_page=30`, {}, fetchImpl);
    if (!response.ok) return null;
    const body = (await response.json()) as { workflow_runs?: Array<{ id: number; name?: string; path?: string; status?: string; conclusion?: string | null; html_url?: string; created_at?: string }> };
    const runs = body.workflow_runs ?? [];
    const candidates = runs
      .filter((run) => (run.path ?? "").endsWith(FACTORY_WORKFLOW_FILE) || (run.name ?? "") === "Factory Product Build")
      .filter((run) => (run.created_at ? new Date(run.created_at).getTime() : 0) >= new Date(build.created_at).getTime() - 120_000)
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    const match = candidates[0];
    if (!match) return null;
    return { id: match.id, status: match.status, conclusion: match.conclusion, html_url: match.html_url };
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
