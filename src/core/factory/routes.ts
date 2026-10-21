/**
 * The Plugin Factory gateway routes on the Executive OS.
 *
 * These four routes are the whole service-to-service surface between the
 * customer application (zarlinoaudio.com) and this orchestrator. They are NOT
 * part of the founder console and are NOT reachable with a founder credential:
 *
 *   POST /api/factory/interpret            x-factory-gateway: <secret>
 *   POST /api/factory/builds               x-factory-gateway: <secret>
 *   GET  /api/factory/builds/:id           x-factory-gateway: <secret>
 *   POST /api/factory/builds/:id/completion Authorization: Bearer <report token>
 *
 * Fail closed: with no secret configured the gateway accepts nobody, and the
 * completion callback requires its own separate token so a build worker can
 * never dispatch builds or read other customers' records.
 */

import type { Sql } from "../../db/sql";
import { interpretDescription, validateInterpretRequest, FactoryInterpretError } from "./interpret";
import { dispatchFactoryBuild, syncFactoryBuild, type FactoryEnv } from "./dispatch";
import { completeBuild, getBuild, getBuildEvents } from "./builds";

export interface FactoryRouteEnv extends FactoryEnv {
  FACTORY_GATEWAY_SECRET?: string;
  BUILD_REPORT_TOKEN?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_KEY_FALLBACK?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_CAO_MODEL?: string;
}

export interface FactoryRouteContext {
  sql: Sql;
  env: FactoryRouteEnv;
  /** R2 bucket holding factory build evidence (zarlino-artifacts). */
  bucket?: { get(key: string): Promise<{ text(): Promise<string> } | null> } | null;
  /** Optional metering sink; the DO passes its store. */
  meter?: Parameters<typeof interpretDescription>[1]["store"];
  fetchImpl?: typeof fetch;
}

const GATEWAY_HEADER = "x-factory-gateway";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function gatewayAuthorised(request: Request, env: FactoryRouteEnv): boolean {
  const expected = env.FACTORY_GATEWAY_SECRET;
  if (!expected || expected.trim().length < 16) return false;
  const provided = request.headers.get(GATEWAY_HEADER);
  return Boolean(provided) && timingSafeEqual(provided!.trim(), expected.trim());
}

export function buildReportAuthorised(request: Request, env: FactoryRouteEnv): boolean {
  const expected = env.BUILD_REPORT_TOKEN;
  if (!expected || expected.trim().length < 16) return false;
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  return timingSafeEqual(auth.slice(7).trim(), expected.trim());
}

/** Customer-facing view of a build. Never includes raw logs or internal keys. */
export function publicBuild(build: ReturnType<typeof getBuild>): Record<string, unknown> | null {
  if (!build) return null;
  return {
    buildId: build.id,
    productName: build.product_name,
    productVersion: build.product_version,
    uiTemplate: build.ui_template,
    status: build.status,
    failureState: build.failure_state ?? null,
    qaPassed: build.qa_passed === 1,
    artifact:
      build.status === "READY" && build.qa_passed === 1 && build.artifact_name
        ? {
            name: build.artifact_name,
            bytes: build.artifact_bytes ?? null,
            sha256: build.artifact_sha256 ?? null,
            key: build.artifact_key ?? null,
          }
        : null,
    timings: { compileSeconds: build.compile_seconds, testSeconds: build.test_seconds },
    cost: { aiCostUsd: build.ai_cost_usd, estimatedVariableCostUsd: build.estimated_variable_cost_usd },
    githubRunUrl: build.github_run_url ?? null,
    createdAt: build.created_at,
    updatedAt: build.updated_at,
    completedAt: build.completed_at ?? null,
  };
}

/**
 * Handle a factory route. Returns null when the path is not ours, so the DO's
 * normal router keeps working unchanged.
 */
export async function handleFactoryRoute(
  context: FactoryRouteContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/factory/interpret") {
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!gatewayAuthorised(request, context.env)) return json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }

    let parsed;
    try {
      parsed = validateInterpretRequest(body);
    } catch (error) {
      if (error instanceof FactoryInterpretError) return json({ ok: false, code: error.code, message: error.message }, error.status);
      throw error;
    }

    const result = await interpretDescription(parsed, {
      env: context.env,
      store: context.meter,
      fetchImpl: context.fetchImpl,
    });
    return json(result, result.ok ? 200 : result.code === "NOT_CONFIGURED" ? 503 : 502);
  }

  if (path === "/api/factory/builds") {
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!gatewayAuthorised(request, context.env)) return json({ error: "Unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ error: "body must be an object" }, 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }

    const required = ["buildId", "productId", "productName", "productVersion", "uiTemplate", "spec", "specSha256"] as const;
    for (const field of required) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        return json({ ok: false, code: "INVALID_REQUEST", message: `${field} is required` }, 400);
      }
    }

    const result = await dispatchFactoryBuild(
      context.sql,
      context.env,
      {
        buildId: String(body.buildId),
        requestId: typeof body.requestId === "string" ? body.requestId : undefined,
        accountId: typeof body.accountId === "string" ? body.accountId : undefined,
        productId: String(body.productId),
        productName: String(body.productName),
        productVersion: String(body.productVersion),
        uiTemplate: String(body.uiTemplate),
        spec: body.spec,
        specSha256: String(body.specSha256),
        sourceCommit: typeof body.sourceCommit === "string" ? body.sourceCommit : undefined,
      },
      { fetchImpl: context.fetchImpl },
    );

    if (!result.ok) {
      return json({ ok: false, code: result.code, message: result.message, build: publicBuild(result.build) }, result.status);
    }
    return json({ ok: true, build: publicBuild(result.build) }, 202);
  }

  const buildMatch = /^\/api\/factory\/builds\/([A-Za-z0-9][A-Za-z0-9._-]{5,63})(\/completion)?$/.exec(path);
  if (buildMatch) {
    const buildId = buildMatch[1]!;
    const isCompletion = buildMatch[2] === "/completion";

    if (isCompletion) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      if (!buildReportAuthorised(request, context.env)) return json({ error: "Unauthorized" }, 401);

      let payload: Record<string, unknown> = {};
      try {
        const parsed = await request.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }

      const record = typeof payload.record === "object" && payload.record !== null ? (payload.record as Record<string, unknown>) : null;
      const build = getBuild(context.sql, buildId);
      if (!build) return json({ error: "build not found" }, 404);

      const completed = completeBuild(context.sql, buildId, {
        status: typeof payload.status === "string" ? payload.status : undefined,
        productName: typeof payload.productName === "string" ? payload.productName : undefined,
        githubRunId: typeof payload.githubRunId === "string" ? payload.githubRunId : undefined,
        record,
      });
      return json({ ok: true, build: publicBuild(completed) });
    }

    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    if (!gatewayAuthorised(request, context.env)) return json({ error: "Unauthorized" }, 401);

    const existing = getBuild(context.sql, buildId);
    if (!existing) return json({ error: "build not found" }, 404);

    const synced = await syncFactoryBuild(context.sql, context.env, buildId, {
      bucket: context.bucket ?? null,
      fetchImpl: context.fetchImpl,
    });

    const includeEvents = url.searchParams.get("events") === "1";
    return json({
      ok: true,
      build: publicBuild(synced.build),
      syncSource: synced.source,
      ...(includeEvents
        ? {
            events: getBuildEvents(context.sql, buildId).map((event) => ({
              state: event.state,
              at: event.created_at,
              actor: event.actor,
            })),
          }
        : {}),
    });
  }

  return null;
}
