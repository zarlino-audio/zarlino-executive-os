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
  transitionBuild,
  FACTORY_BUILD_STATES,
  type FactoryBuild,
  type FactoryBuildState,
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

/**
 * The factory's evidence store, adapted from Cloudflare KV.
 *
 * KV holds the published `build-record.json` (written by the build workflow only
 * after the quality gate passed) and returns a string rather than an object with
 * `.text()`. Wrapping it here keeps the READY decision in `syncFactoryBuild`
 * unchanged, so the trust rule is identical whichever store backs it.
 */
export function factoryEvidenceStore(
  kv: { get(key: string): Promise<string | null> } | null | undefined,
): ArtifactBucket | null {
  if (!kv) return null;
  return {
    async get(key: string) {
      const value = await kv.get(key);
      return value === null || value === undefined ? null : { text: async () => value };
    },
  };
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
  /**
   * How long a build's derived stage may be reused before asking GitHub again.
   *
   * A customer watching the page polls every few seconds; the stage changes on a
   * scale of minutes, and each derivation costs two GitHub API calls from one
   * shared token. Defaults to 15s; tests set 0 to observe every transition.
   */
  stageCacheMs?: number;
}

export interface SyncResult {
  build: FactoryBuild;
  /** Where the decision came from - useful in logs and tests. */
  source: "terminal" | "record" | "run_failure" | "run_progress" | "timeout" | "pending";
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

  // 3. A run that is still going: report the stage it has actually reached, so
  //    the customer sees progress instead of one frozen state for fifteen
  //    minutes. A run that has not been picked up by a runner yet stays QUEUED,
  //    which is the truth.
  if (run && !run.conclusion && run.id && (run.status === "in_progress" || run.status === "completed")) {
    const cacheMs = deps.stageCacheMs ?? 15_000;
    const cached = cacheMs > 0 ? cachedStage(buildId) : null;
    const fresh = cached !== null && now().getTime() - cached.at < cacheMs;
    let stage: FactoryBuildState | null;
    if (fresh) {
      stage = cached!.stage;
    } else {
      stage = await fetchRunStage(env, run.id, deps.fetchImpl ?? fetch);
      if (cacheMs > 0) stageCache.set(buildId, { at: now().getTime(), stage });
    }
    const advanced = advanceTo(sql, buildId, stage ?? "ASSEMBLING");
    if (advanced) return { build: advanced, source: "run_progress" };
  }

  // 4. Past the deadline nothing is coming: fail closed.
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

/** Ask GitHub which steps of a run have been reached. Best effort: null on any failure. */
async function fetchRunStage(env: FactoryEnv, runId: number, fetchImpl: typeof fetch): Promise<FactoryBuildState | null> {
  try {
    const response = await gh(env, `/repos/${factoryRepo(env)}/actions/runs/${runId}/jobs?per_page=20`, {}, fetchImpl);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      jobs?: Array<{ name?: string; status?: string; steps?: Array<{ name?: string; status?: string }> }>;
    };
    const jobs = body.jobs ?? [];
    const steps = jobs.flatMap((job) => job.steps ?? []);
    return deriveStage(steps, jobs);
  } catch {
    return null;
  }
}

/**
 * Short-lived memo of the last derived stage, so a page polling every four
 * seconds does not turn into two GitHub calls every four seconds from one shared
 * token. Lives in module scope because the orchestrator is a single Durable
 * Object; losing it on restart only costs one extra call.
 */
const stageCache = new Map<string, { at: number; stage: FactoryBuildState | null }>();

function cachedStage(buildId: string): { at: number; stage: FactoryBuildState | null } | null {
  const entry = stageCache.get(buildId);
  if (!entry) return null;
  if (stageCache.size > 500) stageCache.clear();
  return entry;
}

/**
 * Walk a build forward to `target`, one legal step at a time.
 *
 * The lifecycle only permits single steps, which is what keeps the event history
 * honest; a customer watching the page should still see it move
 * QUEUED -> ASSEMBLING -> BUILDING as the run reports those stages.
 */
function advanceTo(sql: Sql, buildId: string, target: FactoryBuildState): FactoryBuild | null {
  let current = getBuild(sql, buildId);
  if (!current) return null;
  const targetIndex = FACTORY_BUILD_STATES.indexOf(target);
  let guard = FACTORY_BUILD_STATES.length;

  while (!isTerminalState(String(current.status)) && guard-- > 0) {
    const index = FACTORY_BUILD_STATES.indexOf(current.status as FactoryBuildState);
    if (index < 0 || index >= targetIndex) return current;
    const next = FACTORY_BUILD_STATES[index + 1]!;
    if (isTerminalState(next)) return current;
    current = transitionBuild(sql, buildId, next, { detail: { source: "workflow_run" } });
  }
  return current;
}

interface RunState {
  id?: number;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

/**
 * Which lifecycle state a workflow step means.
 *
 * The workflow's own step names are the only honest source of progress: a run
 * that is `in_progress` says nothing about whether it is compiling or packing.
 * Matching on names is deliberate and bounded - an unrecognised step keeps the
 * previous state, so renaming a step degrades the progress display to "less
 * precise", never to "wrong" or "stuck at the end".
 */
const STEP_STAGE: Array<[RegExp, FactoryBuildState]> = [
  [/validate|freeze|configure|kernel|generate the product/i, "ASSEMBLING"],
  [/compile/i, "BUILDING"],
  [/quality gate|generic quality/i, "TESTING"],
  [/package|integrity|upload .*evidence|download the verified|verify a gate|r2|report completion/i, "PACKAGING"],
];

/** The highest stage any started step has reached, or null when nothing matched. */
export function deriveStage(
  steps: Array<{ name?: string; status?: string }>,
  jobs: Array<{ name?: string; status?: string }> = [],
): FactoryBuildState | null {
  let best: number | null = null;

  const consider = (state: FactoryBuildState) => {
    const index = FACTORY_BUILD_STATES.indexOf(state);
    if (index >= 0 && (best === null || index > best)) best = index;
  };

  for (const step of steps) {
    // `completed` and `in_progress` both mean "this step has been reached".
    if (step.status !== "completed" && step.status !== "in_progress") continue;
    const name = step.name ?? "";
    for (const [pattern, state] of STEP_STAGE) {
      if (pattern.test(name)) {
        consider(state);
        break;
      }
    }
  }

  // The publish job runs after the gate: upload, evidence, completion report.
  for (const job of jobs) {
    if (job.status !== "completed" && job.status !== "in_progress") continue;
    if (/publish/i.test(job.name ?? "")) consider("PACKAGING");
  }

  return best === null ? null : FACTORY_BUILD_STATES[best]!;
}

/**
 * Find the run that belongs to this build.
 *
 * The dispatch API returns no run id, so the run is found by its `run-name`,
 * which the workflow sets to `factory-build-<build id>` - an exact match, so two
 * builds dispatched in the same minute can never be confused with each other.
 * Runs from before that name existed are matched by workflow + creation time as
 * a fallback.
 *
 * This is a STATUS HINT only: it can never make a build READY (the published
 * evidence record does that), and a wrong match could only make a failure
 * visible sooner.
 */
async function findRunState(env: FactoryEnv, build: FactoryBuild, fetchImpl: typeof fetch): Promise<RunState | null> {
  if (!env.GITHUB_TOKEN) return null;
  const repo = factoryRepo(env);
  const created = new Date(new Date(build.created_at).getTime() - 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  try {
    const response = await gh(env, `/repos/${repo}/actions/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(created)}&per_page=30`, {}, fetchImpl);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      workflow_runs?: Array<{ id: number; name?: string; display_title?: string; path?: string; status?: string; conclusion?: string | null; html_url?: string; created_at?: string }>;
    };
    const runs = (body.workflow_runs ?? []).filter((run) => (run.path ?? "").endsWith(FACTORY_WORKFLOW_FILE) || (run.name ?? "") === "Factory Product Build");

    const exact = runs.filter((run) => (run.display_title ?? "").trim() === `factory-build-${build.id}`);
    if (exact.length > 0) {
      const match = exact.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]!;
      return { id: match.id, status: match.status, conclusion: match.conclusion, html_url: match.html_url };
    }

    // Every run now carries `factory-build-<id>` as its display title. If runs in
    // this window use that scheme and none names THIS build, then this build has
    // no run yet - and answering with someone else's run would report their
    // progress, or their failure, as this customer's.
    const usesBuildNames = runs.some((run) => (run.display_title ?? "").startsWith("factory-build-"));
    if (usesBuildNames) return null;

    // Legacy runs (dispatched before the run name existed): fall back to the
    // oldest matching run in the window.
    const candidates = runs
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
