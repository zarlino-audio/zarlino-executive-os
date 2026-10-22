/**
 * Factory gateway: AI interpretation, dispatch and the quality-gate completion
 * rule, exercised through the real route handler.
 *
 * GitHub, DeepSeek and R2 are faked at the fetch/bucket boundary, so these tests
 * prove the orchestration and the fail-closed rules without any live credential.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { getBuild, getBuildEvents } from "../src/core/factory/builds";
import { extractJsonObject, validateInterpretRequest, MAX_DESCRIPTION_CHARS } from "../src/core/factory/interpret";
import { deriveStage } from "../src/core/factory/dispatch";
import { handleFactoryRoute, type FactoryRouteEnv } from "../src/core/factory/routes";

const GATEWAY = "gateway-secret-of-at-least-16-chars";
const REPORT = "report-token-of-at-least-16-chars";

const CATALOG = [
  {
    moduleId: "zarlino.dynamics.compressor",
    displayName: "Compressor",
    description: "Feedforward compressor",
    category: "dynamics",
    channels: ["mono", "stereo"],
    parameters: [{ id: "threshold", unit: "dB", min: -60, max: 0, default: -18 }],
  },
];

function validSpec(): Record<string, unknown> {
  return {
    factorySchemaVersion: 1,
    plugin: {
      id: "zarlino.customer.punch",
      name: "Punch",
      vendor: "Zarlino Audio",
      version: "1.0.0",
      effectType: "dynamics",
      channels: "stereo",
    },
    graph: {
      modules: [
        { instanceId: "comp", moduleId: "zarlino.dynamics.compressor", moduleVersion: "1.0.0", parameters: { threshold: -22 } },
      ],
    },
    parameters: [
      {
        id: "compression",
        name: "Compression",
        target: "comp.threshold",
        range: { min: -40, max: 0, default: -22 },
        unit: "dB",
        group: "Dynamics",
      },
    ],
    macros: [],
    dryWet: { enabled: false, defaultMix: 1 },
    bypass: { mode: "hard", defaultBypassed: false },
    ui: {
      accentColor: "#4C9AFF",
      category: "Dynamics",
      shortDescription: "Fast compressor",
      tags: ["compressor"],
      layout: "vertical",
      parameterOrder: ["compression"],
    },
  };
}

interface Captured {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeFetch(responder: (captured: Captured) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value);
    const captured: Captured = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers,
    };
    calls.push(captured);
    return responder(captured);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deepSeekReply(content: unknown, promptTokens = 900, completionTokens = 300): Response {  return new Response(
    JSON.stringify({
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function r2Bucket(objects: Record<string, string>) {
  return {
    get: async (key: string) => (objects[key] === undefined ? null : { text: async () => objects[key]! }),
  };
}

describe("factory gateway routes", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;
  let sql: ReturnType<typeof createNodeSql>;
  let baseEnv: FactoryRouteEnv;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    sql = createNodeSql(db as never);
    store = new ExecutiveStore(sql);
    store.migrate();
    baseEnv = {
      FACTORY_GATEWAY_SECRET: GATEWAY,
      BUILD_REPORT_TOKEN: REPORT,
      DEEPSEEK_API_KEY: "sk-test-key-1234567890",
      GITHUB_TOKEN: "gh-test-token",
      FACTORY_REPO: "zarlino-audio/Zarlino",
    };
  });

  afterAll(() => {
    db.close();
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`https://os.example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  function get(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`https://os.example.com${path}`, { method: "GET", headers });
  }

  async function route(request: Request, env: FactoryRouteEnv = baseEnv, extra: { bucket?: ReturnType<typeof r2Bucket>; fetchImpl?: typeof fetch } = {}) {
    const response = await handleFactoryRoute(
      {
        sql,
        env,
        bucket: extra.bucket ?? null,
        meter: store,
        fetchImpl: extra.fetchImpl,
      },
      request,
      new URL(request.url),
    );
    return response;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it("refuses the gateway without a secret, with a wrong secret, and when unconfigured", async () => {
    const request = post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG });

    expect((await route(request))!.status).toBe(401);
    expect((await route(post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": "wrong-secret-wrong" })))!.status).toBe(401);

    // Fail closed: no configured secret means nobody gets in.
    const unconfigured: FactoryRouteEnv = { ...baseEnv, FACTORY_GATEWAY_SECRET: undefined };
    expect((await route(post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": GATEWAY }), unconfigured))!.status).toBe(401);
    // A short secret is not a secret.
    expect((await route(post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": "short" }), { ...baseEnv, FACTORY_GATEWAY_SECRET: "short" }))!.status).toBe(401);
  });

  it("does not accept the build-report token as a gateway credential", async () => {
    const request = post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": REPORT });
    expect((await route(request))!.status).toBe(401);
  });

  it("ignores paths outside the factory surface", async () => {
    const result = await route(get("/api/tasks", { "x-factory-gateway": GATEWAY }));
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Interpretation
  // -------------------------------------------------------------------------

  it("turns a description into a spec draft and meters the call", async () => {
    const { fetchImpl, calls } = fakeFetch(() => deepSeekReply(validSpec()));
    const response = await route(
      post("/api/factory/interpret", { mode: "initial", description: "a punchy compressor", catalog: CATALOG }, { "x-factory-gateway": GATEWAY }),
      baseEnv,
      { fetchImpl },
    );
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as { ok: boolean; spec: Record<string, unknown>; usage: { promptTokens: number; costUsd: number } };
    expect(body.ok).toBe(true);
    expect((body.spec.plugin as Record<string, unknown>).id).toBe("zarlino.customer.punch");
    expect(body.usage.promptTokens).toBe(900);
    expect(body.usage.costUsd).toBeGreaterThan(0);

    // The request carried the catalog and asked for JSON mode.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/chat/completions");
    expect((calls[0]!.body as { response_format: { type: string } }).response_format.type).toBe("json_object");
  });

  it("passes an unsupported verdict straight through", async () => {
    const { fetchImpl } = fakeFetch(() =>
      deepSeekReply({ unsupported: true, reason: "This catalogue has no reverb.", closest: "A short gated saturation." }),
    );
    const response = await route(
      post("/api/factory/interpret", { mode: "initial", description: "a lush reverb", catalog: CATALOG }, { "x-factory-gateway": GATEWAY }),
      baseEnv,
      { fetchImpl },
    );
    const body = (await response!.json()) as { ok: boolean; spec: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.spec.unsupported).toBe(true);
  });

  it("reports an unconfigured or failing provider without inventing a spec", async () => {
    const unconfigured: FactoryRouteEnv = { ...baseEnv, DEEPSEEK_API_KEY: undefined, DEEPSEEK_API_KEY_FALLBACK: undefined };
    const first = await route(
      post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": GATEWAY }),
      unconfigured,
    );
    expect(first!.status).toBe(503);
    expect(((await first!.json()) as { code: string }).code).toBe("NOT_CONFIGURED");

    const failing = fakeFetch(() => new Response("boom", { status: 500 }));
    const second = await route(
      post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": GATEWAY }),
      baseEnv,
      { fetchImpl: failing.fetchImpl },
    );
    expect(second!.status).toBe(502);
    expect(((await second!.json()) as { code: string }).code).toBe("PROVIDER_ERROR");
  });

  it("rejects an unusable model reply instead of guessing", async () => {
    const { fetchImpl } = fakeFetch(() => deepSeekReply("I cannot help with that."));
    const response = await route(
      post("/api/factory/interpret", { mode: "initial", description: "x", catalog: CATALOG }, { "x-factory-gateway": GATEWAY }),
      baseEnv,
      { fetchImpl },
    );
    expect(response!.status).toBe(502);
    expect(((await response!.json()) as { code: string }).code).toBe("UNPARSEABLE");
  });

  it("refuses an oversized description and an empty catalog", () => {
    expect(() => validateInterpretRequest({ mode: "initial", description: "x".repeat(MAX_DESCRIPTION_CHARS + 1), catalog: CATALOG })).toThrow();
    expect(() => validateInterpretRequest({ mode: "initial", description: "ok", catalog: [] })).toThrow();
    expect(() => validateInterpretRequest({ mode: "other", description: "ok", catalog: CATALOG })).toThrow();
    expect(validateInterpretRequest({ mode: "initial", description: "ok", catalog: CATALOG }).mode).toBe("initial");
  });

  it("extracts a JSON object from fenced or chatty replies and rejects the rest", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1,2,3]")).toBeNull();
    expect(extractJsonObject('{"a": broken}')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  function dispatchRequest(buildId: string): Request {
    return post(
      "/api/factory/builds",
      {
        buildId,
        requestId: "req_1",
        accountId: "acct_1",
        productId: "zarlino.customer.punch",
        productName: "Punch",
        productVersion: "1.0.0",
        uiTemplate: "standard",
        spec: validSpec(),
        specSha256: "b".repeat(64),
      },
      { "x-factory-gateway": GATEWAY },
    );
  }

  it("dispatches the workflow with the spec as a value and records the build", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000001-aaa111";
    const response = await route(dispatchRequest(buildId), baseEnv, { fetchImpl });
    expect(response!.status).toBe(202);
    const body = (await response!.json()) as { ok: boolean; build: { status: string; buildId: string } };
    expect(body.ok).toBe(true);
    expect(body.build.status).toBe("QUEUED");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/actions/workflows/factory-build.yml/dispatches");
    const inputs = (calls[0]!.body as { inputs: Record<string, string> }).inputs;
    expect(inputs.build_id).toBe(buildId);
    expect(inputs.ui_template).toBe("standard");
    expect(JSON.parse(inputs.spec_json).plugin.id).toBe("zarlino.customer.punch");
    // Nothing spec-derived is interpolated into the URL.
    expect(calls[0]!.url).not.toContain("Punch");
  });

  it("refuses a duplicate build id", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000002-bbb222";
    expect((await route(dispatchRequest(buildId), baseEnv, { fetchImpl }))!.status).toBe(202);
    const second = await route(dispatchRequest(buildId), baseEnv, { fetchImpl });
    expect(second!.status).toBe(409);
  });

  it("fails closed when GitHub refuses or is unreachable", async () => {
    const refused = fakeFetch(() => new Response("forbidden", { status: 403 }));
    const buildId = "fb-20261021T000003-ccc333";
    const response = await route(dispatchRequest(buildId), baseEnv, { fetchImpl: refused.fetchImpl });
    expect(response!.status).toBe(502);
    const body = (await response!.json()) as { ok: boolean; code: string; build: { status: string; failureState: string } };
    expect(body.ok).toBe(false);
    expect(body.build.status).toBe("FAILED");
    expect(body.build.failureState).toBe("DISPATCH_UNAUTHORIZED");

    const offline = fakeFetch(() => {
      throw new Error("network down");
    });
    const other = "fb-20261021T000004-ddd444";
    const failed = await route(dispatchRequest(other), baseEnv, { fetchImpl: offline.fetchImpl });
    expect(failed!.status).toBe(502);
    expect(((await failed!.json()) as { build: { status: string } }).build.status).toBe("FAILED");
  });

  it("fails closed when no GitHub token is configured", async () => {
    const env: FactoryRouteEnv = { ...baseEnv, GITHUB_TOKEN: undefined };
    const response = await route(dispatchRequest("fb-20261021T000005-eee555"), env);
    expect(response!.status).toBe(503);
    const build = getBuild(sql, "fb-20261021T000005-eee555");
    expect(build!.status).toBe("FAILED");
    expect(build!.failure_state).toBe("DISPATCH_NOT_CONFIGURED");
  });

  // -------------------------------------------------------------------------
  // Completion and reconciliation
  // -------------------------------------------------------------------------

  function completionRequest(buildId: string, record: unknown, token = REPORT): Request {
    return post(`/api/factory/builds/${buildId}/completion`, { status: "READY", record }, { authorization: `Bearer ${token}` });
  }

  it("refuses the completion callback without the report token", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000006-fff666";
    await route(dispatchRequest(buildId), baseEnv, { fetchImpl });

    expect((await route(completionRequest(buildId, {}, "wrong-token-wrong")))!.status).toBe(401);
    expect((await route(completionRequest(buildId, {}, GATEWAY)))!.status).toBe(401);
  });

  it("only reaches READY when the gate passed, and refuses a failed gate", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const good = "fb-20261021T000007-ggg777";
    await route(dispatchRequest(good), baseEnv, { fetchImpl });

    const failedGate = await route(completionRequest(good, { qaPassed: false, qaReport: { passed: false } }));
    expect(failedGate!.status).toBe(200);
    const failedBody = (await failedGate!.json()) as { build: { status: string; failureState: string } };
    expect(failedBody.build.status).toBe("FAILED");
    expect(failedBody.build.failureState).toBe("QA_GATE_FAILED");

    const second = "fb-20261021T000008-hhh888";
    await route(dispatchRequest(second), baseEnv, { fetchImpl });
    const passed = await route(
      completionRequest(second, {
        qaPassed: true,
        qaReport: { passed: true },
        artifact: { name: "Punch-v1.vst3.zip", zipBytes: 1234, zipSha256: "c".repeat(64) },
        timings: { compileSeconds: 400, testSeconds: 1 },
      }),
    );
    const body = (await passed!.json()) as { build: { status: string; qaPassed: boolean; artifact: { name: string } | null } };
    expect(body.build.status).toBe("READY");
    expect(body.build.qaPassed).toBe(true);
    expect(body.build.artifact!.name).toBe("Punch-v1.vst3.zip");

    // Terminal: a later failure claim cannot undo a READY build.
    const again = await route(completionRequest(second, { qaPassed: false }));
    expect(((await again!.json()) as { build: { status: string } }).build.status).toBe("READY");
  });

  it("promotes a build from the published evidence record and never from a corrupt one", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000009-iii999";
    await route(dispatchRequest(buildId), baseEnv, { fetchImpl });

    const record = {
      buildRecordSchemaVersion: 2,
      buildId,
      productName: "Punch",
      status: "READY",
      qaPassed: true,
      qaReport: { passed: true },
      artifact: { name: "Punch-v1.vst3.zip", zipBytes: 4321, zipSha256: "d".repeat(64) },
      timings: { compileSeconds: 380, testSeconds: 2 },
    };
    const bucket = r2Bucket({ [`factory-builds/${buildId}/build-record.json`]: JSON.stringify(record) });
    const response = await route(get(`/api/factory/builds/${buildId}`, { "x-factory-gateway": GATEWAY }), baseEnv, { bucket });
    const body = (await response!.json()) as { build: { status: string; qaPassed: boolean }; syncSource: string };
    expect(body.build.status).toBe("READY");
    expect(body.syncSource).toBe("record");

    const corruptId = "fb-20261021T000010-jjj000";
    await route(dispatchRequest(corruptId), baseEnv, { fetchImpl });
    const corruptBucket = r2Bucket({ [`factory-builds/${corruptId}/build-record.json`]: "{ not json" });
    const corrupt = await route(get(`/api/factory/builds/${corruptId}`, { "x-factory-gateway": GATEWAY }), baseEnv, { bucket: corruptBucket });
    expect(((await corrupt!.json()) as { build: { status: string; failureState: string } }).build.status).toBe("FAILED");
  });

  it("reports the stage a running build has actually reached", async () => {
    // A build used to sit at QUEUED for the whole compile - thirteen minutes of
    // "queued" for something that was already building. The run's own steps are
    // the honest source of progress.
    const buildId = "fb-20261021T000016-ppp555";
    const steps = [
      { name: "Set up job", status: "completed" },
      { name: "Validate build request", status: "completed" },
      { name: "Freeze and stage the specification", status: "completed" },
      { name: "Configure", status: "completed" },
      { name: "Build the factory kernel and the generator", status: "completed" },
      { name: "Generate the product project", status: "completed" },
      { name: "Compile the VST3 and the quality gate", status: "in_progress" },
      { name: "Run the generic quality gate", status: "queued" },
      { name: "Package the artifact and compute integrity hashes", status: "queued" },
    ];

    const { fetchImpl } = fakeFetch((captured) => {
      if (captured.url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (captured.url.includes("/jobs")) {
        return json({
          jobs: [{ name: "Assemble, build and gate", status: "in_progress", steps }],
        });
      }
      return json({
        workflow_runs: [
          {
            id: 9001,
            name: "Factory Product Build",
            display_title: `factory-build-${buildId}`,
            path: ".github/workflows/factory-build.yml",
            status: "in_progress",
            conclusion: null,
            created_at: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      });
    });

    await route(dispatchRequest(buildId), baseEnv, { fetchImpl });
    const response = await route(get(`/api/factory/builds/${buildId}`, { "x-factory-gateway": GATEWAY }), baseEnv, {
      bucket: r2Bucket({}),
      fetchImpl,
    });
    const body = (await response!.json()) as { build: { status: string }; syncSource: string };
    expect(body.syncSource).toBe("run_progress");
    // Compiling: it walked QUEUED -> ASSEMBLING -> BUILDING in one poll and
    // stopped there, because the gate has not started.
    expect(body.build.status).toBe("BUILDING");

    // The gate step starting moves it to TESTING; the publish job to PACKAGING.
    steps[7]!.status = "in_progress";
    const testing = await route(get(`/api/factory/builds/${buildId}`, { "x-factory-gateway": GATEWAY }), baseEnv, {
      bucket: r2Bucket({}),
      fetchImpl,
    });
    expect(((await testing!.json()) as { build: { status: string } }).build.status).toBe("TESTING");

    steps[7]!.status = "completed";
    steps[8]!.status = "completed";
    const publishing = await route(get(`/api/factory/builds/${buildId}`, { "x-factory-gateway": GATEWAY }), baseEnv, {
      bucket: r2Bucket({}),
      fetchImpl: fakeFetch((captured) => {
        if (captured.url.includes("/jobs")) {
          return json({
            jobs: [
              { name: "Assemble, build and gate", status: "completed", steps },
              { name: "Publish and report", status: "in_progress", steps: [{ name: "Download the verified build", status: "in_progress" }] },
            ],
          });
        }
        return json({
          workflow_runs: [
            {
              id: 9001,
              name: "Factory Product Build",
              display_title: `factory-build-${buildId}`,
              path: ".github/workflows/factory-build.yml",
              status: "in_progress",
              conclusion: null,
              created_at: new Date(Date.now() - 1000).toISOString(),
            },
          ],
        });
      }).fetchImpl,
    });
    expect(((await publishing!.json()) as { build: { status: string } }).build.status).toBe("PACKAGING");

    // Every step is recorded, so the customer-facing history is auditable.
    const events = sql.all<{ state: string }>("SELECT state FROM factory_build_events WHERE build_id = ? ORDER BY created_at ASC", buildId);
    expect(events.map((event) => event.state)).toEqual(["QUEUED", "ASSEMBLING", "BUILDING", "TESTING", "PACKAGING"]);
  });

  it("matches a run to its build by name, so one build never inherits another's failure", async () => {
    // Two builds dispatched in the same minute used to be indistinguishable: the
    // oldest candidate won, so build A could report build B's failure.
    const mine = "fb-20261021T000017-qqq666";
    const other = "fb-20261021T000018-rrr777";
    const dispatchFetch = fakeFetch(() => new Response(null, { status: 204 })).fetchImpl;
    await route(dispatchRequest(mine), baseEnv, { fetchImpl: dispatchFetch });
    await route(dispatchRequest(other), baseEnv, { fetchImpl: dispatchFetch });

    const createdAt = new Date(Date.now() - 500).toISOString();
    const crossTalk = fakeFetch((captured) => {
      if (captured.url.includes("/jobs")) return json({ jobs: [] });
      return json({
        workflow_runs: [
          {
            id: 7001,
            name: "Factory Product Build",
            display_title: `factory-build-${other}`,
            path: ".github/workflows/factory-build.yml",
            status: "completed",
            conclusion: "failure",
            created_at: createdAt,
          },
        ],
      });
    });

    const response = await route(get(`/api/factory/builds/${mine}`, { "x-factory-gateway": GATEWAY }), baseEnv, {
      bucket: r2Bucket({}),
      fetchImpl: crossTalk.fetchImpl,
    });
    const body = (await response!.json()) as { build: { status: string; failureState: string | null } };
    expect(body.build.status).not.toBe("FAILED");
    expect(body.build.failureState).toBeNull();
  });

  it("derives a stage only from steps that have started", async () => {
    expect(deriveStage([])).toBeNull();
    expect(deriveStage([{ name: "Compile the VST3", status: "queued" }])).toBeNull();
    expect(deriveStage([{ name: "Validate build request", status: "completed" }])).toBe("ASSEMBLING");
    expect(deriveStage([{ name: "Run the generic quality gate", status: "in_progress" }])).toBe("TESTING");
    // A renamed step must not crash or lie: unrecognised names carry no stage.
    expect(deriveStage([{ name: "Something we renamed later", status: "completed" }])).toBeNull();
    // The highest reached stage wins regardless of array order.
    expect(
      deriveStage([
        { name: "Package the artifact and compute integrity hashes", status: "completed" },
        { name: "Compile the VST3 and the quality gate", status: "completed" },
      ]),
    ).toBe("PACKAGING");
  });

  it("fails closed on timeout and stays pending while the build is young", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000011-kkk111";
    await route(dispatchRequest(buildId), baseEnv, { fetchImpl });

    const pending = await route(get(`/api/factory/builds/${buildId}`, { "x-factory-gateway": GATEWAY }), baseEnv, { bucket: r2Bucket({}), fetchImpl });
    expect(((await pending!.json()) as { build: { status: string } }).build.status).toBe("QUEUED");

    // Age the durable row past the deadline: nothing is coming, so fail closed.
    const old = new Date(Date.now() - 1000 * 60 * 120).toISOString();
    sql.run("UPDATE factory_builds SET created_at = ?, updated_at = ? WHERE id = ?", old, old, buildId);

    const config = { ...baseEnv, FACTORY_MAX_BUILD_MINUTES: "30" };
    const response = await route(get(`/api/factory/builds/${buildId}`, { "x-factory-gateway": GATEWAY }), config, { bucket: r2Bucket({}), fetchImpl });
    const body = (await response!.json()) as { build: { status: string; failureState: string }; syncSource: string };
    expect(body.syncSource).toBe("timeout");
    expect(body.build.status).toBe("FAILED");
    expect(body.build.failureState).toBe("BUILD_TIMEOUT");
  });

  it("returns 404 for an unknown build id", async () => {
    const response = await route(get("/api/factory/builds/fb-20261021T000012-zzz999", { "x-factory-gateway": GATEWAY }));
    expect(response!.status).toBe(404);
  });

  it("refuses an artifact key that does not belong to the build", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000014-mmm333";
    await route(dispatchRequest(buildId), baseEnv, { fetchImpl });

    const response = await route(
      completionRequest(buildId, {
        qaPassed: true,
        qaReport: { passed: true },
        artifact: { name: "x.vst3.zip", key: "factory-builds/fb-someone-else-000000/artifact/x.vst3.zip" },
      }),
    );
    const body = (await response!.json()) as { build: { status: string; failureState: string; artifact: unknown } };
    expect(body.build.status).toBe("FAILED");
    expect(body.build.failureState).toBe("EVIDENCE_INVALID");
    expect(body.build.artifact).toBeNull();

    const traversal = "fb-20261021T000015-nnn444";
    await route(dispatchRequest(traversal), baseEnv, { fetchImpl });
    const second = await route(
      completionRequest(traversal, {
        qaPassed: true,
        qaReport: { passed: true },
        artifact: { name: "x.vst3.zip", key: `factory-builds/${traversal}/../other/artifact/x.zip` },
      }),
    );
    expect(((await second!.json()) as { build: { status: string } }).build.status).toBe("FAILED");
  });

  it("never exposes raw logs or internal keys in a public build view", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    const buildId = "fb-20261021T000013-lll222";
    await route(dispatchRequest(buildId), baseEnv, { fetchImpl });
    const response = await route(get(`/api/factory/builds/${buildId}?events=1`, { "x-factory-gateway": GATEWAY }), baseEnv, { bucket: r2Bucket({}) });
    const text = await response!.text();
    expect(text).not.toContain("gh-test-token");
    expect(text).not.toContain("spec_json");
    expect(getBuildEvents(sql, buildId).length).toBeGreaterThan(0);
  });
});

