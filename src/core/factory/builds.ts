/**
 * Factory build lifecycle (migration v40) — durable build records + cost telemetry.
 *
 * The Plugin Factory is remote-only: the Executive dispatches a build to
 * `.github/workflows/factory-build.yml`, and this module owns the durable record
 * of that build. One immutable build id, one row, one ordered event history.
 *
 * Invariants enforced here (not in the routes, so every caller gets them):
 *   - build ids are validated and unique for ever (an id is never reused);
 *   - states only move forward:
 *       QUEUED -> ASSEMBLING -> BUILDING -> TESTING -> PACKAGING -> READY
 *     and any non-terminal state may fail. READY/FAILED are terminal;
 *   - a completion may only reach READY when BOTH `record.qaPassed` and
 *     `record.qaReport.passed` are exactly true. Anything else becomes FAILED
 *     with `failure_state = 'QA_GATE_FAILED'` — a failed quality gate can never
 *     look like a release;
 *   - cost telemetry (compile/test/package seconds, artifact bytes, AI cost and
 *     estimated variable cost) lives on the build row.
 *
 * Runs unchanged on the Durable Object's SQLite and on node:sqlite (tests).
 */
import type { Sql, SqlParam } from "../../db/sql";
import { newId, nowIso } from "../../ids";

/** Ordered lifecycle states. `FAILED` is terminal and may be entered from any non-terminal state. */
export const FACTORY_BUILD_STATES = [
  "QUEUED",
  "ASSEMBLING",
  "BUILDING",
  "TESTING",
  "PACKAGING",
  "READY",
  "FAILED",
] as const;

export type FactoryBuildState = (typeof FACTORY_BUILD_STATES)[number];

/** The UI templates the factory workflow accepts. */
export const FACTORY_UI_TEMPLATES = ["minimal", "standard", "advanced"] as const;
export type FactoryUiTemplate = (typeof FACTORY_UI_TEMPLATES)[number];

/** Workflow + repository the build lifecycle dispatches. */
export const FACTORY_BUILD_WORKFLOW = "factory-build.yml";
export const FACTORY_REPO_DEFAULT = "zarlino-audio/Zarlino";

const STATE_INDEX = new Map<string, number>(FACTORY_BUILD_STATES.map((state, index) => [state, index]));
const TERMINAL_STATES = new Set<string>(["READY", "FAILED"]);
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;

/** Structured, non-throwing factory-build failure (mirrors GovernanceError). */
export class FactoryBuildError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "FactoryBuildError";
    this.code = code;
    this.status = status;
  }
}

export interface FactoryBuild {
  id: string;
  request_id?: string;
  account_id?: string;
  product_id: string;
  product_name: string;
  product_version: string;
  ui_template: string;
  status: FactoryBuildState | string;
  spec_json: string;
  spec_sha256: string;
  spec_fingerprint: string;
  ui_plan_fingerprint?: string;
  catalog_fingerprint?: string;
  provenance_json?: string;
  modules_json?: string;
  source_commit?: string;
  target_platform: string;
  github_run_id?: string;
  github_run_url?: string;
  artifact_key?: string;
  artifact_name?: string;
  artifact_bytes?: number;
  artifact_sha256?: string;
  qa_report_key?: string;
  qa_passed?: number;
  qa_summary_json?: string;
  ai_cost_usd: number;
  compile_seconds: number;
  test_seconds: number;
  package_seconds: number;
  retry_count: number;
  estimated_variable_cost_usd: number;
  failure_state?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface FactoryBuildEvent {
  id: string;
  build_id: string;
  state: FactoryBuildState | string;
  detail_json?: string;
  actor: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A build id is immutable: 6-64 chars, starts alphanumeric, path-safe. */
export function isValidBuildId(id: string): boolean {
  return typeof id === "string" && BUILD_ID_RE.test(id);
}

export function isFactoryBuildState(value: unknown): value is FactoryBuildState {
  return typeof value === "string" && STATE_INDEX.has(value);
}

export function isFactoryUiTemplate(value: unknown): value is FactoryUiTemplate {
  return typeof value === "string" && (FACTORY_UI_TEMPLATES as readonly string[]).includes(value);
}

/** READY and FAILED are terminal — nothing may leave them. */
export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Monotonic forward progress only: one step along the chain, or FAILED from any
 * non-terminal state. Backwards moves, skips and no-ops are rejected, and a
 * terminal state is final.
 */
export function validateStateTransition(from: string, to: string): boolean {
  const fromIndex = STATE_INDEX.get(from);
  const toIndex = STATE_INDEX.get(to);
  if (fromIndex === undefined || toIndex === undefined) return false;
  if (isTerminalState(from)) return false;
  if (to === "FAILED") return true;
  return toIndex === fromIndex + 1;
}

/** Generate `fb-<utcstamp>-<6 hex>` — valid under isValidBuildId(). */
export function generateBuildId(at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const suffix = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `fb-${stamp}-${suffix}`;
}

/**
 * Stable JSON for hashing: object keys sorted recursively, so the same semantic
 * spec always produces the same SHA-256 regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key]);
    return out;
  }
  return value;
}

/**
 * R2 key of a build artifact. The workflow uploads to
 * `factory-builds/<buildId>/artifact/<artifact name>`; nothing else is served
 * by the build artifact route.
 */
export function buildArtifactKey(buildId: string, artifactName: string): string {
  return `factory-builds/${buildId}/artifact/${artifactName}`;
}

/** Only keys under `factory-builds/` may be fetched through the build route. */
export function isSafeFactoryArtifactKey(key: string | null | undefined): boolean {
  if (!key || typeof key !== "string") return false;
  if (key.length === 0 || key.length > 300) return false;
  if (key.startsWith("/") || key.includes("..") || key.includes("\\") || key.includes("\0")) return false;
  return key.startsWith("factory-builds/");
}

// ---------------------------------------------------------------------------
// Create / read
// ---------------------------------------------------------------------------

export interface CreateBuildInput {
  id: string;
  requestId?: string;
  accountId?: string;
  productId: string;
  productName: string;
  productVersion: string;
  uiTemplate: string;
  spec: unknown;
  specSha256: string;
  /** Semantic spec fingerprint when known; defaults to the byte hash. */
  specFingerprint?: string;
  uiPlanFingerprint?: string;
  catalogFingerprint?: string;
  provenance?: unknown;
  modules?: unknown;
  sourceCommit?: string;
  targetPlatform?: string;
}

/**
 * Insert a new build in QUEUED state plus its first event.
 * Throws FactoryBuildError on an invalid or duplicate id.
 */
export function createBuild(sql: Sql, input: CreateBuildInput): FactoryBuild {
  if (!isValidBuildId(input.id)) {
    throw new FactoryBuildError(
      "INVALID_BUILD_ID",
      `build id "${String(input.id)}" is invalid (expected ${BUILD_ID_RE.source})`,
    );
  }
  if (!isFactoryUiTemplate(input.uiTemplate)) {
    throw new FactoryBuildError("INVALID_UI_TEMPLATE", `uiTemplate must be one of ${FACTORY_UI_TEMPLATES.join(" | ")}`);
  }
  const existing = getBuild(sql, input.id);
  if (existing) {
    throw new FactoryBuildError(
      "DUPLICATE_BUILD_ID",
      `build id ${input.id} already exists (status ${existing.status}); build ids are immutable and unique`,
      409,
    );
  }

  const at = nowIso();
  const specJson = canonicalJson(input.spec);
  const specFingerprint = input.specFingerprint ?? input.specSha256;
  const params: SqlParam[] = [
    input.id,
    input.requestId ?? null,
    input.accountId ?? null,
    input.productId,
    input.productName,
    input.productVersion,
    input.uiTemplate,
    "QUEUED",
    specJson,
    input.specSha256,
    specFingerprint,
    input.uiPlanFingerprint ?? null,
    input.catalogFingerprint ?? null,
    input.provenance === undefined ? null : JSON.stringify(input.provenance),
    input.modules === undefined ? null : JSON.stringify(input.modules),
    input.sourceCommit ?? null,
    input.targetPlatform ?? "windows-x86_64",
    0,
    0,
    0,
    0,
    0,
    0,
    at,
    at,
  ];
  sql.run(
    `INSERT INTO factory_builds (
       id, request_id, account_id, product_id, product_name, product_version,
       ui_template, status, spec_json, spec_sha256, spec_fingerprint,
       ui_plan_fingerprint, catalog_fingerprint, provenance_json, modules_json,
       source_commit, target_platform,
       ai_cost_usd, compile_seconds, test_seconds, package_seconds, retry_count,
       estimated_variable_cost_usd, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...params,
  );
  appendBuildEvent(sql, input.id, "QUEUED", { reason: "build created" }, "orchestrator");

  const created = getBuild(sql, input.id);
  if (!created) throw new FactoryBuildError("BUILD_NOT_PERSISTED", `build ${input.id} was not persisted after insert`, 500);
  return created;
}

export function getBuild(sql: Sql, id: string): FactoryBuild | null {
  const rows = sql.all<Record<string, unknown>>("SELECT * FROM factory_builds WHERE id = ?", id);
  return rows.length ? (rows[0] as unknown as FactoryBuild) : null;
}

export function getBuildEvents(sql: Sql, buildId: string): FactoryBuildEvent[] {
  return sql.all<Record<string, unknown>>(
    "SELECT * FROM factory_build_events WHERE build_id = ? ORDER BY created_at ASC, id ASC",
    buildId,
  ) as unknown as FactoryBuildEvent[];
}

export interface ListBuildsOptions {
  product?: string;
  status?: string;
}

/** Most recent builds first, optionally filtered by product id and/or status. */
export function listBuilds(sql: Sql, limit = 25, opts: ListBuildsOptions = {}): FactoryBuild[] {
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit) || 25));
  let query = "SELECT * FROM factory_builds WHERE 1 = 1";
  const params: SqlParam[] = [];
  if (opts.product) {
    query += " AND product_id = ?";
    params.push(opts.product);
  }
  if (opts.status) {
    query += " AND status = ?";
    params.push(opts.status);
  }
  query += " ORDER BY created_at DESC, id DESC LIMIT ?";
  params.push(bounded);
  return sql.all<Record<string, unknown>>(query, ...params) as unknown as FactoryBuild[];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface AppendEventOptions {
  actor?: string;
}

/** Append one lifecycle event. The build must exist; state must be known. */
export function appendBuildEvent(
  sql: Sql,
  buildId: string,
  state: FactoryBuildState,
  detail?: unknown,
  actor = "orchestrator",
): FactoryBuildEvent {
  if (!isFactoryBuildState(state)) {
    throw new FactoryBuildError("INVALID_STATE", `unknown build state "${String(state)}"`);
  }
  if (!getBuild(sql, buildId)) {
    throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${buildId} not found`, 404);
  }
  const event: FactoryBuildEvent = {
    id: newId("fbe"),
    build_id: buildId,
    state,
    detail_json: detail === undefined || detail === null ? undefined : JSON.stringify(detail),
    actor,
    created_at: nowIso(),
  };
  sql.run(
    "INSERT INTO factory_build_events (id, build_id, state, detail_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    event.id,
    event.build_id,
    event.state,
    event.detail_json ?? null,
    event.actor,
    event.created_at,
  );
  return event;
}

export interface TransitionOptions {
  detail?: unknown;
  actor?: string;
  /** Stored in `failure_state` when the target state is FAILED. */
  failureState?: string;
}

/** Move a build one legal step forward; appends the event and re-reads the row. */
export function transitionBuild(sql: Sql, buildId: string, to: string, opts: TransitionOptions = {}): FactoryBuild {
  const build = getBuild(sql, buildId);
  if (!build) throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${buildId} not found`, 404);
  if (!isFactoryBuildState(to)) {
    throw new FactoryBuildError("INVALID_STATE", `state must be one of ${FACTORY_BUILD_STATES.join(" | ")}`);
  }
  if (!validateStateTransition(String(build.status), to)) {
    throw new FactoryBuildError(
      "ILLEGAL_TRANSITION",
      `build ${buildId} cannot move ${build.status} -> ${to} (states move forward only; READY/FAILED are terminal)`,
      409,
    );
  }
  return applyState(sql, build, to, opts);
}

/** Terminal failure from any non-terminal state. Idempotent once terminal. */
export function failBuild(
  sql: Sql,
  buildId: string,
  failureState: string,
  detail?: unknown,
  actor = "orchestrator",
): FactoryBuild {
  const build = getBuild(sql, buildId);
  if (!build) throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${buildId} not found`, 404);
  if (isTerminalState(String(build.status))) return build;
  return applyState(sql, build, "FAILED", { failureState, detail, actor });
}

function applyState(sql: Sql, build: FactoryBuild, to: FactoryBuildState, opts: TransitionOptions): FactoryBuild {
  const at = nowIso();
  const terminal = isTerminalState(to);
  const failureState =
    to === "FAILED" ? (opts.failureState ?? build.failure_state ?? "BUILD_FAILED") : null;
  sql.run(
    "UPDATE factory_builds SET status = ?, failure_state = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    to,
    failureState,
    terminal ? at : null,
    at,
    build.id,
  );
  appendBuildEvent(sql, build.id, to, opts.detail ?? null, opts.actor ?? "orchestrator");
  const next = getBuild(sql, build.id);
  if (!next) throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${build.id} disappeared during transition`, 500);
  return next;
}

/** Record the GitHub run returned by dispatch (best-effort: either field may be unknown). */
export function attachBuildRun(
  sql: Sql,
  buildId: string,
  githubRunId?: string | null,
  githubRunUrl?: string | null,
): FactoryBuild | null {
  sql.run(
    "UPDATE factory_builds SET github_run_id = COALESCE(?, github_run_id), github_run_url = COALESCE(?, github_run_url), updated_at = ? WHERE id = ?",
    githubRunId ?? null,
    githubRunUrl ?? null,
    nowIso(),
    buildId,
  );
  return getBuild(sql, buildId);
}

// ---------------------------------------------------------------------------
// Completion (the quality-gate rule)
// ---------------------------------------------------------------------------

export interface CompletionInput {
  /** Terminal status requested by the workflow/orchestrator (`READY` or `FAILED`). */
  status?: string;
  productName?: string;
  githubRunId?: string;
  /** The `build-record.json` produced by the workflow. */
  record?: Record<string, unknown> | null;
}

/**
 * Apply a workflow completion record. The ONLY path to READY is a record whose
 * `qaPassed === true` AND `qaReport.passed === true`; everything else is FAILED.
 * Idempotent: a build that is already terminal is returned unchanged.
 */
export function completeBuild(sql: Sql, buildId: string, input: CompletionInput): FactoryBuild {
  const build = getBuild(sql, buildId);
  if (!build) throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${buildId} not found`, 404);
  if (isTerminalState(String(build.status))) return build;

  const record = isPlainObject(input.record) ? input.record : {};
  const qaReport = isPlainObject(record.qaReport) ? record.qaReport : null;
  const qaPassed = record.qaPassed === true && qaReport?.passed === true;

  const requested = String(input.status ?? record.status ?? "").trim().toUpperCase();
  // An absent status is decided by the gate; any explicit non-READY terminal is a failure.
  const wantsReady = requested === "READY" || requested === "";
  const status: FactoryBuildState = wantsReady && qaPassed ? "READY" : "FAILED";
  const gateExplicitlyFailed = record.qaPassed === false || qaReport?.passed === false;
  const failureState =
    status === "READY"
      ? null
      : (str(record.failureState) ?? (wantsReady || gateExplicitlyFailed ? "QA_GATE_FAILED" : "BUILD_FAILED"));

  const artifacts = isPlainObject(record.artifact) ? record.artifact : {};
  const timings = isPlainObject(record.timings) ? record.timings : {};
  const provenance = isPlainObject(record.provenance) ? record.provenance : {};
  const cost = isPlainObject(record.cost) ? record.cost : {};

  const artifactName = str(artifacts.name) ?? build.artifact_name ?? null;
  const artifactKey =
    str(artifacts.key) ?? (artifactName ? buildArtifactKey(buildId, artifactName) : null);

  const aiCost = num(record.aiCostUsd) ?? num(cost.aiCostUsd) ?? build.ai_cost_usd ?? 0;
  const estimatedVariableCost =
    num(record.estimatedVariableCostUsd) ?? num(cost.estimatedVariableCostUsd) ?? build.estimated_variable_cost_usd ?? 0;
  const retryCount = num(record.retryCount) ?? num(cost.retryCount) ?? build.retry_count ?? 0;

  const at = nowIso();
  sql.run(
    `UPDATE factory_builds SET
       product_name = ?, product_version = ?, status = ?, failure_state = ?,
       github_run_id = ?,
       provenance_json = ?, modules_json = ?,
       spec_fingerprint = ?, ui_plan_fingerprint = ?, catalog_fingerprint = ?,
       source_commit = ?, target_platform = ?,
       artifact_key = ?, artifact_name = ?, artifact_bytes = ?, artifact_sha256 = ?,
       qa_report_key = ?, qa_passed = ?, qa_summary_json = ?,
       ai_cost_usd = ?, compile_seconds = ?, test_seconds = ?, package_seconds = ?,
       retry_count = ?, estimated_variable_cost_usd = ?,
       updated_at = ?, completed_at = ?
     WHERE id = ?`,
    input.productName ?? str(record.productName) ?? build.product_name,
    str(record.productVersion) ?? build.product_version,
    status,
    failureState,
    input.githubRunId ?? str(record.githubRunId) ?? build.github_run_id ?? null,
    Object.keys(provenance).length ? JSON.stringify(provenance) : (build.provenance_json ?? null),
    Array.isArray(provenance.modules) ? JSON.stringify(provenance.modules) : (build.modules_json ?? null),
    str(provenance.specFingerprint) ?? build.spec_fingerprint,
    str(provenance.uiPlanFingerprint) ?? build.ui_plan_fingerprint ?? null,
    str(provenance.catalogFingerprint) ?? build.catalog_fingerprint ?? null,
    str(record.sourceCommit) ?? build.source_commit ?? null,
    str(record.targetPlatform) ?? build.target_platform,
    artifactKey,
    artifactName,
    num(artifacts.zipBytes) ?? num(artifacts.bytes) ?? build.artifact_bytes ?? null,
    str(artifacts.zipSha256) ?? str(artifacts.sha256) ?? build.artifact_sha256 ?? null,
    `factory-builds/${buildId}/qa-report.json`,
    qaPassed ? 1 : 0,
    qaReport ? JSON.stringify(qaReport) : (build.qa_summary_json ?? null),
    aiCost,
    num(timings.compileSeconds) ?? 0,
    num(timings.testSeconds) ?? 0,
    num(timings.packageSeconds) ?? 0,
    retryCount,
    estimatedVariableCost,
    at,
    at,
    buildId,
  );
  appendBuildEvent(
    sql,
    buildId,
    status,
    {
      source: "completion",
      requested_status: input.status ?? null,
      qa_passed: qaPassed,
      downgraded: wantsReady && !qaPassed,
      artifact: artifactName,
    },
    "workflow",
  );

  const next = getBuild(sql, buildId);
  if (!next) throw new FactoryBuildError("BUILD_NOT_FOUND", `build ${buildId} disappeared during completion`, 500);
  return next;
}

// ---------------------------------------------------------------------------
// Cost telemetry
// ---------------------------------------------------------------------------

export interface BuildCostSummary {
  count: number;
  succeeded: number;
  failed: number;
  totalCompileSeconds: number;
  totalTestSeconds: number;
  totalArtifactBytes: number;
  totalAiCostUsd: number;
  totalEstimatedVariableCostUsd: number;
  /** Mean build wall time (compile + test + package) across the window. */
  averageSecondsPerBuild: number;
}

/** SQL-only aggregate over builds created since `sinceIso`. */
export function buildCostSummary(sql: Sql, sinceIso: string): BuildCostSummary {
  const rows = sql.all<Record<string, unknown>>(
    `SELECT
       COUNT(*) AS count,
       COALESCE(SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END), 0) AS succeeded,
       COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(compile_seconds), 0) AS total_compile_seconds,
       COALESCE(SUM(test_seconds), 0) AS total_test_seconds,
       COALESCE(SUM(package_seconds), 0) AS total_package_seconds,
       COALESCE(SUM(artifact_bytes), 0) AS total_artifact_bytes,
       COALESCE(SUM(ai_cost_usd), 0) AS total_ai_cost_usd,
       COALESCE(SUM(estimated_variable_cost_usd), 0) AS total_estimated_variable_cost_usd
     FROM factory_builds
     WHERE created_at >= ?`,
    sinceIso,
  );
  const row = rows[0] ?? {};
  const count = numberOrZero(row.count);
  const totalCompileSeconds = numberOrZero(row.total_compile_seconds);
  const totalTestSeconds = numberOrZero(row.total_test_seconds);
  const totalPackageSeconds = numberOrZero(row.total_package_seconds);
  return {
    count,
    succeeded: numberOrZero(row.succeeded),
    failed: numberOrZero(row.failed),
    totalCompileSeconds,
    totalTestSeconds,
    totalArtifactBytes: numberOrZero(row.total_artifact_bytes),
    totalAiCostUsd: numberOrZero(row.total_ai_cost_usd),
    totalEstimatedVariableCostUsd: numberOrZero(row.total_estimated_variable_cost_usd),
    averageSecondsPerBuild:
      count > 0 ? (totalCompileSeconds + totalTestSeconds + totalPackageSeconds) / count : 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numberOrZero(value: unknown): number {
  const parsed = num(value);
  return parsed === null ? 0 : parsed;
}
