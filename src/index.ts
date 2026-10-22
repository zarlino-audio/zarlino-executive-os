/**
 * Zarlino Executive OS â€” Worker entry.
 *
 * A Cloudflare Worker + SQLite-backed Durable Object that runs the business:
 *   - `ExecutiveAgent` Durable Object holds the durable store (ExecutiveStore).
 *   - On every wake it runs the System Doctor (auto-fix), starts auto-runnable
 *     tasks, and reschedules itself (constant maintenance).
 *   - A 6-hourly cron triggers the same maintenance via the `scheduled` handler.
 *   - REST API (token/session auth) exposes overview, chat, tools, files,
 *     approvals, tasks, settings, export/import, and the Doctor.
 *
 * Secrets (never in this file): DEEPSEEK_API_KEY, FOUNDER_AUTH_TOKEN,
 * PAYSTACK_SECRET_KEY, GITHUB_TOKEN, CF_API_TOKEN, ZARLINO_LICENSE_PRIVATE_KEY.
 */

import { ExecutiveStore, SNAPSHOT_TABLES } from "./db/store";
import { createDoSql, type Sql } from "./db/sql";
import { SCHEMA_VERSION } from "./db/schema";
import { buildToolRegistry } from "./agent/tools";
import type { ToolRegistry } from "./core/tools/registry";
import { runDoctor } from "./core/doctor";
import { isToolCallSequenceError, repairToolCallSequence, trimTranscript } from "./core/transcript";
import { collectiveMetrics, runChaosTest, runOrgAnalyst } from "./core/org/intelligence";
import { runCeoCycle } from "./core/org/ceo";
import { resolveDaemonAgentId } from "./core/org/agents";
import { handleInboundWhatsApp, DIGEST_APPROVALS_SETTING } from "./core/org/founder-channel";
import { composeFounderDigest, cooldown, markFounderMessageSent, voiceStatus } from "./core/org/voice";
import { prepareDispatch } from "./core/org/dispatch";
import { applyExecutionBoundarySweep, classifyLocalWork } from "./core/org/execution-boundary";
import {
  cancelRemoteRun,
  dispatchRemoteWorkflow,
  remoteRunsSummary,
  syncActiveRemoteRuns,
  syncRemoteRun,
} from "./core/remote/execution";
import { findDuplicateTask, duplicateNote } from "./core/tasks/dedupe";
import { artifactKey, normalizeArtifactPath, MAX_ARTIFACT_BYTES } from "./core/artifacts";
import { escalateToFounder, sendWhatsApp } from "./integrations/whatsapp";
import { deepseekKeys, isDeepseekKeyFailure } from "./integrations/deepseek";
import { OUTREACH_TEMPLATES, outreachDailyCap, maybeAutoReply, recordProspectReply, runFollowUps, runOutreachCycle, sendOutreachNow } from "./core/outreach";
import { emailConfigured, type SendEmailBinding } from "./integrations/email";
import { chargeNeurons, DEFAULT_EXEC_MODEL, executiveGenerate, neuronBudget, neuronLedger, neuronsUsedToday } from "./integrations/workersai";
import { handleMcpMessage, MCP_PROTOCOL_VERSION, type McpEnv } from "./mcp/server";
import { createTask } from "./core/tasks/model";
import { hashPassword, timingSafeEqual, verifyPassword } from "./core/auth/passwords";
import { estimateCost } from "./core/model/pricing";
import { meterModelCall } from "./core/model/meter";
import {
  assignTask,
  budgetStatus,
  dailyRollup,
  detectContradictions,
  optimize,
  productivityReport,
  recommendAssignment,
} from "./core/productivity/manager";
import {
  aggregateTestResults,
  attentionCheckFailed,
  deriveKnowledge,
  evaluateProductGates,
  failureRecord,
  normalizeTier,
  perceptualKpi,
  scoreProduct,
} from "./core/perceptual/manager";
import { newId, nowIso } from "./ids";
import { evaluateChecks, planBackupPrune, parseDeepSeekBalance, STATIC_TARGETS, WEBSITE_BASE, WEBSITE_FALLBACK_TARGETS, WEBSITE_REPO, buildWebsiteTargets, type CheckResult, type MonitorState, type MonitorTarget, type WebsiteContract } from "./core/monitor";
import { isTerminalTaskStatus, GovernanceError } from "./core/tasks/evidence";
import { dependencyState, releaseCompletedDependencies } from "./core/tasks/dependencies";
import { handleFactoryRoute } from "./core/factory/routes";
import { isTerminalState as isTerminalFactoryState, listBuilds as listFactoryBuilds } from "./core/factory/builds";
import { syncFactoryBuild } from "./core/factory/dispatch";
import type { AgentRun, DoctorLog, Task } from "./types";
import type { ModelCallRecord as _M } from "./core/model/types";
type ModelCall = _M;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  EXECUTIVE_AGENT: DurableObjectNamespace;
  ZARLINO_KV?: KVNamespace;
  ARTIFACTS?: R2Bucket;
  ASSETS?: Fetcher;
  DEEPSEEK_API_KEY?: string;
  /** Secondary DeepSeek key, used when the primary is exhausted/rejected. */
  DEEPSEEK_API_KEY_FALLBACK?: string;
  FOUNDER_AUTH_TOKEN?: string;
  INTERNAL_SECRET?: string;
  GITHUB_TOKEN?: string;
  CF_API_TOKEN?: string;
  /**
   * Plugin Factory gateway: the shared service credential the customer
   * application uses for /api/factory/*. Separate from FOUNDER_AUTH_TOKEN and
   * INTERNAL_SECRET on purpose — a customer-facing worker must never hold a
   * credential that opens the founder surface.
   */
  FACTORY_GATEWAY_SECRET?: string;
  /** Token the build workflow uses to report completion (never a founder token). */
  BUILD_REPORT_TOKEN?: string;
  FACTORY_REPO?: string;
  FACTORY_BUILD_REF?: string;
  FACTORY_MAX_BUILD_MINUTES?: string;
  /** YouTube Data API v3 key for prospect sourcing (youtube.* tools). */
  YOUTUBE_API_KEY?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_CURRENCY?: string;
  ZARLINO_LICENSE_PRIVATE_KEY?: string;
  WEBSITE_URL?: string;
  /** Second alert channel (ntfy topic URL) for external uptime alerts. */
  ALERT_NTFY_URL?: string;
  /** USD threshold under which the OS alerts to top up DeepSeek (default $10). */
  AI_BALANCE_WARN_USD?: string;
  /** Outbound email (growth outreach): provider + verified sender identity. */
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_REPLY_TO?: string;
  /** Cloudflare Email Sending binding ([[send_email]] in wrangler.toml). */
  SEND_EMAIL?: SendEmailBinding;
  /** Hard cap on outreach emails per day across manual + automatic paths. */
  OUTREACH_DAILY_CAP?: string;
  /** Growth agent: LLM auto-reply cap per day + follow-up delay in days. */
  GROWTH_REPLY_DAILY_CAP?: string;
  FOLLOWUP_AFTER_DAYS?: string;
  AI_DAILY_BUDGET?: string;
  AI_MONTHLY_BUDGET?: string;
  AI_PER_TASK_BUDGET?: string;
  AI_PER_RUN_BUDGET?: string;
  DOCTOR_AUTOFIX?: string;
  /** CAO tier model (task board + founder WhatsApp channel). */
  CAO_AI_MODEL?: string;
  /** DeepSeek fallback for the founder channel when Workers AI cannot answer. */
  DEEPSEEK_CAO_MODEL?: string;
  AI_NEURON_DAILY_BUDGET?: string;
  AI_NEURON_CAO_RESERVE?: string;
  MAX_AUTO_JOBS?: string;
  MAX_RUN_ITERATIONS?: string;
  // Executive tier (Workers AI neurons) + founder WhatsApp channel + CEO policy.
  AI?: unknown;
  EXEC_AI_MODEL?: string;
  WHATSAPP_PROVIDER?: string;
  WHATSAPP_TO?: string;
  WHATSAPP_APIKEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
  META_WHATSAPP_TOKEN?: string;
  META_PHONE_NUMBER_ID?: string;
  WHATSAPP_FOUNDER_NUMBER?: string;
  WHATSAPP_FOUNDER_LIDS?: string;
  CEO_AUTO_APPROVE?: string;
  /** Minutes a previous CEO AI summary may be reused (default 30). */
  CEO_SUMMARY_REUSE_MINUTES?: string;
}

const INTERNAL_HEADER = "x-exec-internal";
// FAIL CLOSED: there is NO hardcoded fallback secret. When INTERNAL_SECRET is
// not configured, internal routes accept nobody and worker-side internal
// calls are skipped; the doctor check `security.internal_secret` makes the
// misconfiguration loud instead of silently permissive.
function internalSecret(env?: Env): string | null {
  const v = env?.INTERNAL_SECRET;
  return v && String(v).trim() ? String(v).trim() : null;
}
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/** Decode standard base64 to bytes; throws on malformed input (atob). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

/** Detect uploaded-file kind from MIME type. */
function kindFromMime(mime: string): "image" | "text" | "audio" | "other" {
  if (/^image\//i.test(mime)) return "image";
  if (/^text\//i.test(mime) || /json|xml|yaml|markdown|csv|javascript/.test(mime)) return "text";
  if (/^audio\//i.test(mime) || /wav|mp3|ogg|flac|m4a/.test(mime)) return "audio";
  return "other";
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return !/^(0|false|no|off)$/i.test(v);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorized(request: Request, env: Env, store: ExecutiveStore): boolean {
  const header = request.headers.get("Authorization") || "";
  const token = env.FOUNDER_AUTH_TOKEN;
  if (token) {
    if (header.startsWith("Bearer ") && timingSafeEqual(header.slice(7), token)) return true;
    const url = new URL(request.url);
    const q = url.searchParams.get("token");
    if (q && timingSafeEqual(q, token)) return true;
  }
  if (header.startsWith("Bearer ")) {
    const session = store.getSession(header.slice(7));
    if (session && session.expires_at > new Date().toISOString()) return true;
  }
  return false;
}

function internal(request: Request, secret: string | null): boolean {
  // Fail closed: a missing configured secret never matches (spec §8/§10).
  if (!secret) return false;
  return request.headers.get(INTERNAL_HEADER) === secret;
}

// ---------------------------------------------------------------------------
// DeepSeek chat + agent loop
// ---------------------------------------------------------------------------

interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** One streamed delta from the provider (content and/or reasoning text). */
interface ChatDelta {
  text?: string;
  reasoning?: string;
}

/**
 * Build the provider request body. Tool names are sanitized for the wire
 * (DeepSeek forbids dots in names). Transcript hygiene is enforced here too â€”
 * never put an assistant `tool_calls` message without one `tool` response per
 * id on the wire (instant HTTP 400); single pass, no-op when already valid.
 */
function chatRequestBody(
  model: string,
  messages: ChatMsg[],
  registry: ToolRegistry,
  stream: boolean,
  noTools = false,
): string {
  const repaired = repairToolCallSequence(messages);
  if (repaired !== messages) messages.splice(0, messages.length, ...repaired);
  return JSON.stringify({
    model,
    messages,
    ...(noTools ? {} : { tools: registry.functionSchemas(), tool_choice: "auto" }),
    max_tokens: 2048,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
}

function recordChatCost(
  store: ExecutiveStore,
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  latencyMs: number,
  fallbackChars = 0,
  attribution: { sessionId?: string; runId?: string } = {},
): void {
  // Priced by the shared meter so the dollars booked here are identical to the
  // dollars every other provider call books (see core/model/meter.ts).
  //
  // The meter is handed the REAL store on purpose. This function used to pass a
  // shim ({ record: recordCost, addTokenUse: () => {} }) that wrote the
  // model_costs ledger and THREW AWAY the token_budgets increment â€” every real
  // provider call was therefore invisible to the budget meter, and the two
  // halves of the same feature could never agree. meterModelCall is now the
  // single writer for both tables: there is no path that writes one without
  // the other.
  meterModelCall(store, {
    model,
    taskType: "chat",
    usage,
    latencyMs,
    fallbackChars,
    sessionId: attribution.sessionId,
    runId: attribution.runId,
  });
}

/**
 * Test-only hook: exercise the REAL non-streaming provider call path
 * (request build -> fetch -> usage parse -> recordChatCost -> meter) against a
 * stubbed global fetch, so the metering path can be asserted with pinned
 * provider numbers instead of a mocked meter.
 *
 * This is not a re-export of different behaviour: it is the same function the
 * Durable Object calls, surfaced so the metering test does not have to reach
 * into module internals.
 */
export function callDeepSeekForTest(
  apiKey: string,
  messages: ChatMsg[],
  registry: ToolRegistry,
  store: ExecutiveStore,
  model = "deepseek-chat",
  opts: { signal?: AbortSignal; noTools?: boolean; sessionId?: string; runId?: string } = {},
): Promise<ChatMsg> {
  return callDeepSeek(apiKey, messages, registry, store, model, opts);
}

async function callDeepSeek(
  apiKey: string,
  messages: ChatMsg[],
  registry: ToolRegistry,
  store: ExecutiveStore,
  model = "deepseek-chat",
  opts: { signal?: AbortSignal; noTools?: boolean; sessionId?: string; runId?: string } = {},
): Promise<ChatMsg> {
  const attribution = { sessionId: opts.sessionId, runId: opts.runId };
  const started = Date.now();
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: chatRequestBody(model, messages, registry, false, opts.noTools === true),
    signal: opts.signal,
  });
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: ChatMsg }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Empty model response");
  recordChatCost(store, model, data.usage, latencyMs, 0, attribution);
  return message;
}

/**
 * One call with key fallback: try each configured DeepSeek key in order and
 * advance ONLY on an auth/balance refusal (401/402/403). A malformed request
 * or a network failure fails identically on the second key, so it propagates.
 */
async function callDeepSeekWithFallback(
  env: Env,
  messages: ChatMsg[],
  registry: ToolRegistry,
  store: ExecutiveStore,
  model: string,
  opts: { signal?: AbortSignal; noTools?: boolean; sessionId?: string; runId?: string } = {},
): Promise<ChatMsg> {
  const keys = deepseekKeys(env);
  if (keys.length === 0) throw new Error("DEEPSEEK_API_KEY not configured - set it as a Worker secret.");
  let lastErr: unknown = null;
  for (let k = 0; k < keys.length; k++) {
    try {
      return await callDeepSeek(keys[k]!, messages, registry, store, model, opts);
    } catch (err) {
      lastErr = err;
      if (k >= keys.length - 1 || !isDeepseekKeyFailure(err)) throw err;
    }
  }
  throw lastErr ?? new Error("DeepSeek: no usable API key");
}

/**
 * Streaming completion (audit gap 1): forwards content + reasoning deltas to
 * `onDelta` as they arrive and assembles the final assistant message â€”
 * including `tool_calls`, whose id/name/arguments arrive as fragments spread
 * across deltas â€” exactly like the non-streaming path. `signal` makes stop
 * (audit gap 6) actually cancel the in-flight provider request.
 */
async function callDeepSeekStream(
  apiKey: string,
  messages: ChatMsg[],
  registry: ToolRegistry,
  store: ExecutiveStore,
  model: string,
  onDelta: (d: ChatDelta) => void,
  signal?: AbortSignal,
  attribution: { sessionId?: string; runId?: string } = {},
): Promise<ChatMsg> {
  const started = Date.now();
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: chatRequestBody(model, messages, registry, true),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("Empty model response");

  // Minimal structural view of an OpenAI-compatible SSE frame.
  interface StreamFrame {
    choices?: Array<{
      delta?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let sawFrame = false;
  const calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let frame: StreamFrame;
      try {
        frame = JSON.parse(payload) as StreamFrame;
      } catch {
        continue;
      }
      sawFrame = true;
      if (frame.usage) usage = frame.usage;
      const delta = frame.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onDelta({ text: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        reasoning += delta.reasoning_content;
        onDelta({ reasoning: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : calls.length;
          const slot = (calls[idx] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    }
  }
  if (!sawFrame) throw new Error("Empty model response");
  recordChatCost(store, model, usage, Date.now() - started, content.length + reasoning.length, attribution);
  const message: ChatMsg = { role: "assistant", content };
  const usable = calls.filter((c) => c.id && c.function.name);
  if (usable.length > 0) message.tool_calls = usable;
  return message;
}

/** Models the chat may run on (audit gap 10 â€” no more hardcoded single model). */
const CHAT_MODELS = ["deepseek-chat", "deepseek-reasoner"] as const;
const DEFAULT_CHAT_MODEL = "deepseek-chat";

function normalizeChatModel(model: unknown): string {
  return typeof model === "string" && (CHAT_MODELS as readonly string[]).includes(model) ? model : DEFAULT_CHAT_MODEL;
}

/**
 * Human-readable manifest for files attached to a chat message. The bytes live
 * in uploaded_files; this tells the agent what was attached and how to read it
 * (`executive.get_file { id }`).
 */
function attachmentManifest(list: unknown): string {
  if (!Array.isArray(list) || list.length === 0) return "";
  const parts: string[] = [];
  for (const raw of list.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { id?: unknown; name?: unknown; kind?: unknown };
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!id) continue;
    const name = (typeof rec.name === "string" ? rec.name : "file").slice(0, 120);
    const kind = typeof rec.kind === "string" ? `, ${rec.kind}` : "";
    parts.push(`${name} (id=${id}${kind})`);
  }
  if (parts.length === 0) return "";
  return `[attachments] ${parts.join(", ")} â€” read them with executive.get_file { id } when relevant.`;
}

const SYSTEM_PROMPT = `You are the Zarlino Executive OS â€” the autonomous operator of Zarlino Audio, a small audio-plugins company (ZTame, ZScorch). You run the business through tools and a durable store.

Working rules:
1. Use tools to gather facts before asserting them. Never fabricate numbers (doctrine: HONEST_NUMBERS) â€” say UNKNOWN instead.
2. HIGH-risk / irreversible actions (spending money, deploys, cache purges) are gated behind Founder approval â€” never execute them yourself; request an approval or flag the Founder.
3. Audit-worthy actions are recorded automatically by the tool registry.
4. Keep replies concise and actionable. Use markdown for structure.
5. When the Founder asks, run the System Doctor (system.doctor) to check and repair the system; run maintenance (system.maintenance) when housekeeping is needed.
6. The LOCAL machine is for non-engineering maintenance only (health/connectivity checks; executive.request_local_task with machine_maintenance:true). ENGINEERING work â€” code changes, builds, tests, renders, packaging, deploys â€” is REMOTE-ONLY: dispatch it to GitHub Actions with remote.dispatch_workflow (attach taskId so evidence lands on the board), then track it with remote.sync_runs.`;

function buildSystemContext(env: Env): ChatMsg {
  return {
    role: "system",
    content: `${SYSTEM_PROMPT}\n\nWebsite: ${env.WEBSITE_URL ?? "https://zarlinoaudio.com"}\nCurrency: ${env.PAYSTACK_CURRENCY ?? "GHS"}\nDaily AI budget: ${env.AI_DAILY_BUDGET ?? "5"}$\nMonthly AI budget: ${env.AI_MONTHLY_BUDGET ?? "80"}$`,
  };
}

/** Keep an auto-generated title short, single-line and free of quotes/markup. */
function sanitizeChatTitle(raw: string): string {
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const cleaned = firstLine.replace(/^["'`*#\s]+/, "").replace(/["'`*\s]+$/, "").replace(/[.:;,]+$/, "").trim();
  if (cleaned.length <= 64) return cleaned;
  return `${cleaned.slice(0, 61).trim()}...`;
}

/**
 * Run one agent turn (chat or task-driven) with the tool loop. Bounded by
 * maxIterations. Records messages + cost. Returns the final assistant text.
 */
async function agentLoop(opts: {
  store: ExecutiveStore;
  registry: ToolRegistry;
  env: Env;
  sessionId?: string;
  runId?: string;
  messages: ChatMsg[];
  onChunk?: (text: string) => void;
  /** When set, the model is called with `stream: true` and every delta is forwarded. */
  onDelta?: (d: ChatDelta) => void;
  /** Progress narration for the UI ("running web.search", â€¦). */
  onStatus?: (status: { label: string; tool?: string }) => void;
  /** Cancels the in-flight provider call (founder pressed stop). */
  signal?: AbortSignal;
  model?: string;
  maxIterations?: number;
}): Promise<{ text: string; iterations: number; toolsCalled: number; limitReached: boolean }> {
  const apiKeys = deepseekKeys(opts.env);
  if (apiKeys.length === 0) throw new Error("DEEPSEEK_API_KEY not configured â€” set it as a Worker secret.");
  const model = opts.model ?? "deepseek-chat";
  const store = opts.store;
  const maxIter = opts.maxIterations ?? 8;
  const messages = [...opts.messages];
  // THE fix for the meter divergence: this sink used to write ONLY the
  // model_costs ledger. Every real provider call therefore left token_budgets
  // untouched, so the budget knob (and productivity.budget_status) reported a
  // tiny hand-entered number while the ledger reported the real spend.
  // Booking through meterModelCall keeps ledger and budget identical by
  // construction, priced from the one shared table.
  // Books BOTH tables through the one meter: model_costs (the ledger every
  // dollar figure is summed from) and token_budgets (what the budget gate and
  // productivity.budget_status read). Writing them by hand here is how they
  // drifted apart in the first place.
  const recordCost = (c: ModelCall) => {
    const tokens = c.inputTokens + c.outputTokens;
    if (tokens > 0) store.addTokenUse("global", undefined, tokens, c.cost);
    store.record({ ...c, sessionId: opts.sessionId, runId: opts.runId });
  };
  let iterations = 0;
  let toolsCalled = 0;
  // Keep the in-memory transcript bounded so very long runs don't overflow the
  // model context window (system + prompt head, recent tail). The trim is
  // tool-call-group aligned: a raw `slice(0, 10)` + `slice(-70)` cut used to
  // split an assistant `tool_calls` message from its `tool` responses, and
  // because this array is checkpointed below, that one bad cut made EVERY
  // later auto-resume replay an invalid request (DeepSeek HTTP 400).
  const prune = () => {
    if (messages.length <= 100) return;
    messages.splice(0, messages.length, ...trimTranscript(messages, { keepHead: 10, keepTail: 70 }));
  };

  for (let i = 0; i < maxIter; i++) {
    iterations++;
    // Keep the long-horizon run row alive + report live progress. Without
    // this, any run executing >15min was reaped as a "restart orphan" by the
    // Doctor's maintenance sweep even though it was actively working.
    if (opts.runId) store.heartbeatAgentRun(opts.runId, iterations, toolsCalled);
    let reply: ChatMsg;
    // Key fallback: the primary account may be exhausted (HTTP 402) while the
    // founder's fallback key still funds light traffic. Only an auth/balance
    // refusal justifies the second key — a 400 transcript would fail twice.
    const invokeModel = async (): Promise<ChatMsg> => {
      const onDelta = opts.onDelta;
      let lastErr: unknown = null;
      for (let k = 0; k < apiKeys.length; k++) {
        try {
          const out = onDelta
            ? await callDeepSeekStream(apiKeys[k]!, messages, opts.registry, store, model, onDelta, opts.signal, {
                sessionId: opts.sessionId,
                runId: opts.runId,
              })
            : await callDeepSeek(apiKeys[k]!, messages, opts.registry, store, model, {
                signal: opts.signal,
                sessionId: opts.sessionId,
                runId: opts.runId,
              });
          if (k > 0) {
            // Observability: only record when the fallback key was needed.
            try {
              store.setSetting("deepseek_last_key", "fallback");
            } catch {
              /* observability only */
            }
          }
          return out;
        } catch (err) {
          lastErr = err;
          if (k >= apiKeys.length - 1 || !isDeepseekKeyFailure(err)) throw err;
        }
      }
      throw lastErr ?? new Error("DeepSeek: no usable API key");
    };
    try {
      reply = await invokeModel();
    } catch (err) {
      // Self-heal a broken tool-call sequence (e.g. a checkpoint written by an
      // older build) and retry once instead of failing the whole run.
      if (!isToolCallSequenceError(err)) throw err;
      messages.splice(0, messages.length, ...repairToolCallSequence(messages));
      reply = await invokeModel();
    }
    messages.push(reply);
    const toolCalls = reply.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      for (const call of toolCalls) {
        toolsCalled++;
        // Map the provider-sanitized name back to the real tool before running.
        const realName = opts.registry.resolveName(call.function.name);
        // AOrgI Â§10 capability governance: agent â†’ capability check â†’
        // governance check â†’ autonomy check â†’ tool. This loop is executed by
        // the registered `executive_do_01` instance (role_coa); DENY/REVIEW
        // blocks the tool and is reported back to the model + governance.
        const toolDef = opts.registry.getTool(realName);
        const capability = toolDef?.requiredPermission ?? "execute";
        const gate = store.capabilityVerdictForAgent("executive_do_01", capability, realName);
        if (gate.verdict !== "ALLOW") {
          // Â§11 hard-constraint handling: BLOCK â†’ LOG â†’ ESCALATE. The call is
          // blocked here; the audit row is the LOG; the message is the ESCALATE.
          const message =
            gate.verdict === "DENY"
              ? `CAPABILITY_DENIED: ${gate.reason}`
              : `REVIEW_REQUIRED: ${gate.reason} Request founder approval before retrying.`;
          store.insertAudit({
            id: newId("aud"),
            actor: "executive_do_01",
            action: gate.verdict === "DENY" ? "capability.denied" : "capability.review_required",
            entity_type: "tool_calls",
            entity_id: realName,
            detail_json: JSON.stringify({ capability, reason: gate.reason, grantId: gate.grantId }),
            source: "executive",
            created_at: nowIso(),
            updated_at: nowIso(),
          });
          store.sendOrgMessage({
            fromRole: "role_coa",
            toRole: "role_finance_governance",
            type: "ESCALATION",
            taskId: opts.runId ? store.getAgentRun(opts.runId)?.task_id ?? undefined : undefined,
            payload: { tool: realName, capability, verdict: gate.verdict, reason: gate.reason },
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: message });
          continue;
        }
        // Narrate progress: tool phases produce no content deltas, so the UI
        // would otherwise show an empty bubble while real work happens.
        opts.onStatus?.({ label: `running ${realName}`, tool: realName });
        const result = await opts.registry.run(realName, safeParseArgs(call.function.arguments), {
          env: opts.env as unknown as Record<string, string | undefined>,
          store,
          audit: (actor, action, entityType, entityId, detail) => {
            store.insertAudit({
              id: newId("aud"),
              actor,
              action,
              entity_type: entityType,
              entity_id: entityId,
              detail_json: detail ? JSON.stringify(detail) : undefined,
              source: "executive",
              created_at: nowIso(),
              updated_at: nowIso(),
            });
          },
          recordCost,
          runId: opts.runId,
          sessionId: opts.sessionId,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.ok ? truncate(JSON.stringify(result.output), 6000) : `ERROR: ${truncate(result.error, 1000)}`,
        });
      }
      // Durable transcript so a continued run resumes where it left off
      // (checkpointAgentRun also refreshes last_heartbeat).
      opts.onStatus?.({ label: "thinking" });
      prune();
      if (opts.runId) store.checkpointAgentRun(opts.runId, JSON.stringify(messages));
      continue;
    }
    const text = String(reply.content ?? "");
    // With true streaming the text already reached the client delta-by-delta â€”
    // re-sending the whole reply through onChunk would duplicate it.
    if (!opts.onDelta) opts.onChunk?.(text);
    return { text, iterations, toolsCalled, limitReached: false };
  }
  // Ran out of iterations while still requesting tools â€” the caller decides
  // whether to mark DONE (chat) or auto-continue (long-horizon runs).
  const text = "Reached the tool-call limit for this turn. Narrow the request or ask to continue.";
  opts.onChunk?.(text);
  return { text, iterations, toolsCalled, limitReached: true };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\nâ€¦(truncated)" : s;
}

// ---------------------------------------------------------------------------
// Auto-run sweep (automate fixing): start + execute auto-runnable tasks.
// ---------------------------------------------------------------------------

function startAutoRunnable(store: ExecutiveStore, maxJobs: number): { started: string[] } {
  // Dependency release first: a task blocked while its predecessor was still
  // running becomes runnable the moment that predecessor is DONE (objective
  // linkage — otherwise a chain stalls on an input that has already arrived).
  releaseCompletedDependencies(store);
  const running = store.countRunningAgentRuns();
  const budget = Math.max(0, maxJobs - running);
  if (budget <= 0) return { started: [] };
  const tasks = store.listAutoRunnableTasks(budget * 3);
  const started: string[] = [];
  for (const t of tasks) {
    if (started.length >= budget) break;
    if (store.pendingApprovalForTask(t.id)) continue;
    if (store.hasRunningRunForTask(t.id)) continue;
    // Dependency gate: no start while the predecessor is unfinished — QA does
    // not "verify" a run that has not happened yet.
    if (dependencyState(store, t) === "WAITING") continue;
    // Backoff: don't immediately re-spawn a run for a task whose last run just
    // failed (e.g. DeepSeek 402) â€” that would churn a run every wake.
    if (store.hasRecentFailedRunForTask(t.id)) continue;
    const now = nowIso();
    store.createAgentRun({
      id: newId("run"),
      task_id: t.id,
      prompt: `AUTO-RUN task: ${t.title}\n\n${t.description ?? ""}\n\nWork through PLAN â†’ IMPLEMENT â†’ VERIFY â†’ REPORT using your tools, then mark the task DONE if the work is complete, or report what is blocking.`,
      status: "RUNNING",
      iterations: 0,
      tools_called: 0,
      started_at: now,
      source: "system",
      created_at: now,
      updated_at: now,
      last_heartbeat: now,
    });
    store.updateTask(t.id, { status: "IN_PROGRESS" } as never);
    started.push(t.id);
  }
  return { started };
}

/**
 * Resume resumable long-horizon runs â€” restart orphans (FAILED, 0 iterations â€”
 * no tool side-effects happened, so re-running is lossless) AND limit-reached
 * runs (STOPPED with an auto-continue note + a durable checkpoint). Bounded by
 * the same concurrency budget as startAutoRunnable; skips tasks that are
 * blocked, done, already running, or awaiting founder approval. Returns the
 * resumed run ids.
 */
function resumeInterruptedRuns(store: ExecutiveStore, maxJobs: number): { resumed: string[] } {
  const running = store.countRunningAgentRuns();
  const budget = Math.max(0, maxJobs - running);
  if (budget <= 0) return { resumed: [] };
  const candidates = [...store.listInterruptedRuns(50), ...store.listLimitReachedRuns(50)];
  const resumed: string[] = [];
  const seen = new Set<string>();
  for (const run of candidates) {
    if (resumed.length >= budget) break;
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (run.task_id) {
      if (store.hasRunningRunForTask(run.task_id)) continue;
      if (store.pendingApprovalForTask(run.task_id)) continue;
      const task = store.getTask(run.task_id);
      if (task && !["OPEN", "IN_PROGRESS"].includes(task.status)) continue;
      // Same dependency gate as fresh starts: resuming a dependent run while
      // its predecessor is unfinished would repeat the guesswork.
      if (task && dependencyState(store, task) === "WAITING") continue;
      store.updateTask(run.task_id, { status: "IN_PROGRESS" } as never);
    }
    store.resetAgentRun(run.id);
    resumed.push(run.id);
  }
  return { resumed };
}

async function executeAgentRun(store: ExecutiveStore, registry: ToolRegistry, env: Env, run: AgentRun): Promise<void> {
  // Long-horizon runs get a real per-sweep iteration budget; when they hit it
  // they are marked STOPPED and the maintenance sweep AUTO-CONTINUES them from
  // their checkpoint (see resumeInterruptedRuns) â€” so a run can work all day,
  // bounded only by the AI spend gate, not an arbitrary call count.
  const maxIter = Math.max(1, Math.min(60, Number(env.MAX_RUN_ITERATIONS) || 40));
  try {
    // Resume from the durable checkpoint if one exists (keeps the transcript
    // across auto-continue sweeps instead of restarting from the bare prompt).
    let initial: ChatMsg[] = [buildSystemContext(env), { role: "user", content: run.prompt }];
    if (run.checkpoint_json) {
      try {
        const parsed = JSON.parse(run.checkpoint_json) as ChatMsg[];
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.role === "system") {
          // Heal checkpoints written by builds whose trim could split a
          // tool-call group â€” otherwise every resume of this run replays the
          // same invalid request and fails with HTTP 400 forever.
          initial = repairToolCallSequence(parsed);
        }
      } catch {
        /* malformed checkpoint â€” fall back to the prompt */
      }
    }
    const result = await agentLoop({
      store,
      registry,
      env,
      runId: run.id,
      sessionId: `run_${run.id}`,
      messages: initial,
      maxIterations: maxIter,
    });
    if (result.limitReached) {
      // Not finished â€” keep it resumable; the sweep auto-continues it.
      // Deliberately NOT marking the task DONE (it isn't).
      store.finishAgentRun(run.id, "STOPPED", undefined, `Hit the ${maxIter}-iteration per-sweep limit â€” auto-continue scheduled.`);
      return;
    }
    store.finishAgentRun(run.id, "DONE", result.text);
    if (run.task_id) {
      // Closed-loop governance: the autonomous sweep obeys the same gate as
      // every other caller. If the run produced no evidence, the task stays
      // open (and the run note says so) instead of silently claiming DONE.
      try {
        store.setTaskStatus(run.task_id, "DONE");
      } catch (gateErr) {
        const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
        store.finishAgentRun(run.id, "DONE", result.text, `Task left OPEN by the evidence gate: ${msg}`);
      }
    }
  } catch (err) {
    store.finishAgentRun(run.id, "FAILED", undefined, err instanceof Error ? err.message : String(err));
  }
}

/** The RUNNING runs for the given auto-started task ids + resumed run ids. */
function collectRunsToExecute(store: ExecutiveStore, taskIds: string[], runIds: string[]): AgentRun[] {
  const runs: AgentRun[] = [];
  const seen = new Set<string>();
  for (const taskId of taskIds) {
    const run = store.listAgentRuns(50).find((r) => r.task_id === taskId && r.status === "RUNNING");
    if (run && !seen.has(run.id)) {
      seen.add(run.id);
      runs.push(run);
    }
  }
  for (const runId of runIds) {
    const run = store.getAgentRun(runId);
    if (run && run.status === "RUNNING" && !seen.has(run.id)) {
      seen.add(run.id);
      runs.push(run);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function buildOverview(store: ExecutiveStore, env: Env): Record<string, unknown> {
  const state = store.ensureExecutiveState();
  const doctor: DoctorLog | null = store.latestDoctorLog();
  const stuck = store.stuckCounts();
  const overrides = store.getBudgetOverrides();
  return {
    generatedAt: new Date().toISOString(),
    state: {
      overallStatus: state.overall_status,
      autonomyMode: state.autonomy_mode,
      paused: state.paused === 1,
      delegateMode: state.delegate_mode === 1,
      fullAccess: state.full_access === 1,
      spendingDisabled: state.spending_disabled === 1,
      deploymentsDisabled: state.deployments_disabled === 1,
    },
    doctor: doctor
      ? {
          lastRunAt: doctor.run_at,
          trigger: doctor.trigger,
          autoFix: doctor.auto_fix === 1,
          summary: safeJson(doctor.summary_json, null),
        }
      : { lastRunAt: null, note: "Doctor has not run yet â€” it runs on DO wake." },
    maintenance: { staleAgentRuns: stuck.staleAgentRuns, expiredLocalLeases: stuck.expiredLeases },
    budget: {
      daily: overrides.aiDailyBudget ?? (Number(env.AI_DAILY_BUDGET) || 0),
      monthly: overrides.aiMonthlyBudget ?? (Number(env.AI_MONTHLY_BUDGET) || 0),
      spentToday: store.spentToday(),
      spentThisMonth: store.spentThisMonth(),
      tokensToday: store.tokensToday(),
      tokensThisMonth: store.tokensThisMonth(),
      overrides,
    },
    counters: {
      openTasks: store.countOpenTasks(),
      pendingApprovals: store.listApprovals({ status: "PENDING" }).length,
      openRisks: store.openRisks().length,
      products: store.listProducts().length,
      pipelineGates: store.listPipelineGates().length,
      localTasksPending: store.listLocalTasks(100).filter((t) => t.status === "PENDING").length,
      agentRunsRunning: store.listAgentRuns(100).filter((r) => r.status === "RUNNING").length,
      remindersOverdue: store.listReminders({ overdueOnly: true }).length,
      notes: store.listNotes(1000).length,
      events: store.listCalendarEvents(undefined, undefined, 1000).length,
      assignmentsOpen: store.listAssignments({ limit: 200 }).filter((a) => a.status === "ASSIGNED" || a.status === "IN_PROGRESS").length,
      contradictionsOpen: store.countOpenContradictions(),
    },
    finance: store.latestSnapshot(),
    products: store.listProducts().map((p) => ({ id: p.id, name: p.name, status: p.status, version: p.version })),
    recentAudit: store.listAudit(8).map((e) => ({ id: e.id, actor: e.actor, action: e.action, entity_type: e.entity_type, entity_id: e.entity_id, created_at: e.created_at })),
    links: {
      health: "/api/health",
      doctor: "/api/doctor/run",
      productivity: "/api/productivity/report",
      overview: "/api/executive/overview",
    },
  };
}

function safeJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Backup pipeline
// ---------------------------------------------------------------------------
// The reset flow must hand over a durable backup WITHOUT materialising the
// whole database in the DO isolate (that OOM'd the isolate: 128MB heap vs the
// append-only tables). Strategy: write each table to KV one at a time, chunked
// per 1000 rows so a single `put` never exceeds KV's 25MB value limit and peak
// heap stays proportional to the largest table.

const BACKUP_CHUNK_ROWS = 1000;

async function persistBackupToKv(
  kv: KVNamespace | undefined,
  store: ExecutiveStore,
): Promise<{ key: string; tables: number; rows: number }> {
  const stamp = nowIso().replace(/[^\d]/g, "").slice(0, 14);
  const prefix = `backup/reset-${stamp}`;
  let tables = 0;
  let rows = 0;
  if (kv) {
    for (const table of SNAPSHOT_TABLES) {
      let all: Record<string, unknown>[];
      try {
        all = store.exportTableRows(table);
      } catch {
        continue;
      }
      if (all.length === 0) continue;
      for (let i = 0; i < all.length; i += BACKUP_CHUNK_ROWS) {
        const chunk = all.slice(i, i + BACKUP_CHUNK_ROWS);
        await kv.put(`${prefix}/${table}.${i / BACKUP_CHUNK_ROWS}.json`, JSON.stringify(chunk));
      }
      rows += all.length;
      tables += 1;
    }
    await kv.put(
      `${prefix}/_manifest.json`,
      JSON.stringify({ exportedAt: nowIso(), tables, rows, tableList: SNAPSHOT_TABLES, chunkRows: BACKUP_CHUNK_ROWS }),
    );
  }
  return { key: prefix, tables, rows };
}

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

const ALARM_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class ExecutiveAgent {
  private readonly sql: Sql;
  private readonly store: ExecutiveStore;
  /** In-flight chat streams, so POST /api/chat/stop can really cancel them. */
  private readonly chatAborts = new Map<string, AbortController>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = createDoSql(state.storage.sql);
    this.store = new ExecutiveStore(this.sql);
    this.state.blockConcurrencyWhile(async () => {
      this.store.migrate();
      // AOrgI registry: the DO runtime registers itself as the real instance
      // behind the Chief Operating Agent role (AOrgI Â§5, Â§7 â€” instances exist
      // only when a runtime actually runs). Refreshed on every wake.
      this.store.upsertOrgAgent({
        id: "executive_do_01",
        roleId: "role_coa",
        kind: "cloud",
        model: "deepseek-v4",
        host: "cloudflare-do",
        version: SCHEMA_VERSION.toString(),
        capabilitiesJson: JSON.stringify(["planning", "task_assignment", "bottleneck_detection", "executive_reporting"]),
      });
      // The CAO is the operating seat: it owns the task board and is the agent
      // the founder talks to. Registered like the other live instances so the
      // registry shows who is actually on duty.
      this.store.upsertOrgAgent({
        id: "cao_agent_01",
        roleId: "role_cao",
        kind: "cloud",
        model: this.env.CAO_AI_MODEL ?? "@cf/deepseek-ai/deepseek-v4-pro-0813",
        host: "cloudflare-do",
        version: SCHEMA_VERSION.toString(),
        capabilitiesJson: JSON.stringify(["task_board", "task_contracts", "delegation", "founder_channel", "weekly_reporting"]),
      });
      // Fast local maintenance on wake: doctor + productivity + start/resume
      // auto-runnable jobs (executed non-blocking via state.waitUntil) +
      // schedule the next alarm.
      await this.runWakeMaintenance("wake", { runAutoJobs: false });
    });
  }

  // -- maintenance ----------------------------------------------------------

  private doctorContext() {
    return {
      store: this.store,
      env: this.env as unknown as Record<string, string | undefined>,
      kv: this.env.ZARLINO_KV,
      registry: this.buildRegistry(),
      now: () => new Date().toISOString(),
    };
  }

  /**
   * Bring every non-terminal factory build up to date with backend truth.
   * Bounded (a build is abandoned by its own deadline) and never throws: one
   * unreachable build must not stop the sweep.
   */
  private async reconcileFactoryBuilds(): Promise<{ checked: number; settled: number }> {
    let checked = 0;
    let settled = 0;
    try {
      const open = [
        ...listFactoryBuilds(this.sql, 25, { status: "QUEUED" }),
        ...listFactoryBuilds(this.sql, 25, { status: "BUILDING" }),
        ...listFactoryBuilds(this.sql, 25, { status: "TESTING" }),
        ...listFactoryBuilds(this.sql, 25, { status: "PACKAGING" }),
      ];
      for (const build of open) {
        checked += 1;
        try {
          const result = await syncFactoryBuild(this.sql, this.env, build.id, {
            bucket: this.env.ARTIFACTS ? { get: (key: string) => this.env.ARTIFACTS!.get(key) } : null,
          });
          if (isTerminalFactoryState(String(result.build.status))) settled += 1;
        } catch {
          /* one build must not stop the sweep */
        }
      }
    } catch {
      /* reconciliation must never break the cron */
    }
    return { checked, settled };
  }

  private async runWakeMaintenance(trigger: string, opts: { runAutoJobs: boolean }): Promise<void> {
    const autoFix = parseBool(this.env.DOCTOR_AUTOFIX, true);
    try {
      await runDoctor(this.doctorContext(), { autoFix, trigger });
    } catch {
      /* doctor must never break wake */
    }
    // Productivity maintenance (safe, local, no model calls): daily rollup +
    // safe optimizations (stale assignments, budget recalibration/realloc).
    try {
      dailyRollup(this.store);
      optimize(this.store, this.env as unknown as Record<string, string | undefined>);
    } catch {
      /* productivity maintenance must never break wake */
    }
    // Organizational analyst (AOrgI Â§36): self-observation on every sweep â€”
    // pure SQL computation, no model calls, cheap and safe.
    try {
      runOrgAnalyst(this.store, trigger);
    } catch {
      /* analyst must never break wake */
    }
    // CEO agent: decide what policy allows, escalate the rest to the founder
    // on WhatsApp â€” one message per cycle, never theater.
    try {
      await runCeoCycle(this.store, this.env, trigger);
    } catch {
      /* the CEO cycle must never break wake */
    }
    // Growth outreach cycle (Phase 1): runs only when the founder explicitly
    // enabled it (settings.outreach_enabled) AND an email provider is wired;
    // hard-capped per day; never blocks or breaks the sweep.
    try {
      if (this.store.getSetting("outreach_enabled") === "1") {
        await runOutreachCycle(this.store, this.env, trigger);
      }
    } catch {
      /* outreach must never break wake */
    }
    // Growth follow-ups (bounded, silent-if-not-due): one polite nudge for
    // prospects who never replied; never touches REPLIED/UNSUBSCRIBED rows.
    try {
      if (this.store.getSetting("outreach_enabled") === "1") {
        await runFollowUps(this.store, this.env);
      }
    } catch {
      /* follow-ups must never break wake */
    }
    // Start + resume long-horizon runs (bounded, "automate fixing"). Runs are
    // executed on EVERY maintenance sweep â€” on wake via state.waitUntil (keeps
    // the DO alive without blocking the request) so a run can never sit as a
    // 0-iteration orphan again, and on alarm/cron awaited in order.
    const maxJobs = Math.max(0, Math.min(3, Number(this.env.MAX_AUTO_JOBS) || 2));
    try {
      const { started } = startAutoRunnable(this.store, maxJobs);
      const { resumed } = resumeInterruptedRuns(this.store, maxJobs);
      const runs = collectRunsToExecute(this.store, started, resumed);
      if (opts.runAutoJobs) {
        for (const run of runs) await executeAgentRun(this.store, this.buildRegistry(), this.env, run);
      } else {
        for (const run of runs) this.state.waitUntil(executeAgentRun(this.store, this.buildRegistry(), this.env, run));
      }
    } catch {
      /* auto-run must never break wake */
    }
    // Execution boundary (spec §2.3): classify any legacy local rows once â€”
    // engineering work is cancelled out of the machine queue with an explicit
    // reason, everything else is tagged machine_maintenance. Idempotent, cheap.
    try {
      applyExecutionBoundarySweep(this.store);
    } catch {
      /* boundary sweep must never break wake */
    }
    // Remote execution (spec §2.5): poll GitHub for dispatched runs on
    // alarm/cron sweeps only (bounded: 3 runs, 45s min gap per run) â€” never
    // during request wakes, so console latency is unaffected.
    if (opts.runAutoJobs) {
      try {
        await syncActiveRemoteRuns(this.store, this.env as unknown as { GITHUB_TOKEN?: string }, 3);
      } catch {
        /* remote sync must never break the sweep */
      }
    }
    // Arm the alarm WITHOUT deferring an already-pending one. Frequent cold
    // starts (console polls) used to re-arm it to +5min every wake, starving
    // the alarm path â€” the very reason auto-runs piled up un-executed.
    try {
      const current = await this.state.storage.getAlarm();
      const next = Date.now() + (trigger === "wake" ? 5 * 60 * 1000 : ALARM_INTERVAL_MS);
      if (current === null || current > next) {
        await this.state.storage.setAlarm(next);
      }
    } catch {
      /* alarm reschedule is best-effort */
    }
  }

  private registryCache: ToolRegistry | null = null;
  private buildRegistry(): ToolRegistry {
    if (this.registryCache) return this.registryCache;
    this.registryCache = buildToolRegistry({
      env: this.env as unknown as Record<string, string | undefined>,
      sink: { recordExecution: (record) => this.store.recordToolExecution(record as never) },
    });
    return this.registryCache;
  }

  /** One bounded bundle of all console-facing data (cheap: every list is capped). */
  private buildDataBundle(): Record<string, unknown> {
    const s = this.store;
    return {
      generatedAt: nowIso(),
      state: s.getExecutiveState(),
      counters: {
        openTasks: s.countOpenTasks(),
        pendingApprovals: s.listApprovals({ status: "PENDING" }).length,
        openRisks: s.openRisks().length,
        products: s.listProducts().length,
        gates: s.listPipelineGates().length,
        localPending: s.listLocalTasks(100).filter((t) => t.status === "PENDING").length,
        runsRunning: s.listAgentRuns(100).filter((r) => r.status === "RUNNING").length,
        overdueReminders: s.listReminders({ overdueOnly: true }).length,
        notes: s.listNotes(1000).length,
        events: s.listCalendarEvents(undefined, undefined, 1000).length,
        assignmentsOpen: s.listAssignments({ limit: 200 }).filter((a) => a.status === "ASSIGNED" || a.status === "IN_PROGRESS").length,
        contradictionsOpen: s.countOpenContradictions(),
        pendingReviews: s.countPendingReviews(),
      },
      products: s.listProducts().map((p) => ({ id: p.id, name: p.name, category: p.category, status: p.status, version: p.version, price: p.price })),
      productStatus: s.listProducts().flatMap((p) => s.listProductStatus(p.id).slice(0, 5).map((st) => ({ product: p.name, ...st }))),
      projects: s.listProjects(),
      objectives: s.listObjectives(),
      tasks: s.listTasks({ limit: 200 }),
      decisions: s.listDecisions({ limit: 100 }),
      risks: s.openRisks(),
      engineering: s.listEngineeringIssues(),
      marketing: s.listCampaigns().slice(0, 50),
      doctrine: s.listActiveDoctrine(),
      policies: s.listPolicies(),
      memories: s.listMemories().slice(0, 50),
      pipeline: s.listPipelineGates(),
      persons: s.listPersons(),
      finance: s.latestSnapshot(),
      financialSnapshots: s.listSnapshots(6),
      calendar: s.listCalendarEvents(undefined, undefined, 200),
      notes: s.listNotes(200),
      reminders: s.listReminders({ limit: 100 }),
      contacts: s.listContacts(),
      audit: s.listAudit(40),
      files: s.listUploadedFiles(50).map((f) => ({ id: f.id, name: f.name, kind: f.kind, mime: f.mime, sizeBytes: f.size_bytes, created_at: f.created_at })),
      localTasks: s.listLocalTasks(50),
      remoteRuns: s.listRemoteRuns(30),
      runs: s.listAgentRuns(50),
      toolExecutions: s.listToolExecutions(40),
      metrics: s.listMetrics(10),
      workstreams: s.listWorkstreams(),
      budget: (() => {
        const overrides = s.getBudgetOverrides();
        const envDaily = Number(this.env.AI_DAILY_BUDGET) || 0;
        const envMonthly = Number(this.env.AI_MONTHLY_BUDGET) || 0;
        // Effective caps = override ?? env default (never show a cap the user
        // didn't actually set). The old display mixed env caps with overrides,
        // showing a different denominator than what was actually enforced.
        const daily = overrides.aiDailyBudget ?? envDaily;
        const monthly = overrides.aiMonthlyBudget ?? envMonthly;
        return {
          daily,
          monthly,
          envDaily,
          envMonthly,
          spentToday: s.spentToday(),
          spentThisMonth: s.spentThisMonth(),
          tokensToday: s.tokensToday(),
          tokensThisMonth: s.tokensThisMonth(),
          overrides,
        };
      })(),
      founderBrief: {
        overdueReminders: s.listReminders({ overdueOnly: true, limit: 8 }),
        pendingApprovals: s.listApprovals({ status: "PENDING", limit: 6 }),
        openContradictions: s.listContradictions({ status: "OPEN", limit: 6 }),
        topRisks: s.openRisks().slice(0, 6),
        pendingReviews: s.listReviewItems({ status: "PENDING", limit: 6 }),
        generatedAt: nowIso(),
      },
      reviews: s.listReviewItems({ limit: 50 }),
      perceptual: {
        tests: s.listPerceptualTests({ limit: 100 }),
        results: s.listPerceptualResults({ limit: 200 }),
        evaluators: s.listPerceptualEvaluators({ limit: 100 }),
        knowledge: s.listPerceptualKnowledge({ limit: 100 }),
        validations: s.listProductValidations().map((v) => ({ ...v, evaluation: evaluateProductGates(v) })),
        failures: s.listFailureAnalyses({ limit: 100 }),
        kpi: perceptualKpi(s),
      },
      productivity: {
        assignments: s.listAssignments({ limit: 100 }),
        optimizationEvents: s.listOptimizationEvents(20),
        contradictions: s.listContradictions({ limit: 100 }),
        budgets: budgetStatus(s),
      },
      org: {
        departments: s.listDepartments(),
        roles: s.listOrgRoles(),
        agents: s.listOrgAgents(),
        memory: s.listOrgMemory({ limit: 20 }),
        postObjectives: s.listPostObjectiveRecords(10),
        trust: s.listOrgTrust(),
        messages: s.listOrgMessages({ limit: 20 }),
        capabilities: s.listCapabilityGrants(),
        plans: s.listOrgPlans(10),
        planDeviations: s.listOrgPlanDeviations(undefined, 10),
        negotiations: s.listOrgNegotiations(10),
        arbiters: s.listOrgArbiters(),
        reasoningTraces: s.listReasoningTraces({ limit: 20 }),
        intelligence: collectiveMetrics(s),
        incidents: s.listOrgIncidents({ limit: 50 }),
        definitionOfDone: s.getDefinitionOfDone(),
        topology: s.listTopologyProposals({ limit: 20 }),
      },
      doctorLastRun: (() => {
        const d = s.latestDoctorLog();
        return d ? { runAt: d.run_at, trigger: d.trigger, summary: safeJson(d.summary_json, null) } : null;
      })(),
      localAgent: (() => {
        const st = s.getLocalAgentStatus();
        const ago = s.localAgentSeenAgoMs();
        // What the daemon is working on right now (most recently active claim).
        const current = s.listLocalTasks(50).find((t) => t.status === "CLAIMED" || t.status === "RUNNING");
        return st
          ? {
              host: st.host ?? null,
              version: st.version ?? null,
              pid: st.pid ?? null,
              lastSeen: st.last_seen ?? null,
              seenAgoMs: ago,
              online: ago !== null && ago < 5 * 60 * 1000,
              lastClaimAt: st.last_claim_at ?? null,
              pending: s.listLocalTasks(100).filter((t) => t.status === "PENDING").length,
              currentTask: current
                ? { id: current.id, status: current.status, prompt: current.prompt, updatedAt: current.updated_at }
                : null,
            }
          : {
              host: null,
              online: false,
              seenAgoMs: null,
              pending: s.listLocalTasks(100).filter((t) => t.status === "PENDING").length,
              currentTask: (() => {
                const c = s.listLocalTasks(50).find((t) => t.status === "CLAIMED" || t.status === "RUNNING");
                return c ? { id: c.id, status: c.status, prompt: c.prompt, updatedAt: c.updated_at } : null;
              })(),
            };
      })(),
      links: {
        overview: "/api/executive/overview",
        doctor: "/api/doctor/run",
        productivity: "/api/productivity/report",
      },
    };
  }

  // -- alarm ----------------------------------------------------------------

  async alarm(): Promise<void> {
    await this.runWakeMaintenance("alarm", { runAutoJobs: true });
  }

  // -- fetch routing ---------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return json({ ok: true });

    // Internal scheduled kick (from the Worker scheduled handler).
    if (internal(request, internalSecret(this.env)) && path === "/api/_scheduled") {
      await this.runWakeMaintenance("cron", { runAutoJobs: true });
      return json({ ok: true, trigger: "cron" });
    }

    // Factory build reconciliation (internal only). Called by the 15-minute
    // cron so a build reaches a terminal state even if the customer closed the
    // tab: without it, status only advanced while someone was polling.
    if (internal(request, internalSecret(this.env)) && method === "POST" && path === "/api/_factory-reconcile") {
      return json(await this.reconcileFactoryBuilds());
    }

    // Continuity ops (internal only): full database snapshot export for the
    // daily R2 backup, and targeted alert delivery via the founder channel.
    if (internal(request, internalSecret(this.env)) && method === "POST" && path === "/api/_backup-export") {
      return json({ ok: true, exportedAt: nowIso(), snapshot: this.store.exportSnapshot() });
    }
    if (internal(request, internalSecret(this.env)) && method === "POST" && path === "/api/_alert") {
      const alertBody = (await readBody<{ subject?: string; body?: string; priority?: string }>(request).catch(() => ({}))) as { subject?: string; body?: string; priority?: string };
      if (!alertBody.body || !String(alertBody.body).trim()) return json({ error: "body required" }, 400);
      const r = await escalateToFounder(this.store, this.env, { subject: alertBody.subject ?? "External monitor alert", body: String(alertBody.body), source: "monitor", priority: alertBody.priority });
      return json(r);
    }
    // Inbound growth replies (internal only): the inbound-mail email worker
    // posts every support@ message here; the OS classifies + enforces opt-outs.
    if (internal(request, internalSecret(this.env)) && method === "POST" && path === "/api/outreach/reply") {
      const reply = (await readBody<{ from?: string; subject?: string; body?: string; messageId?: string }>(request).catch(() => ({}))) as { from?: string; subject?: string; body?: string; messageId?: string };
      if (!reply.from || !String(reply.from).trim()) return json({ error: "from required" }, 400);
      const r = await recordProspectReply(this.store, this.env, {
        from: String(reply.from),
        subject: reply.subject ? String(reply.subject) : undefined,
        body: reply.body ? String(reply.body) : undefined,
        messageId: reply.messageId ? String(reply.messageId) : undefined,
      });
      // Autonomous nurturing: the growth agent drafts + sends the answer when
      // it is safe to do so; otherwise recordProspectReply already notified.
      const autoReply = await maybeAutoReply(this.store, this.env, {
        from: String(reply.from),
        subject: reply.subject ? String(reply.subject) : undefined,
        body: reply.body ? String(reply.body) : undefined,
        intent: r.intent,
        prospectId: r.prospectId,
      }).catch(() => ({ sent: false, reason: "auto-reply error" }));
      return json({ ...r, autoReply });
    }

    // Public health (no auth) â€” minimal info for uptime monitors.
    if (method === "GET" && path === "/api/health") {
      const doctor = this.store.latestDoctorLog();
      return json({
        ok: true,
        service: "zarlino-executive-os",
        time: new Date().toISOString(),
        schemaVersion: doctor ? safeJson(doctor.summary_json, null) : null,
        doctorLastRun: doctor?.run_at ?? null,
        doctorHealthy: doctor ? (safeJson(doctor.summary_json, null) as { fail?: number } | null)?.fail === 0 : null,
      });
    }

    // Plugin Factory gateway (service-to-service). Handled before the founder
    // gate because it has its own credential and its own (narrow) surface: it
    // never exposes console data and never accepts a founder token.
    if (path.startsWith("/api/factory/")) {
      const factoryResponse = await handleFactoryRoute(
        {
          sql: this.sql,
          env: this.env,
          bucket: this.env.ARTIFACTS ? { get: (key: string) => this.env.ARTIFACTS!.get(key) } : null,
          meter: this.store,
          fetchImpl: undefined,
        },
        request,
        url,
      );
      if (factoryResponse) return factoryResponse;
    }

    // Auth (login is public; logout/status/change-password need a session/token).
    if (path === "/api/auth/login" && method === "POST") return this.handleLogin(request);
    if (!authorized(request, this.env, this.store)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/logout" && method === "POST") return this.handleLogout(request);
    if (path === "/api/auth/status" && method === "GET") return json({ ok: true, authenticated: true });
    if (path === "/api/auth/bootstrap" && method === "POST") return this.handleBootstrap(request);
    if (path === "/api/auth/change-password" && method === "POST") return this.handleChangePassword(request);

    // MCP â€” the READ-ONLY inspection plane for external AI clients (JSON-RPC
    // 2.0 over POST). Authenticated like everything else; no mutating tools.
    if (path === "/mcp") {
      if (method === "GET") {
        return json({
          ok: true,
          service: "zarlino-executive-os",
          mcp: true,
          readOnly: true,
          protocol: MCP_PROTOCOL_VERSION,
          transport: "json-rpc-2.0 over POST /mcp (authenticated)",
        });
      }
      if (method === "POST") {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON." } });
        }
        const body = await handleMcpMessage(this.store, this.env as McpEnv, raw);
        if (body === null) return new Response(null, { status: 202 });
        return json(body);
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // Overview
    if (path === "/api/executive/overview" && method === "GET") {
      return json(buildOverview(this.store, this.env));
    }

    // Executive control â€” the Founder's kill-switches + autonomy dials.
    if (path === "/api/executive/control" && method === "POST") {
      const body = (await readBody<{
        paused?: boolean;
        spendingDisabled?: boolean;
        deploymentsDisabled?: boolean;
        delegateMode?: boolean;
        fullAccess?: boolean;
        autonomyMode?: string;
      }>(request).catch(() => ({}))) as {
        paused?: boolean;
        spendingDisabled?: boolean;
        deploymentsDisabled?: boolean;
        delegateMode?: boolean;
        fullAccess?: boolean;
        autonomyMode?: string;
      };
      const patch: Record<string, unknown> = {};
      const boolKeys: Array<[string, boolean | undefined]> = [
        ["paused", body.paused],
        ["spending_disabled", body.spendingDisabled],
        ["deployments_disabled", body.deploymentsDisabled],
        ["delegate_mode", body.delegateMode],
        ["full_access", body.fullAccess],
      ];
      for (const [col, val] of boolKeys) {
        if (typeof val === "boolean") patch[col] = val ? 1 : 0;
      }
      if (body.autonomyMode) {
        const mode = String(body.autonomyMode).toUpperCase();
        if (!["CONTROLLED", "DELEGATED", "FULL"].includes(mode)) return json({ error: "autonomyMode must be CONTROLLED | DELEGATED | FULL" }, 400);
        patch.autonomy_mode = mode;
        // Enabling delegation/full access implies a more permissive autonomy mode.
        if (mode === "DELEGATED" && patch.delegate_mode === undefined) patch.delegate_mode = 1;
        if (mode === "FULL" && patch.full_access === undefined) patch.full_access = 1;
      }
      if (Object.keys(patch).length === 0) return json({ error: "no control fields provided" }, 400);
      this.store.ensureExecutiveState();
      this.store.updateExecutiveState(patch);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "executive.control",
        entity_type: "executive_state",
        entity_id: "zarlino",
        detail_json: JSON.stringify(patch),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, state: this.store.getExecutiveState() });
    }

    // System Doctor
    if (path === "/api/doctor/run" && method === "POST") {
      const body = (await readBody<{ autoFix?: boolean; trigger?: string }>(request).catch(() => ({}))) as { autoFix?: boolean; trigger?: string };
      const report = await runDoctor(this.doctorContext(), {
        autoFix: body.autoFix ?? true,
        trigger: body.trigger ?? "api",
      });
      return json(report);
    }
    if (path === "/api/doctor/logs" && method === "GET") {
      return json({ logs: this.store.listDoctorLogs(20) });
    }

    // Production reset â€” hands the whole company over to a new operator on a
    // clean slate. Requires the confirmation phrase to fire; nothing is ever
    // deleted. The FULL backup is persisted to KV (one table at a time, so the
    // DO isolate never materialises the whole DB in memory) and the response
    // only carries the backup reference + counts.
    if (path === "/api/system/reset-production" && method === "POST") {
      const body = (await readBody<{ confirm?: string }>(request).catch(() => ({}))) as { confirm?: string };
      if (body.confirm !== "RESET PRODUCTION") {
        return json({ error: "Send confirm: 'RESET PRODUCTION' to proceed. Nothing was changed." }, 400);
      }
      const backupRef = await persistBackupToKv(this.env.ZARLINO_KV, this.store);
      const result = this.store.resetProductionProgress();
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "system.reset_production",
        entity_type: "system",
        entity_id: "production",
        detail_json: JSON.stringify({
          backupRef: backupRef.key,
          archivedTasks: result.archivedTasks,
          resetGates: result.resetGates,
          resetProducts: result.resetProducts,
          cancelledLocal: result.cancelledLocal,
          clearedReviews: result.clearedReviews,
        }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({
        ok: true,
        backupRef: backupRef.key,
        backupTables: backupRef.tables,
        backupRows: backupRef.rows,
        archivedTasks: result.archivedTasks,
        resetGates: result.resetGates,
        resetProducts: result.resetProducts,
        cancelledLocal: result.cancelledLocal,
        clearedReviews: result.clearedReviews,
        note: "Production progress reset to a clean slate. Full pre-reset backup persisted to KV under backupRef; nothing was deleted.",
      });
    }

    // Maintenance
    if (path === "/api/maintenance/run" && method === "POST") {
      const maintenance = this.store.runMaintenance();
      const pruned = this.store.pruneCompletedChatStreams(24 * 60 * 60 * 1000);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "maintenance.run",
        entity_type: "system",
        entity_id: "maintenance",
        detail_json: JSON.stringify({ ...maintenance, prunedStreams: pruned }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, ...maintenance, prunedStreams: pruned });
    }

    // Auto-run
    if (path === "/api/autotasks/run" && method === "POST") {      const { started } = startAutoRunnable(this.store, 2);
      for (const taskId of started) {
        const run = this.store.listAgentRuns(50).find((r) => r.task_id === taskId && r.status === "RUNNING");
        if (run) await executeAgentRun(this.store, this.buildRegistry(), this.env, run);
      }
      return json({ ok: true, started: started.length });
    }

    // Chat
    if (path === "/api/chat" && method === "POST") return this.handleChat(request);
    if (path === "/api/chat/sessions" && method === "GET") {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 40));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const page = this.store.listChatSessions(limit + 1, offset);
      return json({ sessions: page.slice(0, limit), hasMore: page.length > limit, total: this.store.countChatSessions() });
    }
    if (path === "/api/chat/messages" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "default";
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit")) || 80));
      const before = url.searchParams.get("before") ?? undefined;
      const page = this.store.listChatMessagesPage(sessionId, { limit, before });
      const title = this.store.getChatSessionTitle(sessionId);
      return json({ ...page, title: title?.title ?? null });
    }
    if (path === "/api/chat/stream" && method === "GET") {
      const id = url.searchParams.get("streamId") ?? url.searchParams.get("id") ?? "";
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      return json(this.store.readChatStream(id, after));
    }
    if (path === "/api/chat/clear" && method === "POST") {
      const body = (await readBody<{ sessionId?: string }>(request).catch(() => ({}))) as { sessionId?: string };
      this.store.clearChat(body.sessionId ?? "default");
      return json({ ok: true });
    }
    // Session deletion (housekeeping): a stale test/debug session must not linger
    // and pollute the context an agent or the founder sees. The `default`
    // session cannot be deleted here â€” clear it instead.
    if (path === "/api/chat/delete" && method === "POST") {
      const body = (await readBody<{ sessionId?: string; sessionIds?: string[] }>(request).catch(() => ({}))) as { sessionId?: string; sessionIds?: string[] };
      const ids = (body.sessionIds?.length ? body.sessionIds : body.sessionId ? [body.sessionId] : []).filter((s) => Boolean(s) && s !== "default");
      if (ids.length === 0) {
        return json({ error: "sessionId or sessionIds required (the 'default' session cannot be deleted â€” clear it instead)" }, 400);
      }
      for (const id of ids) this.store.deleteChatSession(id);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "chat.session_deleted",
        entity_type: "chat_session",
        entity_id: ids.join(","),
        detail_json: JSON.stringify({ deleted: ids.length }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, deleted: ids.length, sessionIds: ids });
    }
    // Chat enhancements (audit gaps 4, 5, 6, 12, 16, 26)
    if (path === "/api/chat/stop" && method === "POST") {
      const body = (await readBody<{ streamId?: string }>(request).catch(() => ({}))) as { streamId?: string };
      const ctrl = body.streamId ? this.chatAborts.get(body.streamId) : undefined;
      if (ctrl) ctrl.abort();
      return json({ ok: true, stopped: Boolean(ctrl) });
    }
    // Context hygiene (repeatable): prune stale chat sessions so agents and the
    // founder stop seeing resolved-incident debris. Dry-run unless dryRun:false.
    // `default` is never touched; the store helper guarantees that too.
    if (path === "/api/chat/prune" && method === "POST") {
      const body = (await readBody<{ olderThanDays?: number; onlyUntitled?: boolean; dryRun?: boolean; sessionIds?: string[] }>(request).catch(() => ({}))) as {
        olderThanDays?: number;
        onlyUntitled?: boolean;
        dryRun?: boolean;
        sessionIds?: string[];
      };
      const days = Math.max(1, Math.min(365, Number(body.olderThanDays) || 14));
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const dryRun = body.dryRun !== false;
      let candidates = this.store.listChatSessionsToPrune(cutoff, body.onlyUntitled !== false);
      if (body.sessionIds?.length) {
        candidates = [...new Set([...candidates, ...body.sessionIds.filter((s) => Boolean(s) && s !== "default")])];
      }
      if (!dryRun) for (const id of candidates) this.store.deleteChatSession(id);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: dryRun ? "chat.prune_preview" : "chat.sessions_pruned",
        entity_type: "chat_session",
        entity_id: candidates.slice(0, 40).join(","),
        detail_json: JSON.stringify({ olderThanDays: days, onlyUntitled: body.onlyUntitled !== false, deleted: dryRun ? 0 : candidates.length }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({
        dryRun,
        olderThanDays: days,
        cutoff,
        deleted: dryRun ? 0 : candidates.length,
        candidates,
        sessionsRemaining: this.store.countChatSessions(),
      });
    }
    if (path === "/api/chat/rate" && method === "POST") {
      const body = (await readBody<{ messageId?: string; rating?: number }>(request).catch(() => ({}))) as { messageId?: string; rating?: number };
      if (!body.messageId) return json({ error: "messageId required" }, 400);
      const rating = body.rating === 1 ? 1 : body.rating === -1 ? -1 : 0;
      this.store.rateChatMessage(body.messageId, rating);
      return json({ ok: true, rating });
    }
    if (path === "/api/chat/rename" && method === "POST") {
      const body = (await readBody<{ sessionId?: string; title?: string }>(request).catch(() => ({}))) as { sessionId?: string; title?: string };
      const sessionId = body.sessionId ?? "default";
      const title = (body.title ?? "").trim().slice(0, 80);
      if (!title) return json({ error: "title required" }, 400);
      this.store.setChatSessionTitle(sessionId, title, "founder");
      return json({ ok: true, title });
    }
    if (path === "/api/chat/truncate" && method === "POST") {
      const body = (await readBody<{ sessionId?: string; messageId?: string }>(request).catch(() => ({}))) as { sessionId?: string; messageId?: string };
      if (!body.messageId) return json({ error: "messageId required" }, 400);
      const removed = this.store.truncateChatFrom(body.sessionId ?? "default", body.messageId);
      return json({ ok: true, removed });
    }
    if (path === "/api/chat/regenerate" && method === "POST") {
      const body = (await readBody<{ sessionId?: string; model?: string; stream?: boolean }>(request).catch(() => ({}))) as { sessionId?: string; model?: string; stream?: boolean };
      const sessionId = body.sessionId ?? "default";
      const last = this.store.lastAssistantMessage(sessionId);
      if (last) this.store.truncateChatFrom(sessionId, last.id);
      return this.runChatReply(sessionId, normalizeChatModel(body.model), body.stream === true);
    }

    // Files
    if (path === "/api/files" && method === "POST") return this.handleFileUpload(request);
    if (path === "/api/files" && method === "GET") {
      return json({ files: this.store.listUploadedFiles(50).map((f) => ({ fileId: f.id, name: f.name, kind: f.kind, mime: f.mime, sizeBytes: f.size_bytes, created_at: f.created_at })) });
    }
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]!);
      if (method === "GET") {
        const f = this.store.getUploadedFile(id);
        return f ? json(f) : json({ error: "Not found" }, 404);
      }
      if (method === "DELETE") {
        return json({ deleted: this.store.deleteUploadedFile(id) });
      }
    }

    // Artifacts (R2): large durable outputs â€” renders, build packages, shots
    // and reports live outside the DO (mandate Â§25). Keys are generated by the
    // server; reads accept only validated `artifacts/` keys.
    if (path === "/api/artifacts" && method === "POST") {
      if (!this.env.ARTIFACTS) return json({ error: "Artifact storage not configured (R2 binding ARTIFACTS missing)" }, 503);
      const body = (await readBody<{ name?: string; kind?: string; mime?: string; data_base64?: string }>(request).catch(() => ({}))) as { name?: string; kind?: string; mime?: string; data_base64?: string };
      if (!body.name || typeof body.name !== "string") return json({ error: "name required" }, 400);
      if (!body.data_base64 || typeof body.data_base64 !== "string") return json({ error: "data_base64 required" }, 400);
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(body.data_base64);
      } catch {
        return json({ error: "data_base64 is not valid base64" }, 400);
      }
      if (bytes.byteLength === 0) return json({ error: "artifact is empty" }, 400);
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) return json({ error: `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes` }, 413);
      const key = artifactKey(body.name, body.kind ?? "misc");
      await this.env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: body.mime ?? "application/octet-stream" } });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "artifact.upload",
        entity_type: "artifacts",
        entity_id: key,
        detail_json: JSON.stringify({ sizeBytes: bytes.byteLength, mime: body.mime ?? null }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, key, sizeBytes: bytes.byteLength }, 201);
    }
    if (path === "/api/artifacts" && method === "GET") {
      if (!this.env.ARTIFACTS) return json({ error: "Artifact storage not configured (R2 binding ARTIFACTS missing)" }, 503);
      const prefix = url.searchParams.get("prefix") ?? "artifacts/";
      const listed = await this.env.ARTIFACTS.list({ prefix, limit: 200 });
      return json({
        artifacts: listed.objects.map((o) => ({
          key: o.key,
          sizeBytes: o.size,
          uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded),
        })),
      });
    }
    const artifactMatch = /^\/api\/artifacts\/(.+)$/.exec(path);
    if (artifactMatch && (method === "GET" || method === "DELETE")) {
      if (!this.env.ARTIFACTS) return json({ error: "Artifact storage not configured (R2 binding ARTIFACTS missing)" }, 503);
      const key = normalizeArtifactPath(decodeURIComponent(artifactMatch[1]!));
      if (!key) return json({ error: "Invalid artifact key" }, 400);
      if (method === "DELETE") {
        await this.env.ARTIFACTS.delete(key);
        this.store.insertAudit({
          id: newId("aud"),
          actor: "founder",
          action: "artifact.delete",
          entity_type: "artifacts",
          entity_id: key,
          detail_json: "{}",
          source: "api",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        return json({ ok: true, key });
      }
      const obj = await this.env.ARTIFACTS.get(key);
      if (!obj) return json({ error: "Artifact not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
          "Content-Length": String(obj.size),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    // Tasks
    if (path === "/api/tasks" && method === "GET") {
      const counts = this.store.countTaskEvidence();
      return json({
        tasks: this.store.listTasks({ limit: 100 }).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          project_id: t.project_id,
          close_reason: t.close_reason ?? null,
          evidence: counts[t.id] ?? { total: 0, verified: 0 },
          created_at: t.created_at,
        })),
      });
    }
    if (path === "/api/tasks" && method === "POST") {
      const body = (await readBody<{
        title?: string;
        description?: string;
        priority?: string;
        objective_id?: string;
        acceptance_criteria?: string;
        role_id?: string;
        dependency_task_id?: string;
      }>(request).catch(() => ({}))) as {
        title?: string;
        description?: string;
        priority?: string;
        objective_id?: string;
        acceptance_criteria?: string;
        role_id?: string;
        dependency_task_id?: string;
      };
      if (!body.title || !body.title.trim()) return json({ error: "title required" }, 400);
      const dup = findDuplicateTask(this.store, body.title);
      if (dup) return json({ ok: false, duplicate: true, existingId: dup.id, existingStatus: dup.status, note: duplicateNote(dup) }, 409);
      // Objective linkage is what makes coordinated work a connected objective
      // rather than a pile of unrelated tickets (spec §2.4).
      if (body.objective_id && !this.store.getObjective(body.objective_id)) {
        return json({ error: "objective not found" }, 404);
      }
      const task = createTask({
        title: body.title,
        description: body.description,
        priority: body.priority as never,
        objective_id: body.objective_id,
        source: "founder",
      });
      this.store.insertTask(task);
      if (body.acceptance_criteria?.trim()) {
        this.store.setTaskContract(task.id, { acceptance_criteria: body.acceptance_criteria.trim() });
      }
      if (body.dependency_task_id) {
        this.store.updateTask(task.id, { dependency_task_id: body.dependency_task_id } as never);
      }
      let assignment: string | null = null;
      if (body.role_id) {
        try {
          assignment = assignTask(this.store, task.id, {
            roleId: body.role_id,
            note: "CEO objective assignment",
          });
        } catch {
          assignment = null;
        }
      }
      return json({ ok: true, id: task.id, assignment, objective_id: body.objective_id ?? null });
    }
    const taskPatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskPatch && method === "GET") {
      const id = decodeURIComponent(taskPatch[1]!);
      const withEvidence = this.store.getTaskWithEvidence(id);
      if (!withEvidence) return json({ error: "Task not found" }, 404);
      return json({ task: withEvidence });
    }
    if (taskPatch && method === "PATCH") {
      const id = decodeURIComponent(taskPatch[1]!);
      const task = this.store.getTask(id);
      if (!task) return json({ error: "Task not found" }, 404);
      const body = (await readBody<{ status?: string; priority?: string; mode?: string; overrideReason?: string }>(request).catch(() => ({}))) as { status?: string; priority?: string; mode?: string; overrideReason?: string };
      const patch: Partial<Task> = {};
      if (body.status) {
        if (!["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"].includes(body.status)) return json({ error: "Invalid status" }, 400);
        if (isTerminalTaskStatus(body.status)) {
          // Closed-loop governance: a task cannot reach DONE / CANCELLED on a
          // bare status write. Throws GovernanceError(409, EVIDENCE_REQUIRED)
          // when the task carries no verifiable evidence.
          this.store.setTaskStatus(id, body.status, {
            mode: body.mode === "founder_override" ? "founder_override" : undefined,
            overrideReason: body.overrideReason,
          });
        } else {
          patch.status = body.status as never;
        }
      }
      if (body.priority && ["P0", "P1", "P2", "P3"].includes(body.priority)) patch.priority = body.priority as never;
      if (Object.keys(patch).length > 0) this.store.updateTask(id, patch);
      const after = this.store.getTask(id);
      return json({
        ok: true,
        id,
        status: after?.status,
        close_reason: after?.close_reason ?? null,
        evidence: this.store.listTaskEvidence(id).map((e) => ({ id: e.id, kind: e.kind, locator: e.locator, verified: e.verified })),
      });
    }
    // Task evidence: the only thing that makes a task closable.
    const taskEvidenceRoute = /^\/api\/tasks\/([^/]+)\/evidence$/.exec(path);
    if (taskEvidenceRoute && method === "GET") {
      const id = decodeURIComponent(taskEvidenceRoute[1]!);
      if (!this.store.getTask(id)) return json({ error: "Task not found" }, 404);
      return json({ taskId: id, evidence: this.store.listTaskEvidence(id) });
    }
    if (taskEvidenceRoute && method === "POST") {
      const id = decodeURIComponent(taskEvidenceRoute[1]!);
      const body = ((await readBody<Record<string, unknown>>(request).catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const item = this.store.addTaskEvidence(id, {
        kind: body.kind,
        locator: body.locator,
        summary: body.summary,
        verification_command: body.verification_command ?? body.verificationCommand,
        verification_output: body.verification_output ?? body.verificationOutput,
        verified: body.verified,
        source: "founder",
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "task.evidence.attach",
        entity_type: "task_evidence",
        entity_id: item.id,
        detail_json: JSON.stringify({ task_id: id, kind: item.kind, locator: item.locator }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, evidence: item });
    }
    const taskEvidenceDelete = /^\/api\/tasks\/evidence\/([^/]+)$/.exec(path);
    if (taskEvidenceDelete && method === "DELETE") {
      const evId = decodeURIComponent(taskEvidenceDelete[1]!);
      return json({ ok: true, deleted: this.store.deleteTaskEvidence(evId) });
    }


    // Approvals
    if (path === "/api/approvals" && method === "GET") {
      return json({ approvals: this.store.listApprovals({ limit: 50 }) });
    }
    if (path === "/api/approvals/decide" && method === "POST") {
      const body = (await readBody<{ id?: string; decision?: string; note?: string }>(request).catch(() => ({}))) as { id?: string; decision?: string; note?: string };
      const approval = this.store.getApproval(body.id ?? "");
      if (!approval) return json({ error: "Approval not found" }, 404);
      const decision = (body.decision ?? "").toUpperCase();
      if (decision !== "APPROVED" && decision !== "REJECTED" && decision !== "CANCELLED") {
        return json({ error: "decision must be APPROVED | REJECTED | CANCELLED" }, 400);
      }
      this.store.updateApproval(approval.id, {
        status: decision,
        decided_by: "founder",
        decision_note: body.note,
        decided_at: nowIso(),
      } as never);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: `approval.${decision.toLowerCase()}`,
        entity_type: "approval_requests",
        entity_id: approval.id,
        detail_json: JSON.stringify({ action_label: approval.action_label }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, id: approval.id, status: decision });
    }

    // CEO agent + founder notifications (WhatsApp)
    if (path === "/api/ceo/run" && method === "POST") {
      const result = await runCeoCycle(this.store, this.env, "manual");
      return json(result);
    }
    if (path === "/api/ceo/reports" && method === "GET") {
      return json({ reports: this.store.listCeoReports(20) });
    }
    if (path === "/api/notifications" && method === "GET") {
      return json({ notifications: this.store.listNotifications(50) });
    }
    if (path === "/api/notify/founder" && method === "POST") {
      const body = (await readBody<{ subject?: string; body?: string; priority?: string }>(request).catch(() => ({}))) as { subject?: string; body?: string; priority?: string };
      if (!body.body || !String(body.body).trim()) return json({ error: "body required" }, 400);
      const r = await escalateToFounder(this.store, this.env, { subject: body.subject ?? "Message from the OS", body: String(body.body), source: "api", priority: body.priority });
      return json(r);
    }
    if (path === "/api/notify/test" && method === "POST") {
      const r = await sendWhatsApp(this.env, "Zarlino OS test \u2014 the founder channel works.");
      return json(r);
    }

    // WhatsApp linked-device bridge (tools/whatsapp-bridge). The bridge asks
    // who a message is from (founder vs stranger), sends the reply itself,
    // and drains the founder escalation queue. Behind the normal auth gate.
    if (path === "/api/whatsapp/inbound" && method === "POST") {
      const body = (await readBody<{ from?: string; name?: string; text?: string; messageId?: string }>(request).catch(() => ({}))) as { from?: string; name?: string; text?: string; messageId?: string };
      if (!body.from || !body.text) return json({ error: "from and text required" }, 400);
      const r = await handleInboundWhatsApp(this.store, this.env, {
        from: String(body.from),
        name: body.name ? String(body.name) : undefined,
        text: String(body.text),
        messageId: body.messageId ? String(body.messageId) : undefined,
      });
      return json(r);
    }
    if (path === "/api/whatsapp/outbox" && method === "GET") {
      const founderNumber = this.env.WHATSAPP_FOUNDER_NUMBER ?? "+233546778438";
      const queued = this.store.listQueuedNotifications(50);
      if (!queued.length) return json({ founderNumber, messages: [] });

      // Quiet gap: at most one founder message per WHATSAPP_MIN_GAP_MINUTES
      // (default 240) unless nothing was ever sent. No spam, ever.
      const held = cooldown(this.store, this.env);
      if (held.held) {
        return json({
          founderNumber,
          messages: [],
          holdUntil: held.holdUntil,
          queued: queued.length,
        });
      }

      // Coalesce EVERYTHING queued into ONE message; duplicate items merge.
      const digest = await composeFounderDigest(this.store, this.env, queued);

      // Remember WHICH approvals this digest referenced, so a bare "approve"
      // reply from the founder can actually decide them (48h window).
      const approvalIds: string[] = [];
      for (const row of queued) {
        const re = /\(approval (appr_[A-Za-z0-9_]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(row.body ?? "")) !== null) approvalIds.push(m[1]!);
      }
      const uniqueApprovals = Array.from(new Set(approvalIds));
      if (uniqueApprovals.length) {
        try {
          this.store.setSetting(
            DIGEST_APPROVALS_SETTING,
            JSON.stringify({ ids: uniqueApprovals, at: nowIso() }),
          );
        } catch {
          /* never blocks a delivery */
        }
      }
      return json({
        founderNumber,
        messages: [
          {
            ids: digest.ids,
            to: queued[0]?.recipient ?? null,
            text: digest.text,
            itemCount: digest.items.length,
            composedBy: digest.model ?? "template",
          },
        ],
      });
    }
    const waAck = /^\/api\/whatsapp\/outbox\/([^/]+)\/ack$/.exec(path);
    if (waAck && method === "POST") {
      const rawId = decodeURIComponent(waAck[1]!);
      const body = (await readBody<{ status?: string; error?: string; ids?: string[] }>(request).catch(() => ({}))) as { status?: string; error?: string; ids?: string[] };
      const status = body.status === "SENT" ? "SENT" : "FAILED";
      const ids =
        Array.isArray(body.ids) && body.ids.length
          ? body.ids.filter((x) => typeof x === "string").slice(0, 50)
          : [rawId];
      for (const id of ids) {
        this.store.updateNotification(id, {
          status,
          error: status === "SENT" ? null : (body.error ?? "bridge send failed"),
          provider: "bridge",
        });
      }
      if (status === "SENT") markFounderMessageSent(this.store);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "whatsapp_bridge",
        action: status === "SENT" ? "whatsapp.delivered" : "whatsapp.delivery_failed",
        entity_type: "notifications",
        entity_id: ids[0] ?? rawId,
        detail_json: JSON.stringify({ ids: ids.length, error: body.error ?? null }),
        source: "runtime",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, ids, status });
    }
    if (path === "/api/whatsapp/messages" && method === "GET") {
      return json({ messages: this.store.listWhatsAppMessages(50) });
    }
    // Bridge liveness: whichever machine hosts the founder channel reports in
    // here (the doctor's whatsapp.bridge check reads it back). This makes
    // "the bridge died with the old machine" visible in the cloud instead of
    // silently queueing messages.
    if (path === "/api/whatsapp/bridge/heartbeat" && method === "POST") {
      const body = (await readBody<{ host?: string; linkedAs?: string }>(request).catch(() => ({}))) as { host?: string; linkedAs?: string };
      const at = nowIso();
      const seenPayload = JSON.stringify({
        at,
        host: body.host ? String(body.host).slice(0, 80) : null,
        linkedAs: body.linkedAs ? String(body.linkedAs).slice(0, 80) : null,
      });
      this.store.setSetting("whatsapp_bridge_last_seen", seenPayload);
      // KV mirror so the worker-side monitor can read bridge liveness WITHOUT
      // waking the DO every 15 minutes (best-effort; the setting stays canonical).
      try {
        await this.env.ZARLINO_KV?.put("bridge:last_seen", seenPayload);
      } catch {
        /* mirror is best-effort */
      }
      return json({ ok: true, at });
    }
    if (path === "/api/whatsapp/bridge" && method === "GET") {
      const raw = this.store.getSetting("whatsapp_bridge_last_seen");
      type BridgeSeen = { at?: string; host?: string | null; linkedAs?: string | null };
      let seen: BridgeSeen | null = null;
      if (raw) {
        try {
          seen = JSON.parse(raw) as BridgeSeen;
        } catch {
          seen = null;
        }
      }
      const ageMs = seen?.at ? Date.now() - Date.parse(seen.at) : null;
      return json({
        bridge: seen
          ? { ...seen, ageMs, fresh: ageMs !== null && ageMs <= 5 * 60 * 1000 }
          : null,
        queued: this.store.listQueuedNotifications(50).length,
      });
    }
    if (path === "/api/ai/exec-probe" && method === "GET") {
      const probe = await executiveGenerate(this.env, this.store, [
        { role: "system", content: "Reply with exactly one word: ALIVE" },
        { role: "user", content: "ping" },
      ], { maxTokens: 16 });
      // Debug aid: surface the RAW Workers AI error when the tier fails.
      let rawError: string | null = null;
      if (!probe && this.env.AI) {
        try {
          await (this.env.AI as { run: (m: string, i: unknown) => Promise<unknown> }).run(
            this.env.EXEC_AI_MODEL || DEFAULT_EXEC_MODEL,
            { messages: [{ role: "user", content: "ping" }], max_tokens: 8 },
          );
        } catch (err) {
          rawError = err instanceof Error ? err.message : String(err);
        }
      }
      return json({ bound: !!this.env.AI, result: probe, rawError, neuronsToday: neuronsUsedToday(this.store), dailyBudget: neuronBudget(this.env), ledger: neuronLedger(this.store, this.env) });
    }

    // Founder channel health: who answered last, why the CAO tier is down (if
    // it is), and how much allowance the channel has left. This is how "are you
    // talking to the smart model?" becomes a fact instead of a hope.
    if (path === "/api/ai/voice-status" && method === "GET") {
      const status = voiceStatus(this.store, this.env);
      return json({
        ...status,
        caoModel: this.env.CAO_AI_MODEL ?? "@cf/deepseek-ai/deepseek-v4-pro-0813",
        execModel: this.env.EXEC_AI_MODEL ?? DEFAULT_EXEC_MODEL,
      });
    }

    // One-shot probe of the CAO model: proves reachability now (paid plan vs
    // free), and charges the ledger when it does answer.
    //
    // V4 Pro is a REASONING model (default effort: high), so a small token
    // budget is spent entirely on reasoning and the answer comes back empty.
    // The probe therefore tries the parameter shapes we might ship and reports
    // which one actually produces words - measured, not assumed.
    if (path === "/api/ai/cao-probe" && method === "GET") {
      const model = this.env.CAO_AI_MODEL ?? "@cf/deepseek-ai/deepseek-v4-pro-0813";
      if (!this.env.AI) return json({ model, ok: false, error: "AI binding missing" });
      const ai = this.env.AI as { run: (m: string, i: unknown) => Promise<unknown> };
      const extract = (out: unknown): string => {
        const o = out as {
          response?: string;
          choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
          result?: { response?: string };
        };
        const text = o?.choices?.[0]?.message?.content ?? o?.response ?? o?.result?.response;
        return typeof text === "string" ? text.trim() : "";
      };
      const attempt = async (label: string, input: Record<string, unknown>) => {
        const started = Date.now();
        try {
          const out = await ai.run(model, input);
          const text = extract(out);
          return {
            variant: label,
            ok: text.length > 0,
            ms: Date.now() - started,
            text: text.slice(0, 120),
            shape: Object.keys((out ?? {}) as Record<string, unknown>).slice(0, 8),
          };
        } catch (err) {
          return {
            variant: label,
            ok: false,
            ms: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };
      const ask = "Reply with exactly one word: ALIVE";
      const messages = [{ role: "user", content: ask }];
      const variants = [
        await attempt("none/32", { messages, reasoning_effort: "none", max_completion_tokens: 32 }),
        await attempt("low/200", { messages, reasoning_effort: "low", max_completion_tokens: 200 }),
        await attempt("default/400", { messages, max_completion_tokens: 400 }),
      ];
      const winner = variants.find((v) => v.ok) ?? null;
      // Charge the ledger for the tokens the winning shape actually used.
      if (winner) {
        const outTok = Math.ceil((winner.text?.length ?? 0) / 4);
        chargeNeurons(this.store, model, Math.ceil((ask.length + 16) / 4), Math.max(outTok, 1));
      }
      return json({ model, ok: !!winner, winner, variants, ledger: neuronLedger(this.store, this.env) });
    }

    // Review queue â€” remote operator vetting of produced work (sound / UI / artifacts)
    if (path === "/api/reviews" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({ reviews: this.store.listReviewItems({ status: status as never, limit: 100 }) });
    }
    if (path === "/api/reviews" && method === "POST") {
      const body = (await readBody<{ kind?: string; title?: string; description?: string; payload?: Record<string, unknown> }>(request).catch(() => ({}))) as { kind?: string; title?: string; description?: string; payload?: Record<string, unknown> };
      const kind = String(body.kind ?? "").toLowerCase();
      if (!["sound", "ui", "document", "build"].includes(kind)) return json({ error: "kind must be sound | ui | document | build" }, 400);
      if (!body.title?.trim()) return json({ error: "title required" }, 400);
      const now = nowIso();
      const id = newId("rev");
      this.store.createReviewItem({
        id,
        kind,
        title: body.title.trim(),
        description: body.description ?? "",
        status: "PENDING",
        payload_json: JSON.stringify(body.payload ?? {}),
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "review.request",
        entity_type: "review_items",
        entity_id: id,
        detail_json: JSON.stringify({ kind, title: body.title.trim() }),
        source: "api",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, id });
    }
    const reviewDecide = /^\/api\/reviews\/([^/]+)\/decide$/.exec(path);
    if (reviewDecide && method === "POST") {
      const id = decodeURIComponent(reviewDecide[1]!);
      const body = (await readBody<{ status?: string; note?: string }>(request).catch(() => ({}))) as { status?: string; note?: string };
      const item = this.store.getReviewItem(id);
      if (!item) return json({ error: "Review not found" }, 404);
      const status = String(body.status ?? "").toUpperCase();
      if (!["APPROVED", "REJECTED", "NEEDS_WORK"].includes(status)) return json({ error: "status must be APPROVED | REJECTED | NEEDS_WORK" }, 400);
      this.store.decideReviewItem(id, status as never, body.note ?? "", "founder");
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: `review.${status.toLowerCase()}`,
        entity_type: "review_items",
        entity_id: id,
        detail_json: JSON.stringify({ kind: item.kind, title: item.title, note: body.note ?? "" }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, id, status });
    }

    // -- AOrgI org registry (migration v23) -----------------------------------
    if (path === "/api/org/departments" && method === "GET") {
      return json({ departments: this.store.listDepartments() });
    }
    if (path === "/api/org/roles" && method === "GET") {
      const departmentId = url.searchParams.get("department_id") ?? undefined;
      return json({ roles: this.store.listOrgRoles({ departmentId }) });
    }
    if (path === "/api/org/agents" && method === "GET") {
      return json({ agents: this.store.listOrgAgents() });
    }
    if (path === "/api/org/agents" && method === "POST") {
      // Register an agent instance explicitly. Runtime heartbeats register
      // themselves; this route exists for chaos probes and future instances
      // that cannot heartbeat (e.g., one-shot workers).
      const body = (await readBody<{ id?: string; role_id?: string; kind?: string; model?: string; source?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.id || typeof body.id !== "string") return json({ error: "id required" }, 400);
      if (!body.role_id || typeof body.role_id !== "string") return json({ error: "role_id required" }, 400);
      if (!this.store.getOrgRole(body.role_id)) return json({ error: "Unknown role_id" }, 400);
      this.store.upsertOrgAgent({
        id: body.id,
        roleId: body.role_id,
        kind: body.kind as string | undefined,
        model: body.model as string | undefined,
        source: body.source as string | undefined,
      });
      return json({ ok: true, agent: this.store.getOrgAgent(body.id) });
    }
    const agentDeregister = /^\/api\/org\/agents\/([^/]+)$/.exec(path);
    if (agentDeregister && method === "DELETE") {
      // Deregister a dead instance (the Doctor's stale-agent action, Â§31).
      const id = decodeURIComponent(agentDeregister[1]!);
      const agent = this.store.getOrgAgent(id);
      if (!agent) return json({ error: "Agent not found" }, 404);
      this.store.deleteOrgAgent(id);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "org.agent.deregister",
        entity_type: "org_agents",
        entity_id: id,
        detail_json: JSON.stringify({ role_id: agent.role_id }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, id });
    }
    if (path === "/api/org/task-contracts" && method === "GET") {
      return json({ contracts: this.store.listTaskContracts({ limit: 100 }) });
    }
    const contractPatch = /^\/api\/org\/task-contracts\/([^/]+)$/.exec(path);
    if (contractPatch && method === "POST") {
      const id = decodeURIComponent(contractPatch[1]!);
      const body = (await readBody<{
        acceptance_criteria?: string;
        verification_role_id?: string | null;
        autonomy_level?: string;
        deadline_at?: string | null;
        escalation_path?: string | null;
      }>(request).catch(() => ({}))) as Record<string, unknown>;
      const updated = this.store.setTaskContract(id, {
        acceptance_criteria: body.acceptance_criteria as string | undefined,
        verification_role_id: (body.verification_role_id as string | null) ?? undefined,
        autonomy_level: body.autonomy_level as string | undefined,
        deadline_at: (body.deadline_at as string | null) ?? undefined,
        escalation_path: (body.escalation_path as string | null) ?? undefined,
      });
      if (!updated) return json({ error: "Task not found" }, 404);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "org.task_contract.update",
        entity_type: "tasks",
        entity_id: id,
        detail_json: JSON.stringify({ fields: Object.keys(body) }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, task: updated });
    }

    // -- AOrgI Phase 2: org memory / post-objective / trust / messages ---------
    if (path === "/api/org/memory" && method === "GET") {
      const includeSuperseded = url.searchParams.get("include_superseded") === "1";
      return json({ memory: this.store.listOrgMemory({ includeSuperseded, limit: 100 }) });
    }
    if (path === "/api/org/memory" && method === "POST") {
      const body = (await readBody<{ key?: string; value?: unknown; author?: string; task_id?: string; supersedes?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.key || typeof body.key !== "string" || !body.key.trim()) return json({ error: "key required" }, 400);
      if (body.value === undefined) return json({ error: "value required" }, 400);
      const entry = this.store.writeOrgMemory({
        key: body.key.trim(),
        value: body.value,
        author: body.author as string | undefined,
        taskId: body.task_id as string | undefined,
        supersedes: body.supersedes as string | undefined,
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "org.memory.write",
        entity_type: "org_memory",
        entity_id: entry.id,
        detail_json: JSON.stringify({ key: entry.key, supersedes: entry.supersedes ?? null }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, entry });
    }
    const memoryPatch = /^\/api\/org\/memory\/([^/]+)$/.exec(path);
    if (memoryPatch && method === "POST") {
      const id = decodeURIComponent(memoryPatch[1]!);
      const body = (await readBody<{ value?: unknown; expected_version?: number; author?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (body.value === undefined) return json({ error: "value required" }, 400);
      if (typeof body.expected_version !== "number") return json({ error: "expected_version (number) required â€” READ the entry, then WRITE with its version (Â§14)" }, 400);
      const result = this.store.updateOrgMemory(id, {
        value: body.value,
        expectedVersion: body.expected_version,
        author: body.author as string | undefined,
      });
      if (result.status === "not_found") return json({ error: "Memory entry not found" }, 404);
      if (result.status === "conflict") {
        return json({ error: "ORG_MEMORY_CONFLICT", message: "Version mismatch â€” someone else wrote first. Re-read, merge, retry (Â§14: never silently overwrite).", current: result.record }, 409);
      }
      return json({ ok: true, entry: result.record });
    }
    if (path === "/api/org/post-objectives" && method === "GET") {
      return json({ records: this.store.listPostObjectiveRecords(50) });
    }
    if (path === "/api/org/post-objectives" && method === "POST") {
      const body = (await readBody<{
        objective_id?: string;
        outcome?: string;
        expected_outcome?: string;
        actual_outcome?: string;
        successful_roles?: unknown[];
        failed_roles?: unknown[];
        bottlenecks?: unknown[];
        incidents?: unknown[];
        useful_workflows?: unknown[];
        unnecessary_work?: unknown[];
        decisions?: unknown[];
        deviations?: unknown[];
        trust_updates?: unknown[];
        lessons?: unknown[];
        topology_changes?: unknown[];
        policy_changes?: unknown[];
      }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.objective_id || typeof body.objective_id !== "string") return json({ error: "objective_id required" }, 400);
      const objective = this.store.listObjectives().find((o) => o.id === body.objective_id);
      if (!objective) return json({ error: "Objective not found" }, 404);
      const now = nowIso();
      const id = newId("por");
      const jsonArr = (v: unknown) => JSON.stringify(Array.isArray(v) ? v : []);
      this.store.createPostObjectiveRecord({
        id,
        objective_id: body.objective_id as string,
        outcome: (body.outcome as string | undefined) ?? "",
        expected_outcome: (body.expected_outcome as string | undefined) ?? "",
        actual_outcome: (body.actual_outcome as string | undefined) ?? "",
        successful_roles_json: jsonArr(body.successful_roles),
        failed_roles_json: jsonArr(body.failed_roles),
        bottlenecks_json: jsonArr(body.bottlenecks),
        incidents_json: jsonArr(body.incidents),
        useful_workflows_json: jsonArr(body.useful_workflows),
        unnecessary_work_json: jsonArr(body.unnecessary_work),
        decisions_json: jsonArr(body.decisions),
        deviations_json: jsonArr(body.deviations),
        trust_updates_json: jsonArr(body.trust_updates),
        lessons_json: jsonArr(body.lessons),
        topology_changes_json: jsonArr(body.topology_changes),
        policy_changes_json: jsonArr(body.policy_changes),
        recorded_at: now,
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "org.post_objective.create",
        entity_type: "post_objective_records",
        entity_id: id,
        detail_json: JSON.stringify({ objective_id: body.objective_id }),
        source: "api",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, id });
    }
    if (path === "/api/org/trust" && method === "GET") {
      return json({ trust: this.store.listOrgTrust() });
    }
    if (path === "/api/org/trust" && method === "POST") {
      const body = (await readBody<{ agent_id?: string; capability?: string; success?: boolean }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.agent_id || typeof body.agent_id !== "string") return json({ error: "agent_id required" }, 400);
      if (!body.capability || typeof body.capability !== "string") return json({ error: "capability required" }, 400);
      if (!this.store.getOrgAgent(body.agent_id)) return json({ error: "Unknown agent instance" }, 404);
      this.store.recordTrustEvidence(body.agent_id, body.capability, body.success === true);
      return json({ ok: true });
    }
    if (path === "/api/org/messages" && method === "GET") {
      const type = url.searchParams.get("type") ?? undefined;
      return json({ messages: this.store.listOrgMessages({ type: type ?? undefined, limit: 200 }) });
    }
    if (path === "/api/org/messages" && method === "POST") {
      const body = (await readBody<{ from_role?: string; to_role?: string; type?: string; task_id?: string; payload?: unknown }>(request).catch(() => ({}))) as Record<string, unknown>;
      const result = this.store.sendOrgMessage({
        fromRole: String(body.from_role ?? ""),
        toRole: String(body.to_role ?? ""),
        type: String(body.type ?? ""),
        taskId: body.task_id as string | undefined,
        payload: body.payload ?? {},
      });
      if ("error" in result) return json({ error: result.error }, 400);
      return json({ ok: true, message: result });
    }

    // -- AOrgI Phase 3: capability grants / plans / negotiations ---------------
    if (path === "/api/org/capabilities" && method === "GET") {
      const roleId = url.searchParams.get("role_id") ?? undefined;
      return json({ grants: this.store.listCapabilityGrants({ roleId }) });
    }
    if (path === "/api/org/capabilities" && method === "POST") {
      const body = (await readBody<{
        role_id?: string;
        capability?: string;
        allowed_actions?: string[];
        autonomy_level?: string;
        requires_review?: boolean;
        rate_limit_per_hour?: number;
        data_scope?: string;
      }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.role_id || typeof body.role_id !== "string") return json({ error: "role_id required" }, 400);
      if (!body.capability || typeof body.capability !== "string") return json({ error: "capability required" }, 400);
      if (!["L0", "L1", "L2", "L3"].includes(String(body.autonomy_level ?? ""))) return json({ error: "autonomy_level must be L0 | L1 | L2 | L3" }, 400);
      try {
        const grant = this.store.upsertCapabilityGrant({
          roleId: body.role_id,
          capability: body.capability,
          allowedActions: Array.isArray(body.allowed_actions) ? body.allowed_actions.map(String) : undefined,
          autonomyLevel: String(body.autonomy_level),
          requiresReview: body.requires_review === true,
          rateLimitPerHour: typeof body.rate_limit_per_hour === "number" ? body.rate_limit_per_hour : undefined,
          dataScope: body.data_scope as string | undefined,
        });
        this.store.insertAudit({
          id: newId("aud"), actor: "founder", action: "org.capability_grant.upsert",
          entity_type: "org_capability_grants", entity_id: grant.id,
          detail_json: JSON.stringify({ role_id: grant.role_id, capability: grant.capability, autonomy_level: grant.autonomy_level }),
          source: "api", created_at: nowIso(), updated_at: nowIso(),
        });
        return json({ ok: true, grant });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    if (path === "/api/org/plans" && method === "GET") {
      return json({ plans: this.store.listOrgPlans() });
    }
    if (path === "/api/org/plans" && method === "POST") {
      const body = (await readBody<{ objective_id?: string; title?: string; owner_role?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.title || typeof body.title !== "string" || !body.title.trim()) return json({ error: "title required" }, 400);
      if (!body.owner_role || typeof body.owner_role !== "string") return json({ error: "owner_role required" }, 400);
      if (!this.store.getOrgRole(body.owner_role)) return json({ error: "Unknown owner_role" }, 400);
      const plan = this.store.createOrgPlan({
        objectiveId: body.objective_id as string | undefined,
        title: body.title.trim(),
        ownerRole: body.owner_role,
      });
      return json({ ok: true, plan });
    }
    const planDetail = /^\/api\/org\/plans\/([^/]+)$/.exec(path);
    if (planDetail && method === "GET") {
      const id = decodeURIComponent(planDetail[1]!);
      const plan = this.store.getOrgPlan(id);
      if (!plan) return json({ error: "Plan not found" }, 404);
      return json({
        plan,
        steps: this.store.listOrgPlanSteps(id),
        deviations: this.store.listOrgPlanDeviations(id),
        tasks: this.store.listTasks({ limit: 200 }).filter((t) => t.plan_id === id),
      });
    }
    const planRevise = /^\/api\/org\/plans\/([^/]+)\/revise$/.exec(path);
    if (planRevise && method === "POST") {
      const id = decodeURIComponent(planRevise[1]!);
      const body = (await readBody<{ title?: string; owner_role?: string; status?: string; description?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      const plan = this.store.reviseOrgPlan(id, {
        title: body.title as string | undefined,
        ownerRole: body.owner_role as string | undefined,
        status: body.status as string | undefined,
        description: body.description as string | undefined,
      });
      if (!plan) return json({ error: "Plan not found" }, 404);
      return json({ ok: true, plan });
    }
    const planSteps = /^\/api\/org\/plans\/([^/]+)\/steps$/.exec(path);
    if (planSteps && method === "POST") {
      const id = decodeURIComponent(planSteps[1]!);
      const body = (await readBody<{ title?: string; owner_role?: string; dependencies?: string[]; seq?: number }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.title || typeof body.title !== "string") return json({ error: "title required" }, 400);
      if (!body.owner_role || typeof body.owner_role !== "string") return json({ error: "owner_role required" }, 400);
      const step = this.store.addOrgPlanStep(id, {
        title: body.title,
        ownerRole: body.owner_role,
        dependencies: Array.isArray(body.dependencies) ? body.dependencies.map(String) : undefined,
        seq: typeof body.seq === "number" ? body.seq : undefined,
      });
      if (!step) return json({ error: "Plan not found" }, 404);
      return json({ ok: true, step });
    }
    const planLink = /^\/api\/org\/plans\/([^/]+)\/link-task$/.exec(path);
    if (planLink && method === "POST") {
      const planId = decodeURIComponent(planLink[1]!);
      const body = (await readBody<{ task_id?: string; step_id?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.task_id || typeof body.task_id !== "string") return json({ error: "task_id required" }, 400);
      if (!body.step_id || typeof body.step_id !== "string") return json({ error: "step_id required" }, 400);
      const task = this.store.linkTaskToPlanStep(body.task_id, planId, body.step_id);
      if (!task) return json({ error: "Task, plan, or step not found" }, 404);
      return json({ ok: true, task });
    }
    const stepStatus = /^\/api\/org\/plan-steps\/([^/]+)\/status$/.exec(path);
    if (stepStatus && method === "POST") {
      const id = decodeURIComponent(stepStatus[1]!);
      const body = (await readBody<{ status?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!["PENDING", "IN_PROGRESS", "DONE", "BLOCKED"].includes(String(body.status ?? ""))) return json({ error: "status must be PENDING | IN_PROGRESS | DONE | BLOCKED" }, 400);
      const step = this.store.updateOrgPlanStepStatus(id, String(body.status));
      if (!step) return json({ error: "Step not found" }, 404);
      return json({ ok: true, step });
    }
    if (path === "/api/org/arbiters" && method === "GET") {
      return json({ arbiters: this.store.listOrgArbiters() });
    }
    if (path === "/api/org/reasoning-traces" && method === "GET") {
      const agentId = url.searchParams.get("agent_id") ?? undefined;
      const taskId = url.searchParams.get("task_id") ?? undefined;
      return json({ traces: this.store.listReasoningTraces({ agentId, taskId, limit: 100 }) });
    }
    if (path === "/api/org/reasoning-traces" && method === "POST") {
      const body = (await readBody<{
        agent_id?: string;
        task_id?: string;
        mode?: string;
        evidence?: unknown;
        hypothesis?: string;
        confidence?: number | null;
        final_action?: string;
        visibility?: "internal" | "reviewer" | "public";
      }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.agent_id || typeof body.agent_id !== "string") return json({ error: "agent_id required" }, 400);
      if (body.visibility !== undefined && !["internal", "reviewer", "public"].includes(String(body.visibility))) {
        return json({ error: "visibility must be internal | reviewer | public" }, 400);
      }
      const trace = this.store.createReasoningTrace({
        agentId: body.agent_id,
        taskId: body.task_id as string | undefined,
        mode: body.mode as string | undefined,
        evidence: body.evidence ?? [],
        hypothesis: body.hypothesis as string | undefined,
        confidence: typeof body.confidence === "number" ? body.confidence : null,
        finalAction: body.final_action as string | undefined,
        visibility: body.visibility as "internal" | "reviewer" | "public" | undefined,
      });
      return json({ ok: true, trace });
    }
    if (path === "/api/org/negotiations" && method === "GET") {
      return json({ negotiations: this.store.listOrgNegotiations() });
    }
    if (path === "/api/org/negotiations" && method === "POST") {
      const body = (await readBody<{ topic?: string; task_id?: string; disagreement_class?: string; max_rounds?: number }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.topic || typeof body.topic !== "string" || !body.topic.trim()) return json({ error: "topic required" }, 400);
      let arbiterRole: string | undefined;
      if (body.disagreement_class && typeof body.disagreement_class === "string") {
        const rule = this.store.getOrgArbiter(body.disagreement_class);
        if (!rule) return json({ error: `Unknown disagreement_class '${body.disagreement_class}'` }, 400);
        arbiterRole = rule.arbiter_role_id ?? rule.fallback_role_id ?? undefined;
      }
      const negotiation = this.store.createOrgNegotiation({
        topic: body.topic.trim(),
        taskId: body.task_id as string | undefined,
        maxRounds: typeof body.max_rounds === "number" ? body.max_rounds : undefined,
        arbiterRole,
      });
      return json({ ok: true, negotiation });
    }
    const negRound = /^\/api\/org\/negotiations\/([^/]+)\/round$/.exec(path);
    if (negRound && method === "POST") {
      const id = decodeURIComponent(negRound[1]!);
      const body = (await readBody<{ kind?: string; role?: string; content?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.content || typeof body.content !== "string") return json({ error: "content required" }, 400);
      const result = this.store.addNegotiationRound(id, {
        kind: String(body.kind ?? ""),
        role: String(body.role ?? "role_coa"),
        content: body.content,
      });
      if (!result.ok) return json({ error: result.error }, 400);
      return json({ ok: true, negotiation: result.negotiation, round: result.round });
    }
    const negArbitrate = /^\/api\/org\/negotiations\/([^/]+)\/arbitrate$/.exec(path);
    if (negArbitrate && method === "POST") {
      const id = decodeURIComponent(negArbitrate[1]!);
      const body = (await readBody<{ verdict?: string; by_role?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.verdict || typeof body.verdict !== "string") return json({ error: "verdict required" }, 400);
      const negotiation = this.store.arbitrateNegotiation(id, body.verdict, String(body.by_role ?? "role_coa"));
      if (!negotiation) return json({ error: "Negotiation not found or already resolved" }, 404);
      return json({ ok: true, negotiation });
    }

    // -- AOrgI Phase 4: collective intelligence + analyst + chaos drills --------
    if (path === "/api/org/intelligence" && method === "GET") {
      return json({
        metrics: collectiveMetrics(this.store),
        latestReport: this.store.latestAnalystReport(),
        reports: this.store.listAnalystReports(20),
      });
    }
    if (path === "/api/org/analyst/run" && method === "POST") {
      const report = runOrgAnalyst(this.store, "manual");
      return json({ ok: true, report });
    }
    if (path === "/api/org/chaos-tests" && method === "GET") {
      return json({ tests: this.store.listChaosTests(50) });
    }
    if (path === "/api/org/chaos-tests/run" && method === "POST") {
      const body = (await readBody<{ kind?: string; target?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.kind || typeof body.kind !== "string") return json({ error: "kind required (agent_kill_sim | grant_degrade)" }, 400);
      if (!body.target || typeof body.target !== "string") return json({ error: "target agent id required" }, 400);
      const outcome = runChaosTest(this.store, body.kind, body.target);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "org.chaos_test.run",
        entity_type: "org_chaos_tests",
        entity_id: body.target,
        detail_json: JSON.stringify({ kind: body.kind, outcome }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, outcome });
    }

    // -- AOrgI round-2 fixes: incidents + DefinitionOfDone ---------------------
    if (path === "/api/org/incidents" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({ incidents: this.store.listOrgIncidents({ status: status ?? undefined, limit: 100 }) });
    }
    if (path === "/api/org/incidents" && method === "POST") {
      const body = (await readBody<{ title?: string; severity?: string; description?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!body.title || typeof body.title !== "string" || !body.title.trim()) return json({ error: "title required" }, 400);
      const incident = this.store.createOrgIncident({
        title: body.title.trim(),
        severity: body.severity as string | undefined,
        description: body.description as string | undefined,
        source: "founder",
      });
      return json({ ok: true, incident });
    }
    const incidentStatus = /^\/api\/org\/incidents\/([^/]+)\/status$/.exec(path);
    if (incidentStatus && method === "POST") {
      const id = decodeURIComponent(incidentStatus[1]!);
      const body = (await readBody<{ status?: string; resolution?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      if (!["OPEN", "CONTAINED", "RESOLVED"].includes(String(body.status ?? ""))) return json({ error: "status must be OPEN | CONTAINED | RESOLVED" }, 400);
      const incident = this.store.updateOrgIncidentStatus(id, String(body.status) as never, body.resolution as string | undefined);
      if (!incident) return json({ error: "Incident not found" }, 404);
      return json({ ok: true, incident });
    }
    if (path === "/api/org/definition-of-done" && method === "GET") {
      const dod = this.store.getDefinitionOfDone();
      return dod ? json({ ok: true, dod }) : json({ ok: false, error: "No DefinitionOfDone in org memory" }, 404);
    }

    // -- AOrgI Phase 5: topology proposals -------------------------------------
    if (path === "/api/org/topology" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({ proposals: this.store.listTopologyProposals({ status: status ?? undefined, limit: 100 }) });
    }
    const topologyDecide = /^\/api\/org\/topology\/([^/]+)\/decide$/.exec(path);
    if (topologyDecide && method === "POST") {
      const id = decodeURIComponent(topologyDecide[1]!);
      const body = (await readBody<{ decision?: string }>(request).catch(() => ({}))) as Record<string, unknown>;
      const decision = String(body.decision ?? "").toLowerCase();
      if (!["approve", "reject"].includes(decision)) return json({ error: "decision must be approve | reject" }, 400);
      const proposal = this.store.updateTopologyProposal(id, {
        status: decision === "approve" ? "APPROVED" : "REJECTED",
        decidedBy: "founder",
      });
      if (!proposal) return json({ error: "Proposal not found" }, 404);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: `org.topology.${decision}`,
        entity_type: "org_topology_proposals",
        entity_id: id,
        detail_json: JSON.stringify({ kind: proposal.kind, role_id: proposal.role_id }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, proposal });
    }

    // ---------------------------------------------------------------------
    // Perceptual Intelligence (specs/zarlino-artificial-organization.md):
    // evaluator panel, test registry, append-only results, validation gates,
    // knowledge base, failure taxonomy, KPIs.
    // ---------------------------------------------------------------------
    if (path === "/api/perceptual/report" && method === "GET") {
      return json(perceptualKpi(this.store));
    }

    // Evaluators (external human sensor network â€” NOT employees, spec Â§5)
    if (path === "/api/perceptual/evaluators" && method === "GET") {
      const actorType = url.searchParams.get("actorType") ?? undefined;
      return json({ evaluators: this.store.listPerceptualEvaluators({ actorType, limit: 200 }) });
    }
    if (path === "/api/perceptual/evaluators" && method === "POST") {
      const body = (await readBody<{ name?: string; actorType?: string; expertise?: string; genres?: string[]; experienceLevel?: string; compensationProfile?: string; conflicts?: string[] }>(request).catch(() => ({}))) as { name?: string; actorType?: string; expertise?: string; genres?: string[]; experienceLevel?: string; compensationProfile?: string; conflicts?: string[] };
      if (!body.name?.trim()) return json({ error: "name required" }, 400);
      const actorType = ["external_human", "internal_agent", "customer"].includes(String(body.actorType ?? "").toLowerCase())
        ? String(body.actorType!).toLowerCase()
        : "external_human";
      const now = nowIso();
      const id = newId("pev");
      this.store.createPerceptualEvaluator({
        id,
        name: body.name.trim(),
        actor_type: actorType,
        expertise: body.expertise ?? "",
        genres_json: JSON.stringify(body.genres ?? []),
        experience_level: body.experienceLevel ?? "",
        reliability_score: 0,
        calibration_score: 0,
        reliability_by_domain_json: "{}",
        availability: "active",
        compensation_profile: body.compensationProfile ?? "",
        conflicts_json: JSON.stringify(body.conflicts ?? []),
        test_count: 0,
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "perceptual.evaluator.register",
        entity_type: "perceptual_evaluators",
        entity_id: id,
        detail_json: JSON.stringify({ name: body.name.trim(), actorType }),
        source: "api",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, id });
    }
    const evaluatorDelete = /^\/api\/perceptual\/evaluators\/([^/]+)$/.exec(path);
    if (evaluatorDelete && method === "DELETE") {
      return json({ deleted: this.store.deletePerceptualEvaluator(decodeURIComponent(evaluatorDelete[1]!)) });
    }

    // Test registry (spec Â§6)
    if (path === "/api/perceptual/tests" && method === "GET") {
      const productId = url.searchParams.get("productId") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const tier = url.searchParams.get("tier") ?? undefined;
      return json({ tests: this.store.listPerceptualTests({ productId, status, tier, limit: 200 }) });
    }
    if (path === "/api/perceptual/tests" && method === "POST") {
      const body = (await readBody<{ productId?: string; title?: string; testType?: string; hypothesis?: string; objective?: string; protocol?: string; stimuli?: string[]; conditions?: string[]; evaluatorRequirements?: string; sampleSizeTarget?: number; blinding?: string; randomization?: string; metrics?: string[]; acceptanceThreshold?: string; tier?: string }>(request).catch(() => ({}))) as { productId?: string; title?: string; testType?: string; hypothesis?: string; objective?: string; protocol?: string; stimuli?: string[]; conditions?: string[]; evaluatorRequirements?: string; sampleSizeTarget?: number; blinding?: string; randomization?: string; metrics?: string[]; acceptanceThreshold?: string; tier?: string };
      if (!body.productId?.trim() || !body.title?.trim()) return json({ error: "productId and title required" }, 400);
      const types = ["blind_preference", "abx_identification", "problem_solution", "workflow", "preference_reach"];
      const testType = types.includes(String(body.testType ?? "").toLowerCase()) ? String(body.testType!).toLowerCase() : "blind_preference";
      const tier = ["exploratory", "validation", "high_confidence", "commercial"].includes(String(body.tier ?? "").toLowerCase())
        ? String(body.tier!).toLowerCase()
        : "exploratory";
      const blinding = ["blind", "double_blind", "unblinded"].includes(String(body.blinding ?? "").toLowerCase())
        ? String(body.blinding!).toLowerCase()
        : "blind";
      const now = nowIso();
      const id = newId("pt");
      this.store.createPerceptualTest({
        id,
        product_id: body.productId.trim(),
        title: body.title.trim(),
        hypothesis: body.hypothesis ?? "",
        objective: body.objective ?? "",
        test_type: testType,
        protocol: body.protocol ?? "",
        stimuli_json: JSON.stringify(body.stimuli ?? []),
        conditions_json: JSON.stringify(body.conditions ?? []),
        evaluator_requirements: body.evaluatorRequirements ?? "",
        sample_size_target: Number.isFinite(body.sampleSizeTarget) ? Math.max(0, Math.min(1000, Math.trunc(body.sampleSizeTarget!))) : 0,
        blinding,
        randomization: body.randomization ?? "",
        metrics_json: JSON.stringify(body.metrics ?? []),
        acceptance_threshold: body.acceptanceThreshold ?? "",
        tier,
        status: "designed",
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "perceptual.test.create",
        entity_type: "perceptual_tests",
        entity_id: id,
        detail_json: JSON.stringify({ productId: body.productId.trim(), title: body.title.trim(), testType, tier }),
        source: "api",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, id });
    }
    const testPatch = /^\/api\/perceptual\/tests\/([^/]+)$/.exec(path);
    if (testPatch && method === "PATCH") {
      const id = decodeURIComponent(testPatch[1]!);
      const existing = this.store.getPerceptualTest(id);
      if (!existing) return json({ error: "Test not found" }, 404);
      const body = (await readBody<{ status?: string; protocol?: string }>(request).catch(() => ({}))) as { status?: string; protocol?: string };
      const statuses = ["draft", "designed", "recruiting", "in_progress", "completed", "analyzed", "closed"];
      if (body.status && !statuses.includes(body.status)) return json({ error: `Invalid test status: ${body.status}` }, 400);
      this.store.updatePerceptualTest(id, {
        status: body.status ?? existing.status,
        protocol: body.protocol ?? existing.protocol,
      });
      return json({ ok: true, test: this.store.getPerceptualTest(id) });
    }

    // Results â€” APPEND-ONLY (spec Â§9): no PATCH/DELETE routes exist.
    const testResults = /^\/api\/perceptual\/tests\/([^/]+)\/results$/.exec(path);
    if (testResults && method === "GET") {
      const testId = decodeURIComponent(testResults[1]!);
      return json({ results: this.store.listPerceptualResults({ testId, limit: 500 }) });
    }
    if (testResults && method === "POST") {
      const testId = decodeURIComponent(testResults[1]!);
      const test = this.store.getPerceptualTest(testId);
      if (!test) return json({ error: "Test not found" }, 404);
      const body = (await readBody<{ evaluatorId?: string; responses?: Record<string, unknown>; attentionChecksPassed?: number; attentionChecksTotal?: number; selfConfidence?: number; completionMs?: number }>(request).catch(() => ({}))) as { evaluatorId?: string; responses?: Record<string, unknown>; attentionChecksPassed?: number; attentionChecksTotal?: number; selfConfidence?: number; completionMs?: number };
      if (!body.evaluatorId?.trim()) return json({ error: "evaluatorId required" }, 400);
      const evaluator = this.store.getPerceptualEvaluator(body.evaluatorId.trim());
      if (!evaluator) return json({ error: "Evaluator not found" }, 404);
      const passed = Math.max(0, Math.trunc(body.attentionChecksPassed ?? 0));
      const total = Math.max(0, Math.trunc(body.attentionChecksTotal ?? 0));
      const rejected = attentionCheckFailed({ attention_checks_passed: passed, attention_checks_total: total });
      const now = nowIso();
      const id = newId("prs");
      this.store.createPerceptualResult({
        id,
        test_id: testId,
        evaluator_id: body.evaluatorId.trim(),
        responses_json: JSON.stringify(body.responses ?? {}),
        completion_ms: Number.isFinite(body.completionMs) ? Math.max(0, Math.trunc(body.completionMs!)) : undefined,
        attention_checks_passed: passed,
        attention_checks_total: total,
        self_confidence: typeof body.selfConfidence === "number" ? Math.max(0, Math.min(1, body.selfConfidence)) : undefined,
        status: rejected ? "rejected" : "accepted",
        source: "api",
        created_at: now,
      });
      this.store.updatePerceptualEvaluator(evaluator.id, { test_count: evaluator.test_count + 1 });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: rejected ? "perceptual.result.rejected" : "perceptual.result.record",
        entity_type: "perceptual_results",
        entity_id: id,
        detail_json: JSON.stringify({ testId, evaluatorId: body.evaluatorId.trim(), attention: `${passed}/${total}` }),
        source: "api",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, id, status: rejected ? "rejected" : "accepted" });
    }
    const testAnalysis = /^\/api\/perceptual\/tests\/([^/]+)\/analysis$/.exec(path);
    if (testAnalysis && method === "GET") {
      const testId = decodeURIComponent(testAnalysis[1]!);
      const test = this.store.getPerceptualTest(testId);
      if (!test) return json({ error: "Test not found" }, 404);
      const results = this.store.listPerceptualResults({ testId, limit: 1000 });
      const agg = aggregateTestResults(test, results);
      return json({ aggregation: agg, knowledgeDraft: deriveKnowledge(test, agg) });
    }

    // Product validation gates (spec Â§14)
    if (path === "/api/perceptual/validations" && method === "GET") {
      return json({ validations: this.store.listProductValidations().map((v) => ({ ...v, evaluation: evaluateProductGates(v) })) });
    }
    if (path === "/api/perceptual/validations" && method === "POST") {
      const body = (await readBody<{ productId?: string; stage?: string; engineering?: string; measurement?: string; perceptual?: string; workflow?: string; commercial?: string; governance?: string; decision?: string; decisionNote?: string; iteration?: number }>(request).catch(() => ({}))) as { productId?: string; stage?: string; engineering?: string; measurement?: string; perceptual?: string; workflow?: string; commercial?: string; governance?: string; decision?: string; decisionNote?: string; iteration?: number };
      if (!body.productId?.trim()) return json({ error: "productId required" }, 400);
      const isVerdict = (v: unknown) => v === undefined || ["PASS", "FAIL", "INCONCLUSIVE"].includes(String(v).toUpperCase());
      if (![body.engineering, body.measurement, body.perceptual, body.workflow, body.commercial, body.governance].every(isVerdict)) {
        return json({ error: "verdicts must be PASS | FAIL | INCONCLUSIVE" }, 400);
      }
      const stages = ["prototype", "validation", "beta", "ship"];
      const stage = stages.includes(String(body.stage ?? "")) ? String(body.stage) : "prototype";
      const existing = this.store.getProductValidation(body.productId.trim());
      const now = nowIso();
      const row = {
        product_id: body.productId.trim(),
        stage,
        engineering: body.engineering ? String(body.engineering).toUpperCase() : existing?.engineering ?? "INCONCLUSIVE",
        measurement: body.measurement ? String(body.measurement).toUpperCase() : existing?.measurement ?? "INCONCLUSIVE",
        perceptual: body.perceptual ? String(body.perceptual).toUpperCase() : existing?.perceptual ?? "INCONCLUSIVE",
        workflow: body.workflow ? String(body.workflow).toUpperCase() : existing?.workflow ?? "INCONCLUSIVE",
        commercial: body.commercial ? String(body.commercial).toUpperCase() : existing?.commercial ?? "INCONCLUSIVE",
        governance: body.governance ? String(body.governance).toUpperCase() : existing?.governance ?? "PASS",
        decision: body.decision ? String(body.decision).toUpperCase() : existing?.decision ?? "NONE",
        decision_by: body.decision ? "founder" : existing?.decision_by,
        decision_note: body.decisionNote ?? existing?.decision_note,
        iteration: Number.isFinite(body.iteration) ? Math.max(0, Math.trunc(body.iteration!)) : existing?.iteration ?? 0,
        notes_json: existing?.notes_json ?? "[]",
        created_at: existing?.created_at ?? now,
        updated_at: now,
      } as const;
      this.store.upsertProductValidation(row as never);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "perceptual.validation.set",
        entity_type: "product_validations",
        entity_id: body.productId.trim(),
        detail_json: JSON.stringify({ stage, perceptual: row.perceptual, decision: row.decision }),
        source: "api",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, validation: { ...row, evaluation: evaluateProductGates(row as never) } });
    }

    // Knowledge base (spec Â§27-29)
    if (path === "/api/perceptual/knowledge" && method === "GET") {
      const productCategory = url.searchParams.get("productCategory") ?? undefined;
      const evidenceTier = url.searchParams.get("evidenceTier") ?? undefined;
      return json({ knowledge: this.store.listPerceptualKnowledge({ productCategory, evidenceTier, limit: 200 }) });
    }
    if (path === "/api/perceptual/knowledge" && method === "POST") {
      const body = (await readBody<{ productCategory?: string; musicalContext?: string; desiredOutcome?: string; observations?: string[]; confidence?: number; sampleSize?: number; testProtocol?: string; sourceTestId?: string; evidenceTier?: string }>(request).catch(() => ({}))) as { productCategory?: string; musicalContext?: string; desiredOutcome?: string; observations?: string[]; confidence?: number; sampleSize?: number; testProtocol?: string; sourceTestId?: string; evidenceTier?: string };
      if (!body.productCategory?.trim()) return json({ error: "productCategory required" }, 400);
      const tiers = ["engineering", "measurement", "perceptual", "workflow", "market"];
      const now = nowIso();
      const id = newId("pk");
      this.store.createPerceptualKnowledge({
        id,
        product_category: body.productCategory.trim(),
        musical_context: body.musicalContext ?? "",
        desired_outcome: body.desiredOutcome ?? "",
        observation_json: JSON.stringify(body.observations ?? []),
        confidence: typeof body.confidence === "number" ? Math.max(0, Math.min(1, body.confidence)) : 0,
        sample_size: Number.isFinite(body.sampleSize) ? Math.max(0, Math.trunc(body.sampleSize!)) : 0,
        test_protocol: body.testProtocol ?? "",
        source_test_id: body.sourceTestId,
        evidence_tier: tiers.includes(String(body.evidenceTier ?? "").toLowerCase()) ? String(body.evidenceTier).toLowerCase() : "perceptual",
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true, id });
    }
    const knowledgeDelete = /^\/api\/perceptual\/knowledge\/([^/]+)$/.exec(path);
    if (knowledgeDelete && method === "DELETE") {
      return json({ deleted: this.store.deletePerceptualKnowledge(decodeURIComponent(knowledgeDelete[1]!)) });
    }

    // Failure taxonomy (spec Â§39)
    if (path === "/api/perceptual/failures" && method === "GET") {
      const productId = url.searchParams.get("productId") ?? undefined;
      return json({ failures: this.store.listFailureAnalyses({ productId, limit: 200 }) });
    }
    if (path === "/api/perceptual/failures" && method === "POST") {
      const body = (await readBody<{ productId?: string; failureClass?: string; title?: string; description?: string; lessons?: string[] }>(request).catch(() => ({}))) as { productId?: string; failureClass?: string; title?: string; description?: string; lessons?: string[] };
      if (!body.productId?.trim() || !body.title?.trim()) return json({ error: "productId and title required" }, 400);
      const rec = failureRecord({
        id: newId("pfl"),
        productId: body.productId.trim(),
        failureClass: body.failureClass ?? "perceptual",
        title: body.title.trim(),
        description: body.description ?? "",
        lessons: body.lessons,
        now: nowIso(),
      });
      this.store.createFailureAnalysis(rec);
      return json({ ok: true, id: rec.id, failureClass: rec.failure_class });
    }

    // Tool runner (executes any registered tool; HIGH-risk gating happens here)
    if (path === "/api/tools/run" && method === "POST") {
      const body = (await readBody<{ name?: string; input?: Record<string, unknown>; confirm?: boolean }>(request).catch(() => ({}))) as { name?: string; input?: Record<string, unknown>; confirm?: boolean };
      const registry = this.buildRegistry();
      const tool = registry.getTool(body.name ?? "");
      if (!tool) return json({ error: `Unknown tool: ${body.name}` }, 404);
      if ((tool.riskLevel === "HIGH" || tool.riskLevel === "CRITICAL") && body.confirm !== true) {
        return json({ error: `Tool ${body.name} is ${tool.riskLevel} risk â€” pass confirm:true to execute.`, riskLevel: tool.riskLevel }, 403);
      }
      const result = await registry.run(tool.name, body.input ?? {}, {
        env: this.env as unknown as Record<string, string | undefined>,
        store: this.store,
        audit: (actor, action, entityType, entityId, detail) => {
          this.store.insertAudit({
            id: newId("aud"),
            actor,
            action,
            entity_type: entityType,
            entity_id: entityId,
            detail_json: detail ? JSON.stringify(detail) : undefined,
            source: "api",
            created_at: nowIso(),
            updated_at: nowIso(),
          });
        },
        // BOTH tables, always: a tool that spends money must move the same
        // meter the budget gate reads. This used to be ledger-only.
        recordCost: (c) => {
          const tokens = c.inputTokens + c.outputTokens;
          if (tokens > 0) this.store.addTokenUse("global", undefined, tokens, c.cost);
          this.store.record(c);
        },
      });
      return json(result);
    }

    // Remote execution (engineering runs on GitHub Actions — spec §2.5).
    // The VM dispatches, tracks and collects evidence; it never executes.
    if (path === "/api/remote/runs" && method === "GET") {
      return json({ summary: remoteRunsSummary(this.store), runs: this.store.listRemoteRuns(50) });
    }
    if (path === "/api/remote/dispatch" && method === "POST") {
      const body = (await readBody<{ repo?: string; workflow?: string; ref?: string; inputs?: Record<string, string>; taskId?: string; objectiveId?: string }>(request).catch(() => ({}))) as { repo?: string; workflow?: string; ref?: string; inputs?: Record<string, string>; taskId?: string; objectiveId?: string };
      const decision = await dispatchRemoteWorkflow(this.store, this.env, {
        repo: String(body.repo ?? ""),
        workflow: String(body.workflow ?? ""),
        ref: body.ref,
        inputs: body.inputs,
        taskId: body.taskId,
        objectiveId: body.objectiveId,
        source: "api",
      });
      return json(
        decision.ok ? { ok: true, run: decision.run } : { ok: false, code: decision.code, error: decision.error, existingId: decision.existingId },
        decision.ok ? 200 : 409,
      );
    }
    if (path === "/api/remote/sync" && method === "POST") {
      const body = (await readBody<{ limit?: number }>(request).catch(() => ({}))) as { limit?: number };
      const sweep = await syncActiveRemoteRuns(this.store, this.env, Math.max(1, Math.min(10, Number(body.limit) || 3)));
      return json({ ok: true, ...sweep });
    }
    const remoteSyncOne = /^\/api\/remote\/runs\/([^/]+)\/sync$/.exec(path);
    if (remoteSyncOne && method === "POST") {
      const r = await syncRemoteRun(this.store, this.env, decodeURIComponent(remoteSyncOne[1]!));
      return r ? json({ ok: true, run: r.run, note: r.note ?? null }) : json({ error: "Remote run not found" }, 404);
    }
    const remoteCancelOne = /^\/api\/remote\/runs\/([^/]+)\/cancel$/.exec(path);
    if (remoteCancelOne && method === "POST") {
      const body = (await readBody<{ reason?: string }>(request).catch(() => ({}))) as { reason?: string };
      const r = await cancelRemoteRun(this.store, this.env, decodeURIComponent(remoteCancelOne[1]!), body.reason);
      return json({ ok: r.ok, note: r.note });
    }

    // Objectives — persistent organizational objectives (spec §2.4 / §4).
    if (path === "/api/objectives" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({
        objectives: this.store.listObjectives(status ?? undefined).map((o) => ({
          ...o,
          tasks: this.store.listTasksForObjective(o.id).map((t) => ({ id: t.id, title: t.title, status: t.status })),
        })),
      });
    }
    if (path === "/api/objectives" && method === "POST") {
      const body = (await readBody<{ title?: string; description?: string; criteria?: string }>(request).catch(() => ({}))) as { title?: string; description?: string; criteria?: string };
      if (!body.title?.trim()) return json({ error: "title required" }, 400);
      const at = nowIso();
      const id = newId("obj");
      this.store.insertObjective({
        id,
        title: body.title.trim().slice(0, 200),
        description: body.description?.slice(0, 1000),
        status: "ACTIVE",
        priority: 2,
        source: "founder",
        criteria_json: body.criteria?.slice(0, 2000),
        created_at: at,
        updated_at: at,
      });
      return json({ ok: true, id });
    }
    const objPatch = /^\/api\/objectives\/([^/]+)$/.exec(path);
    if (objPatch && (method === "PATCH" || method === "POST")) {
      const id = decodeURIComponent(objPatch[1]!);
      const objective = this.store.getObjective(id);
      if (!objective) return json({ error: "Objective not found" }, 404);
      const body = (await readBody<{ status?: string; criteria?: string; evidence?: string }>(request).catch(() => ({}))) as { status?: string; criteria?: string; evidence?: string };
      const status = ["ACTIVE", "PAUSED", "ACHIEVED", "CANCELLED"].includes(String(body.status ?? "")) ? String(body.status) : undefined;
      if (status === "ACHIEVED") {
        // Acceptance gate: an objective is never marked complete while linked
        // tasks are open or no measurable criteria exist (spec §4 stage 7).
        const tasks = this.store.listTasksForObjective(id);
        const open = tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELLED");
        if (open.length > 0) {
          return json({ error: `cannot mark ACHIEVED: ${open.length} linked task(s) still open`, open }, 409);
        }
        if (!(body.criteria?.trim() || objective.criteria_json)) {
          return json({ error: "cannot mark ACHIEVED: no completion criteria recorded" }, 409);
        }
      }
      const at = nowIso();
      const patch: Record<string, unknown> = {};
      if (status) patch.status = status;
      if (body.criteria?.trim()) patch.criteria_json = body.criteria.trim().slice(0, 2000);
      if (body.evidence?.trim()) patch.evidence_json = body.evidence.trim().slice(0, 2000);
      if (status === "ACHIEVED") {
        patch.verified_at = at;
        patch.completed_at = at;
      }
      this.store.updateObjective(id, patch as never);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "objective.updated",
        entity_type: "objectives",
        entity_id: id,
        detail_json: JSON.stringify({ status: status ?? null }),
        source: "api",
        created_at: at,
        updated_at: at,
      });
      return json({ ok: true, objective: this.store.getObjective(id) });
    }

    // Export / import
    if (path === "/api/export" && method === "GET") {
      return json({ ok: true, exportedAt: nowIso(), snapshot: this.store.exportSnapshot() });
    }
    if (path === "/api/import" && method === "POST") {
      const body = (await readBody<{ snapshot?: Record<string, unknown[]> }>(request).catch(() => ({}))) as { snapshot?: Record<string, unknown[]> };
      if (!body.snapshot) return json({ error: "snapshot required" }, 400);
      const result = this.store.importSnapshot(body.snapshot);
      return json({ ok: true, ...result });
    }

    // Settings (budget overrides)
    if (path === "/api/settings" && method === "GET") {
      return json({ budgetOverrides: this.store.getBudgetOverrides(), budget: this.store.getBudgetOverrides() });
    }
    if (path === "/api/settings" && method === "POST") {
      const body = (await readBody<Record<string, unknown>>(request).catch(() => ({}))) as Record<string, unknown>;
      this.store.setBudgetOverrides({
        aiDailyBudget: numOrUndef(body.aiDailyBudget),
        aiMonthlyBudget: numOrUndef(body.aiMonthlyBudget),
        aiPerTaskBudget: numOrUndef(body.aiPerTaskBudget),
        aiPerRunBudget: numOrUndef(body.aiPerRunBudget),
      });
      return json({ ok: true, budgetOverrides: this.store.getBudgetOverrides() });
    }

    // Productivity Manager (budgets, assignments, optimization, contradictions)
    if (path === "/api/productivity/report" && method === "GET") {
      return json(productivityReport(this.store));
    }
    if (path === "/api/productivity/budget" && method === "GET") {
      return json({ budgets: budgetStatus(this.store) });
    }
    if (path === "/api/productivity/assignments" && method === "GET") {
      return json({ assignments: this.store.listAssignments({ limit: 200 }) });
    }
    if (path === "/api/productivity/assign" && method === "POST") {
      const body = (await readBody<{ taskId?: string; roleId?: string; assignee?: string; modelTier?: string; tokenBudget?: number; note?: string }>(request).catch(() => ({}))) as { taskId?: string; roleId?: string; assignee?: string; modelTier?: string; tokenBudget?: number; note?: string };
      if (!body.taskId) return json({ error: "taskId required" }, 400);
      try {
        const id = assignTask(this.store, body.taskId, {
          roleId: body.roleId,
          assignee: body.assignee,
          modelTier: (body.modelTier as never) ?? undefined,
          tokenBudget: body.tokenBudget,
          note: body.note,
        });
        this.store.insertAudit({
          id: newId("aud"),
          actor: "founder",
          action: "productivity.assign",
          entity_type: "productivity_assignments",
          entity_id: id,
          detail_json: JSON.stringify({ taskId: body.taskId, roleId: body.roleId }),
          source: "api",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        return json({ ok: true, assignmentId: id });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    if (path === "/api/productivity/optimize" && method === "POST") {
      const result = optimize(this.store, this.env as unknown as Record<string, string | undefined>);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "productivity.optimize",
        entity_type: "optimization_events",
        entity_id: "productivity",
        detail_json: JSON.stringify(result.summary),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, ...result });
    }
    if (path === "/api/productivity/contradictions" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({ contradictions: this.store.listContradictions({ status: status as never, limit: 200 }), open: this.store.countOpenContradictions() });
    }
    if (path === "/api/productivity/contradictions/detect" && method === "POST") {
      const result = detectContradictions(this.store);
      return json({ ok: true, ...result });
    }
    const contradictionMatch = /^\/api\/productivity\/contradictions\/([^/]+)\/resolve$/.exec(path);
    if (contradictionMatch && method === "POST") {
      const id = decodeURIComponent(contradictionMatch[1]!);
      const body = (await readBody<{ status?: string; resolution?: string }>(request).catch(() => ({}))) as { status?: string; resolution?: string };
      if (!body.resolution) return json({ error: "resolution required" }, 400);
      const existing = this.store.getContradiction(id);
      if (!existing) return json({ error: "Contradiction not found" }, 404);
      const status = body.status === "DISMISSED" ? "DISMISSED" : "RESOLVED";
      this.store.resolveContradiction(id, status, body.resolution, "founder");
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: `productivity.contradiction.${status.toLowerCase()}`,
        entity_type: "contradictions",
        entity_id: id,
        detail_json: JSON.stringify({ resolution: body.resolution }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, id, status });
    }
    if (path === "/api/productivity/metrics" && method === "GET") {
      dailyRollup(this.store);
      return json({ metrics: this.store.listProductivityMetrics(14) });
    }

    // ---------------------------------------------------------------------
    // Full data bundle + domain mutations (powers the console's deep views).
    // One bounded request so the console can render all views without
    // hammering the DO (keeps the SQLite row budget happy).
    // ---------------------------------------------------------------------
    if (path === "/api/data/all" && method === "GET") {
      return json(this.buildDataBundle());
    }

    // Pipeline gates (PATCH) â€” founder/agent updates a single gate.
    const gateMatch = /^\/api\/pipeline\/gates\/([^/]+)$/.exec(path);
    if (gateMatch && method === "PATCH") {
      const body = (await readBody<{ status?: string; note?: string }>(request).catch(() => ({}))) as { status?: string; note?: string };
      const id = decodeURIComponent(gateMatch[1]!);
      const gate = this.store.listPipelineGates().find((g) => g.id === id);
      if (!gate) return json({ error: "Gate not found" }, 404);
      if (body.status && !["NOT_STARTED", "IN_PROGRESS", "PASSED", "FAILED", "BLOCKED", "SHIPPED"].includes(body.status)) {
        return json({ error: `Invalid gate status: ${body.status}` }, 400);
      }
      this.store.updatePipelineGate(id, { status: (body.status as never) ?? gate.status });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "pipeline.gate_update",
        entity_type: "pipeline_gates",
        entity_id: id,
        detail_json: JSON.stringify({ status: body.status, note: body.note }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, gate: this.store.listPipelineGates().find((g) => g.id === id) });
    }

    // Calendar
    if (path === "/api/calendar" && method === "GET") {
      return json({ events: this.store.listCalendarEvents(undefined, undefined, 200) });
    }
    if (path === "/api/calendar" && method === "POST") {
      const body = (await readBody<{ title?: string; startAt?: string; endAt?: string; allDay?: boolean; location?: string }>(request).catch(() => ({}))) as { title?: string; startAt?: string; endAt?: string; allDay?: boolean; location?: string };
      if (!body.title || !body.startAt) return json({ error: "title and startAt required" }, 400);
      const now = nowIso();
      this.store.createCalendarEvent({
        id: newId("cal"),
        title: body.title,
        start_at: body.startAt,
        end_at: body.endAt ?? body.startAt,
        all_day: body.allDay ? 1 : 0,
        location: body.location,
        attendees_json: "[]",
        status: "SCHEDULED",
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true });
    }
    const calDelete = /^\/api\/calendar\/([^/]+)$/.exec(path);
    if (calDelete && method === "DELETE") {
      return json({ deleted: this.store.deleteCalendarEvent(decodeURIComponent(calDelete[1]!)) });
    }

    // Notes
    if (path === "/api/notes" && method === "GET") return json({ notes: this.store.listNotes(200) });
    if (path === "/api/notes" && method === "POST") {
      const body = (await readBody<{ title?: string; body?: string; pinned?: boolean }>(request).catch(() => ({}))) as { title?: string; body?: string; pinned?: boolean };
      if (!body.title) return json({ error: "title required" }, 400);
      const now = nowIso();
      this.store.createNote({
        id: newId("note"),
        title: body.title,
        body: body.body ?? "",
        tags_json: "[]",
        pinned: body.pinned ? 1 : 0,
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true });
    }
    if (path === "/api/notes/:id" && method === "DELETE") {
      return json({ deleted: this.store.deleteNote(path.split("/")[3]!) });
    }

    // Reminders
    if (path === "/api/reminders" && method === "GET") return json({ reminders: this.store.listReminders({ limit: 100 }) });
    if (path === "/api/reminders" && method === "POST") {
      const body = (await readBody<{ title?: string; dueAt?: string }>(request).catch(() => ({}))) as { title?: string; dueAt?: string };
      if (!body.title || !body.dueAt) return json({ error: "title and dueAt required" }, 400);
      const now = nowIso();
      this.store.createReminder({
        id: newId("rem"),
        title: body.title,
        due_at: body.dueAt,
        done: 0,
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true });
    }
    if (path === "/api/reminders/:id/done" && method === "POST") {
      this.store.updateReminder(decodeURIComponent(path.split("/")[3]!), { done: 1, done_at: nowIso() });
      return json({ ok: true });
    }
    if (path === "/api/reminders/:id" && method === "DELETE") {
      return json({ deleted: this.store.deleteReminder(path.split("/")[3]!) });
    }

    // Contacts
    if (path === "/api/contacts" && method === "GET") return json({ contacts: this.store.listContacts() });

    // Outreach pipeline (growth â€” migration v35). Founder-authenticated API.
    if (path === "/api/outreach/prospects" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({ prospects: this.store.listProspects({ status: status ?? undefined }), counts: this.store.countProspectsByStatus() });
    }
    if (path === "/api/outreach/prospects" && method === "POST") {
      const body = (await readBody<{ name?: string; platform?: string; handle?: string; email?: string; url?: string; notes?: string; source?: string }>(request).catch(() => ({}))) as { name?: string; platform?: string; handle?: string; email?: string; url?: string; notes?: string; source?: string };
      const name = String(body.name ?? "").trim().slice(0, 120);
      const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "name and a valid email are required" }, 400);
      if (this.store.findProspectByEmail(email)) return json({ error: "prospect with this email already exists" }, 409);
      const at = nowIso();
      const prospect = {
        id: newId("pr"),
        name,
        platform: (String(body.platform ?? "other").trim().toLowerCase() || "other").slice(0, 40),
        handle: body.handle ? String(body.handle).trim().slice(0, 120) : null,
        email,
        url: body.url ? String(body.url).trim().slice(0, 300) : null,
        status: "NEW",
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
        source: String(body.source ?? "api").slice(0, 40),
        last_touch_at: null,
        created_at: at,
        updated_at: at,
      };
      this.store.createProspect(prospect);
      this.store.insertAudit({ id: newId("aud"), actor: "founder", action: "outreach.prospect_added", entity_type: "prospects", entity_id: prospect.id, detail_json: JSON.stringify({ platform: prospect.platform, source: prospect.source }), source: "api", created_at: at, updated_at: at });
      return json({ ok: true, prospect });
    }
    if (path.startsWith("/api/outreach/prospects/") && method === "PATCH") {
      const id = path.split("/")[4] ?? "";
      const body = (await readBody<{ status?: string; notes?: string }>(request).catch(() => ({}))) as { status?: string; notes?: string };
      const updated = this.store.updateProspect(id, {
        ...(body.status ? { status: String(body.status).toUpperCase().slice(0, 20) } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ? String(body.notes).slice(0, 2000) : null } : {}),
      });
      if (!updated) return json({ error: "Prospect not found" }, 404);
      return json({ ok: true, prospect: updated });
    }
    if (path === "/api/outreach/send" && method === "POST") {
      const body = (await readBody<{ prospectId?: string; template?: string }>(request).catch(() => ({}))) as { prospectId?: string; template?: string };
      if (!body.prospectId) return json({ error: "prospectId required" }, 400);
      const r = await sendOutreachNow(this.store, this.env, String(body.prospectId), body.template ? String(body.template) : undefined);
      return json(r, r.ok ? 200 : 400);
    }
    if (path === "/api/outreach/cycle" && method === "POST") {
      return json(await runOutreachCycle(this.store, this.env, "api"));
    }
    if (path === "/api/outreach/replies" && method === "GET") {
      return json({ replies: this.store.listProspectReplies(50) });
    }
    if (path === "/api/outreach/config" && method === "POST") {
      const body = (await readBody<{ enabled?: boolean }>(request).catch(() => ({}))) as { enabled?: boolean };
      this.store.setSetting("outreach_enabled", body.enabled ? "1" : "0");
      const at = nowIso();
      this.store.insertAudit({ id: newId("aud"), actor: "founder", action: "outreach.config", entity_type: "settings", entity_id: "outreach_enabled", detail_json: JSON.stringify({ enabled: Boolean(body.enabled) }), source: "api", created_at: at, updated_at: at });
      return json({ ok: true, enabled: Boolean(body.enabled) });
    }
    if (path === "/api/outreach/report" && method === "GET") {
      const today = nowIso().slice(0, 10);
      return json({
        enabled: this.store.getSetting("outreach_enabled") === "1",
        providerConfigured: emailConfigured(this.env),
        dailyCap: outreachDailyCap(this.env.OUTREACH_DAILY_CAP),
        sentToday: this.store.outreachSentCount(today),
        counts: this.store.countProspectsByStatus(),
        testProspects: this.store.countTestProspects(),
        countsAll: this.store.countProspectsByStatus(true),
        recentTouches: this.store.listOutreachTouches(20),
        recentReplies: this.store.listProspectReplies(10),
        autoRepliesToday: this.store.countTouchesByTemplateToday("auto_reply", today),
        templates: OUTREACH_TEMPLATES.map((t) => ({ id: t.id, subject: t.subject })),
      });
    }
    if (path === "/api/contacts" && method === "POST") {
      const body = (await readBody<{ name?: string; role?: string; company?: string; email?: string; phone?: string }>(request).catch(() => ({}))) as { name?: string; role?: string; company?: string; email?: string; phone?: string };
      if (!body.name) return json({ error: "name required" }, 400);
      const now = nowIso();
      this.store.createContact({
        id: newId("ctc"),
        name: body.name,
        role: body.role ?? "",
        company: body.company ?? "",
        email: body.email ?? "",
        phone: body.phone ?? "",
        tags_json: "[]",
        notes: "",
        source: "founder",
        created_at: now,
        updated_at: now,
      });
      return json({ ok: true });
    }

    // Agent runs (long-horizon)
    if (path === "/api/agents/runs" && method === "GET") {
      return json({ runs: this.store.listAgentRuns(50) });
    }
    const runContinue = /^\/api\/agents\/runs\/([^/]+)\/continue$/.exec(path);
    if (runContinue && method === "POST") {
      const id = decodeURIComponent(runContinue[1]!);
      // Any run by id â€” the old top-100-window scan 404'd old runs even when
      // they existed (and the window shrank as more runs were recorded).
      const run = this.store.getAgentRun(id);
      if (!run) return json({ error: "Run not found" }, 404);
      if (run.status === "RUNNING") return json({ error: "Run is already RUNNING" }, 409);
      // Never re-execute work whose task is already closed: that spends money
      // on a finished outcome and puts a stale checkpoint back on the wire.
      const runTask = run.task_id ? this.store.getTask(run.task_id) : null;
      if (runTask && (runTask.status === "DONE" || runTask.status === "CANCELLED")) {
        return json({ error: `Task ${runTask.id} is ${runTask.status} â€” nothing to continue; create a new task instead` }, 409);
      }
      this.store.resetAgentRun(id);
      // Actually re-execute the reopened run instead of leaving it RUNNING
      // forever (the old behaviour just let it get reaped again).
      this.state.waitUntil(executeAgentRun(this.store, this.buildRegistry(), this.env, { ...run, status: "RUNNING" }));
      return json({ ok: true, id });
    }

    // Local agent health beacon (daemon pings every ~30s).
    if (path === "/api/local-agent/heartbeat" && method === "POST") {
      const body = (await readBody<{ host?: string; version?: string; pid?: string; claimed?: boolean; agent_id?: string }>(request).catch(() => ({}))) as { host?: string; version?: string; pid?: string; claimed?: boolean; agent_id?: string };
      // Each physical runtime registers under its own instance id (validated;
      // role is pinned â€” a heartbeat can never grant itself a role).
      const agentId = resolveDaemonAgentId(body.agent_id);
      this.store.upsertLocalAgentHeartbeat({ host: body.host, version: body.version, pid: body.pid, claimed: body.claimed, id: agentId });
      // AOrgI registry: the daemon is a real runtime instance â€” register it
      // (software-engineering role: it executes local build/render/tooling
      // capability) with the same heartbeat so org liveness is honest.
      this.store.upsertOrgAgent({
        id: agentId,
        roleId: "role_software_engineering",
        kind: "local",
        model: "deepseek-v4",
        host: body.host ?? agentId,
        version: body.version,
        capabilitiesJson: JSON.stringify(["machine_maintenance"]),
      });
      return json({ ok: true, lastSeen: nowIso(), agentId });
    }

    // Local machine daemon bridge
    if (path === "/api/local-tasks" && method === "GET") {
      return json({ tasks: this.store.listLocalTasks(50) });
    }
    // Founder override: queue work for the always-on machine by hand. Goes
    // through the same dispatch policy as the agent, so a duplicate or a
    // repeated research pass is refused with the reason (and the existing id).
    if (path === "/api/local-tasks" && method === "POST") {
      const body = (await readBody<{ prompt?: string; taskId?: string; machine_maintenance?: boolean }>(request).catch(() => ({}))) as { prompt?: string; taskId?: string; machine_maintenance?: boolean };
      if (!body.prompt || !body.prompt.trim()) return json({ error: "prompt required" }, 400);
      // Execution boundary (spec §2.3): engineering work never queues for a
      // machine — it must be dispatched remotely (GitHub Actions).
      const boundary = classifyLocalWork(body.prompt.trim(), body.machine_maintenance === true);
      if (!boundary.local_allowed) {
        return json({ ok: false, refused: true, code: "REMOTE_ONLY", boundary: boundary.reason }, 409);
      }
      const decision = prepareDispatch(this.store, { prompt: body.prompt.trim(), taskId: body.taskId });
      if (!decision.ok) {
        return json({ ok: false, refused: true, code: decision.code, existingId: decision.existingId, error: decision.error }, 409);
      }
      const id = newId("ltk");
      const at = nowIso();
      this.store.createLocalTask({
        id,
        created_at: at,
        updated_at: at,
        source: "founder",
        task_id: body.taskId,
        prompt: decision.prompt,
        status: "PENDING",
        execution_target: boundary.target,
        meta_json: JSON.stringify({ investigation: decision.investigation, original_prompt: body.prompt.trim(), execution_target: boundary.target }),
      });
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "local_tasks.dispatch",
        entity_type: "local_tasks",
        entity_id: id,
        detail_json: JSON.stringify({ task_id: body.taskId ?? null, discovery: decision.investigation, execution_target: boundary.target }),
        source: "api",
        created_at: at,
        updated_at: at,
      });
      return json({ ok: true, taskId: id, discovery: decision.investigation, execution_target: boundary.target });
    }
    if (path === "/api/local-tasks/claim" && method === "POST") {
      const body = (await readBody<{ claimer?: string }>(request).catch(() => ({}))) as { claimer?: string };
      const task = this.store.claimLocalTask(body.claimer ?? "api");
      return task
        ? json({ ok: true, task })
        : json({ ok: true, task: null, boundary: "machine maintenance only — engineering work is remote-only (GitHub Actions)" });
    }
    if (path === "/api/local-tasks/heartbeat" && method === "POST") {
      const body = (await readBody<{ id?: string; status?: string }>(request).catch(() => ({}))) as { id?: string; status?: string };
      this.store.heartbeatLocalTask(body.id ?? "", (body.status ?? "RUNNING") as never);
      return json({ ok: true });
    }
    if (path === "/api/local-tasks/finish" && method === "POST") {
      const body = (await readBody<{ id?: string; status?: string; result?: string; error?: string; agent_id?: string }>(request).catch(() => ({}))) as { id?: string; status?: string; result?: string; error?: string; agent_id?: string };
      this.store.finishLocalTask(body.id ?? "", (body.status === "FAILED" ? "FAILED" : "DONE") as never, body.result, body.error);
      // AOrgI Phase 2 â€” every finished local task is real evidence and a real
      // protocol message, not theater: trust for the daemon's local-execution
      // capability moves with measured outcomes; the COA receives a RESULT
      // (or DEVIATION on failure) message tied to the task.
      // Attribute the outcome to the instance that finished (two-runtime
      // honesty, AOrgI Â§7) â€” never to a hardcoded default.
      this.store.recordTrustEvidence(resolveDaemonAgentId(body.agent_id), "local_execution", body.status !== "FAILED");
      this.store.sendOrgMessage({
        fromRole: "role_software_engineering",
        toRole: "role_coa",
        type: body.status === "FAILED" ? "DEVIATION" : "RESULT",
        taskId: body.id ?? undefined,
        payload: { status: body.status === "FAILED" ? "FAILED" : "DONE", error: body.error ?? null },
      });
      return json({ ok: true });
    }
    if (path === "/api/local-tasks/requeue" && method === "POST") {
      const body = (await readBody<{ match?: string; exclude?: string; limit?: number }>(request).catch(() => ({}))) as { match?: string; exclude?: string; limit?: number };
      const ids = this.store.requeueLocalTasks(body);
      this.store.insertAudit({
        id: newId("aud"),
        actor: "founder",
        action: "local_tasks.requeue",
        entity_type: "local_tasks",
        entity_id: "bulk",
        detail_json: JSON.stringify({ match: body.match ?? "tool-call limit", count: ids.length, ids }),
        source: "api",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return json({ ok: true, requeued: ids.length, ids });
    }

    return json({ error: "Not found", path }, 404);
  }

  // -- chat ------------------------------------------------------------------

  private async handleChat(request: Request): Promise<Response> {
    const body = (await readBody<{
      message?: string;
      sessionId?: string;
      stream?: boolean;
      model?: string;
      attachments?: Array<{ id?: string; name?: string; kind?: string }>;
    }>(request).catch(() => ({}))) as {
      message?: string;
      sessionId?: string;
      stream?: boolean;
      model?: string;
      attachments?: Array<{ id?: string; name?: string; kind?: string }>;
    };
    const message = (body.message ?? "").trim();
    if (!message) return json({ error: "message required" }, 400);
    const sessionId = body.sessionId ?? "default";
    // Attachments were uploaded to /api/files first; the manifest lets the
    // agent read them back with executive.get_file (audit gap 11).
    const manifest = attachmentManifest(body.attachments);
    const content = manifest ? `${message}\n\n${manifest}` : message;
    const now = nowIso();
    this.store.insertChatMessage({ id: newId("msg"), session_id: sessionId, role: "user", content, source: "founder", created_at: now, updated_at: now });
    return this.runChatReply(sessionId, normalizeChatModel(body.model), body.stream === true);
  }

  /** Start a turn: stream into a new chat_streams row, or run it synchronously. */
  private async runChatReply(sessionId: string, model: string, stream: boolean): Promise<Response> {
    if (stream) {
      const streamId = newId("str");
      this.store.openChatStream(streamId, sessionId, nowIso());
      const promise = this.executeChatTurn(sessionId, model, streamId);
      const holder = this.state as unknown as { waitUntil?: (p: Promise<unknown>) => void };
      if (holder.waitUntil) holder.waitUntil(promise);
      else void promise;
      return json({ ok: true, streamId, sessionId, model });
    }
    try {
      const result = await this.executeChatTurn(sessionId, model, null);
      return json({ ok: true, reply: result.text, iterations: result.iterations, toolsCalled: result.toolsCalled, cancelled: result.cancelled });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  /** Model context for a session: system prompt + the last 40 stored messages. */
  private chatContext(sessionId: string): ChatMsg[] {
    const messages: ChatMsg[] = [buildSystemContext(this.env)];
    for (const m of this.store.listChatMessagesTail(sessionId, 40)) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content });
    }
    return messages;
  }

  /**
   * Execute one chat turn with real provider streaming (gap 1), codepoint-safe
   * frame batching (gap 26) and true cancellation (gap 6). Persists the
   * assistant message â€” including a partial answer when the founder stopped
   * mid-reply â€” and best-effort names a brand-new conversation (gap 26).
   */
  private async executeChatTurn(
    sessionId: string,
    model: string,
    streamId: string | null,
  ): Promise<{ text: string; iterations: number; toolsCalled: number; cancelled: boolean }> {
    const registry = this.buildRegistry();
    const messages = this.chatContext(sessionId);
    const controller = new AbortController();
    if (streamId) this.chatAborts.set(streamId, controller);

    // Frames are JSON ({text}/{reasoning}/{status}/{cancelled}) so the relay can
    // pass them straight through. They are batched (one write per ~200ms, not
    // per token) and a flush never splits a UTF-16 surrogate pair â€” splitting
    // one would decode as mojibake / U+FFFD mid-emoji.
    let queue: string[] = [];
    let pending = "";
    let lastFlush = Date.now();
    let partial = "";
    const push = (frame: Record<string, unknown>) => { queue.push(JSON.stringify(frame)); };
    const drain = () => {
      if (streamId && queue.length > 0) {
        this.store.appendChatStreamChunks(streamId, queue);
        queue = [];
      }
    };
    const flush = (force = false) => {
      if (pending.length === 0) return;
      if (!force && pending.length < 400 && Date.now() - lastFlush < 200) return;
      let text = pending;
      let held = "";
      const lastUnit = text.charCodeAt(text.length - 1);
      if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
        held = text.slice(-1);
        text = text.slice(0, -1);
      }
      pending = held;
      if (text.length > 0) push({ text });
      lastFlush = Date.now();
      drain();
    };

    let cancelled = false;
    let text = "";
    let iterations = 0;
    let toolsCalled = 0;
    try {
      const result = await agentLoop({
        store: this.store,
        registry,
        env: this.env,
        sessionId,
        model,
        messages,
        maxIterations: 8,
        signal: controller.signal,
        onDelta: streamId
          ? (d) => {
              if (d.text) { partial += d.text; pending += d.text; flush(); }
              if (d.reasoning) { push({ reasoning: d.reasoning }); drain(); }
            }
          : undefined,
        onStatus: streamId ? (s) => { push({ status: s.label, tool: s.tool }); drain(); } : undefined,
      });
      text = result.text;
      iterations = result.iterations;
      toolsCalled = result.toolsCalled;
    } catch (err) {
      if (!controller.signal.aborted) {
        flush(true);
        const message = err instanceof Error ? err.message : String(err);
        if (streamId) {
          push({ error: message });
          drain();
          this.store.completeChatStream(streamId, message);
          this.chatAborts.delete(streamId);
        }
        throw err;
      }
      // Stopped by the founder: keep what they already saw and mark the stream
      // cancelled so the UI says "stopped", not "failed" (gap 6).
      cancelled = true;
      text = partial;
      if (streamId) push({ cancelled: true });
    }

    flush(true);
    drain();
    if (streamId) {
      this.chatAborts.delete(streamId);
      this.store.completeChatStream(streamId);
    }

    const answer = text.trim().length > 0 ? text : "";
    if (answer.length > 0) {
      const now = nowIso();
      this.store.insertChatMessage({
        id: newId("msg"), session_id: sessionId, role: "assistant", content: answer, model, source: "executive", created_at: now, updated_at: now,
      });
    }
    this.maybeGenerateTitle(sessionId, messages, answer);
    return { text: answer, iterations, toolsCalled, cancelled };
  }

  /**
   * LLM auto-title (gap 26): one cheap, tool-less call to name a brand-new
   * conversation. Skipped when a title already exists (a founder rename wins)
   * and never throws â€” a missing title is cosmetic.
   */
  private maybeGenerateTitle(sessionId: string, transcript: ChatMsg[], reply: string): void {
    try {
      if (this.store.getChatSessionTitle(sessionId)) return;
      const firstUser = transcript.find((m) => m.role === "user")?.content ?? "";
      if (!firstUser.trim() || !reply.trim()) return;
      const apiKeys = deepseekKeys(this.env);
      if (apiKeys.length === 0) return;
      const promise = (async () => {
        for (const apiKey of apiKeys) {
        try {
          const out = await callDeepSeek(
            apiKey,
            [
              { role: "system", content: "You name chat threads. Reply with 2-5 words. No quotes, no trailing punctuation, no 'chat about'." },
              { role: "user", content: `First message: ${firstUser.slice(0, 300)}\nAnswer summary: ${reply.slice(0, 500)}\n\nTitle:` },
            ],
            this.buildRegistry(),
            // The real store, not an empty function. An unmetered title call is real
            // provider spend that no meter ever sees â€” the same defect class as
            // the budget/ledger split, at a smaller scale.
            this.store,
            "deepseek-chat",
            { noTools: true, sessionId },
          );
          const title = sanitizeChatTitle(String(out.content ?? ""));
          if (title.length >= 3) this.store.setChatSessionTitle(sessionId, title, "auto");
          return;
        } catch (err) {
          if (!isDeepseekKeyFailure(err)) return; // a 400 would fail on the fallback too
        }
        }
      })();
      this.state.waitUntil(promise);
    } catch {
      /* cosmetic */
    }
  }

  private async handleFileUpload(request: Request): Promise<Response> {
    const body = (await readBody<{ name?: string; mime?: string; dataBase64?: string }>(request).catch(() => ({}))) as { name?: string; mime?: string; dataBase64?: string };
    const name = (body.name ?? "").trim();
    if (!name) return json({ error: "name required" }, 400);
    if (!body.dataBase64) return json({ error: "dataBase64 required" }, 400);
    if (body.dataBase64.length > 15_000_000) return json({ error: "file too large (max ~11 MB decoded)" }, 413);
    const mime = body.mime ?? "application/octet-stream";
    const now = nowIso();
    this.store.createUploadedFile({
      id: newId("up"),
      name,
      mime,
      size_bytes: Math.round((body.dataBase64.length * 3) / 4),
      data_base64: body.dataBase64,
      kind: kindFromMime(mime),
      source: "founder",
      created_at: now,
      updated_at: now,
    });
    const f = this.store.listUploadedFiles(1)[0];
    return json({ ok: true, fileId: f!.id, kind: f!.kind, sizeBytes: f!.size_bytes });
  }

  // -- auth handlers ----------------------------------------------------------

  private async handleLogin(request: Request): Promise<Response> {
    const body = (await readBody<{ username?: string; password?: string }>(request).catch(() => ({}))) as { username?: string; password?: string };
    const creds = this.store.getFounderCredentials();
    if (!creds) {
      return json({ error: "No founder account configured. Use POST /api/auth/bootstrap (with the FOUNDER_AUTH_TOKEN) to create one." }, 401);
    }
    const now = new Date().toISOString();
    if (creds.locked_until && creds.locked_until > now) {
      return json({ error: "Account temporarily locked after repeated failures. Try again later." }, 423);
    }
    if (creds.username === (body.username ?? "") && (await verifyPassword(body.password ?? "", creds.password_hash))) {
      this.store.updateFounderCredentials({ failed_attempts: 0, locked_until: null });
      const token = crypto.randomUUID();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      this.store.createSession({ token, username: creds.username, expires_at: expires });
      return json({ ok: true, token, expiresAt: expires });
    }
    const attempts = (creds.failed_attempts ?? 0) + 1;
    this.store.updateFounderCredentials({
      failed_attempts: attempts,
      locked_until: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : undefined,
    });
    return json({ error: "Invalid credentials" }, 401);
  }

  private async handleBootstrap(request: Request): Promise<Response> {
    const body = (await readBody<{ username?: string; password?: string }>(request).catch(() => ({}))) as { username?: string; password?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    if (username.length < 3) return json({ error: "username must be at least 3 characters" }, 400);
    if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);
    this.store.setFounderCredentials({ username, password_hash: await hashPassword(password) });
    return json({ ok: true, note: "Founder credentials configured. Log in via /api/auth/login." });
  }

  /**
   * Change the Founder password. Requires an authenticated session/token so
   * only the Founder (or someone with API access) can rotate it. The current
   * password must be verified; the new password replaces it and any other
   * active sessions are invalidated so a stolen session dies immediately.
   */
  private async handleChangePassword(request: Request): Promise<Response> {
    const body = (await readBody<{ currentPassword?: string; newPassword?: string }>(request).catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
    const creds = this.store.getFounderCredentials();
    if (!creds) return json({ error: "No founder account configured." }, 401);
    const newPassword = body.newPassword ?? "";
    if (newPassword.length < 4) return json({ error: "new password must be at least 4 characters" }, 400);
    if (!(await verifyPassword(body.currentPassword ?? "", creds.password_hash))) {
      return json({ error: "Current password is incorrect" }, 401);
    }
    this.store.setFounderCredentials({ username: creds.username, password_hash: await hashPassword(newPassword) });
    // Invalidate every session except the caller's so other logged-in devices
    // must re-authenticate with the new password.
    const caller = request.headers.get("Authorization") || "";
    const callerToken = caller.startsWith("Bearer ") ? caller.slice(7) : null;
    this.store.deleteSessionsExcept(callerToken);
    this.store.insertAudit({
      id: newId("aud"),
      actor: "founder",
      action: "auth.password_changed",
      entity_type: "founder_credentials",
      entity_id: creds.id,
      detail_json: JSON.stringify({ note: "Founder rotated password; other sessions invalidated." }),
      source: "api",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    return json({ ok: true, note: "Password changed. Other sessions were signed out." });
  }

  private async handleLogout(request: Request): Promise<Response> {
    const header = request.headers.get("Authorization") || "";
    if (header.startsWith("Bearer ")) this.store.deleteSession(header.slice(7));
    return json({ ok: true });
  }
}

// ---------------------------------------------------------------------------
// Chat SSE relay (worker-level): forwards the DO-buffered agent reply to the
// browser as Server-Sent Events. The DO runs the agent loop and buffers
// deltas into chat_streams; we poll it and push `data:` events, ending with
// `event: done`. The caller's auth header is forwarded for each poll.
// ---------------------------------------------------------------------------

async function handleChatSse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const streamId = url.searchParams.get("streamId") ?? "";
  const auth = request.headers.get("Authorization") ?? "";
  // Resume support (gap 7): the client reconnects with `after` = the number of
  // frames it already consumed, so a dropped connection loses nothing.
  const resumeAfter = Math.max(0, Number(url.searchParams.get("after")) || 0);
  if (!streamId) return json({ error: "streamId required" }, 400);

  const id = env.EXECUTIVE_AGENT.idFromName("zarlino");
  const stub = env.EXECUTIVE_AGENT.get(id);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let after = resumeAfter;
      // Tool loops legitimately run for minutes; 5 min used to cut replies off.
      const timeout = 10 * 60 * 1000;
      const started = Date.now();
      try {
        // Poll the DO's buffered stream until it completes.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (Date.now() - started > timeout) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "stream timeout" })}\n\n`));
            break;
          }
          const res = await stub.fetch(
            new Request(`https://executive.internal/api/chat/stream?streamId=${encodeURIComponent(streamId)}&after=${after}`, {
              headers: { Authorization: auth },
            }),
          );
          if (!res.ok) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: `HTTP ${res.status}` })}\n\n`));
            break;
          }
          const data = (await res.json()) as { chunks: string[]; nextIndex: number; complete: boolean; error?: string };
          for (const chunk of data.chunks ?? []) {
            // Frames are stored pre-encoded ({"text":â€¦}/{"reasoning":â€¦}/{"status":â€¦}/{"cancelled":true}).
            // Legacy rows hold raw strings â€” wrap those so old streams still work.
            let frame = chunk;
            try {
              JSON.parse(chunk);
            } catch {
              frame = JSON.stringify({ text: chunk });
            }
            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          }
          after = data.nextIndex ?? after;
          if (data.complete) {
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ error: data.error ?? null })}\n\n`));
            break;
          }
          // Tighter cadence so streamed tokens land promptly; the DO batches
          // writes at ~200ms so this does not hammer the database.
          await new Promise((r) => setTimeout(r, 150));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`));
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      /* client disconnected â€” stop polling (the DO keeps working; POST /api/chat/stop cancels that) */
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Continuity ops (Phase 0, 2026-10-02): cloud backup + external monitoring
// ---------------------------------------------------------------------------

/** Founder-token gate for the on-demand ops routes (worker-side). */
function opsAuthorized(request: Request, env: Env): boolean {
  const expected = env.FOUNDER_AUTH_TOKEN;
  if (!expected) return false;
  return request.headers.get("Authorization") === `Bearer ${expected}`;
}

interface BackupResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  pruned?: number;
  error?: string;
}

/** Export the full OS snapshot from the DO and land it in R2 (kept 30 deep). */
async function runDailyBackup(env: Env, stub: DurableObjectStub): Promise<BackupResult> {
  if (!env.ARTIFACTS) return { ok: false, error: "R2 binding ARTIFACTS is not configured" };
  const secret = internalSecret(env);
  if (!secret) return { ok: false, error: "INTERNAL_SECRET is not configured — internal routes fail closed; set the worker secret" };
  const res = await stub.fetch(
    new Request("https://executive.internal/api/_backup-export", {
      method: "POST",
      headers: { [INTERNAL_HEADER]: secret },
    }),
  );
  if (!res.ok) return { ok: false, error: `snapshot export failed (HTTP ${res.status})` };
  const body = await res.text();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backups/db/${stamp}.json`;
  await env.ARTIFACTS.put(key, body, { httpMetadata: { contentType: "application/json" } });
  const listed = await env.ARTIFACTS.list({ prefix: "backups/db/" });
  const prune = planBackupPrune(listed.objects.map((o) => o.key), 30);
  for (const k of prune) await env.ARTIFACTS.delete(k);
  if (env.ZARLINO_KV) {
    await env.ZARLINO_KV.put(
      "backup:last",
      JSON.stringify({ at: stamp, key, bytes: body.length, pruned: prune.length }),
    );
  }
  return { ok: true, key, bytes: body.length, pruned: prune.length };
}

/** Shared user-agent for outbound monitor requests. */
const MONITOR_UA = "ZarlinoOS-Monitor/1.0";

/** GitHub API headers for monitor checks (token when configured). */
function monitorGithubHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": MONITOR_UA,
  };
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

/**
 * PRODUCTION_IDENTITY — compare the live website's reported commit
 * (/api/health) with the repo's current main SHA. This is the documented
 * PRODUCTION_DRIFT detector: stale production must never be silently healthy.
 * If either side cannot be read, the check is OK-with-note ("identity
 * unverified") rather than a fabricated failure — UNKNOWN, not certainty.
 */
async function checkProductionIdentity(env: Env): Promise<CheckResult> {
  const id = "site:identity";
  try {
    const [healthRes, mainRes] = await Promise.all([
      fetch(`${WEBSITE_BASE}/api/health`, { headers: { "user-agent": MONITOR_UA } }),
      fetch(`https://api.github.com/repos/${WEBSITE_REPO}/commits/main`, {
        headers: monitorGithubHeaders(env),
      }),
    ]);
    if (!healthRes.ok) {
      return { id, ok: false, status: healthRes.status, error: `website /api/health HTTP ${healthRes.status}` };
    }
    if (!mainRes.ok) {
      return { id, ok: true, status: 0, error: `identity unverified: GitHub API HTTP ${mainRes.status}` };
    }
    const health = (await healthRes.json()) as { commit?: string };
    const main = (await mainRes.json()) as { sha?: string };
    const commit = health.commit;
    const sha = main.sha;
    if (!commit || !sha) {
      return { id, ok: true, status: 0, error: "identity unverified: missing sha in response" };
    }
    if (commit === sha) return { id, ok: true, status: 200 };
    return {
      id,
      ok: false,
      status: 0,
      error: `PRODUCTION_DRIFT: production ${commit.slice(0, 12)} != main ${sha.slice(0, 12)}`,
    };
  } catch (e) {
    return { id, ok: true, status: 0, error: `identity unverified: ${String(e)}` };
  }
}

/**
 * DEPLOYMENT_FAILURE — the latest completed run of the website deploy workflow
 * on main. A failed deploy while main has moved on is a deployment failure
 * (distinct from an application failure, which the route targets catch).
 */
async function checkDeployWorkflow(env: Env): Promise<CheckResult> {
  const id = "site:deploy-workflow";
  try {
    const r = await fetch(
      `https://api.github.com/repos/${WEBSITE_REPO}/actions/workflows/deploy.yml/runs?branch=main&per_page=1`,
      { headers: monitorGithubHeaders(env) },
    );
    if (!r.ok) {
      return { id, ok: true, status: 0, error: `deployment check unverified: GitHub API HTTP ${r.status}` };
    }
    const data = (await r.json()) as {
      workflow_runs?: Array<{ id: number; status: string; conclusion: string | null }>;
    };
    const run = data.workflow_runs?.[0];
    if (!run) return { id, ok: true, status: 0, error: "deployment check unverified: no runs" };
    if (run.status !== "completed") return { id, ok: true, status: 200 };
    if (run.conclusion === "success") return { id, ok: true, status: 200 };
    return {
      id,
      ok: false,
      status: 0,
      error: `DEPLOYMENT_FAILED: latest main deploy run ${run.id} -> ${run.conclusion}`,
    };
  } catch (e) {
    return { id, ok: true, status: 0, error: `deployment check unverified: ${String(e)}` };
  }
}

/** Check the external surfaces + bridge liveness; alert on transitions only. */
async function runExternalChecks(
  env: Env,
  stub: DurableObjectStub,
): Promise<{ checks: CheckResult[]; transitions: Array<{ id: string; to: string }>; balance?: number | null }> {
  const checks: CheckResult[] = [];

  // Website coverage comes from the site's OWN route contract (/api/contract),
  // so the OS can never infer website health from a partial, hand-maintained
  // subset of routes. Earlier monitoring probed ONLY the website homepage —
  // which stayed green for weeks while every non-asset path answered
  // Cloudflare 1101. If the contract cannot be fetched, essential fallback
  // coverage is probed AND site:contract fails loudly — never silent blindness.
  let siteTargets: MonitorTarget[];
  try {
    const cr = await fetch(`${WEBSITE_BASE}/api/contract`, {
      headers: { "user-agent": MONITOR_UA },
    });
    if (cr.ok) {
      const contract = (await cr.json()) as WebsiteContract;
      siteTargets = buildWebsiteTargets(contract);
      checks.push({ id: "site:contract", ok: true, status: cr.status });
    } else {
      siteTargets = [...WEBSITE_FALLBACK_TARGETS];
      checks.push({ id: "site:contract", ok: false, status: cr.status, error: `contract HTTP ${cr.status}` });
    }
  } catch (e) {
    siteTargets = [...WEBSITE_FALLBACK_TARGETS];
    checks.push({ id: "site:contract", ok: false, status: 0, error: String(e) });
  }

  const probeTargets = [...siteTargets, ...STATIC_TARGETS];
  for (const t of probeTargets) {
    try {
      const r = await fetch(t.url, {
        method: t.method,
        redirect: t.redirect ?? "follow",
        headers: { "user-agent": MONITOR_UA },
      });
      checks.push({ id: t.id, ok: r.status === t.expect, status: r.status });
    } catch (e) {
      checks.push({ id: t.id, ok: false, status: 0, error: String(e) });
    }
  }

  // STALE PRODUCTION / PRODUCTION_DRIFT: does production report the same
  // commit as main? A green route subset on an old artifact is drift, not
  // health. Unverifiable comparisons are recorded OK-with-note (UNKNOWN beats
  // fabricated certainty; a false DOWN would be noise).
  checks.push(await checkProductionIdentity(env));

  // DEPLOYMENT FAILURE: conclusion of the latest deploy run on main.
  checks.push(await checkDeployWorkflow(env));
  // Founder-channel (WhatsApp bridge) liveness from the KV heartbeat mirror.
  // Never-seen counts as OK (no false alarm right after a deploy); stale beyond
  // 20 minutes fails, so two consecutive 15-min checks (~30 min of silence)
  // raise the alert.
  const kv = env.ZARLINO_KV;
  let bridgeOk = true;
  if (kv) {
    const raw = await kv.get("bridge:last_seen");
    if (raw) {
      const seen = safeJson(raw, null) as { at?: string } | null;
      const age = seen?.at ? Date.now() - Date.parse(seen.at) : Infinity;
      bridgeOk = age <= 20 * 60 * 1000;
    }
  }
  checks.push({ id: "whatsapp-bridge", ok: bridgeOk, status: bridgeOk ? 200 : 0 });

  // DeepSeek balance sentinel (the "top up without me" piece): reads the live
  // balance, keeps it in KV for /api/ops/monitor, and alerts through BOTH
  // channels when it falls below AI_BALANCE_WARN_USD â€” at most once per 24h.
  let deepseekBalance: number | null = null;
  // Try every configured key: the primary may be exhausted while the fallback
  // key is funding lighter traffic (observed live 2026-10-11). The balance
  // endpoint answers 200 even for a drained account, so a funded key wins:
  // keep the first parsed value, but keep looking while it is <= 0.
  for (const key of deepseekKeys(env)) {
    try {
      const r = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) continue;
      const parsed = parseDeepSeekBalance(await r.json());
      if (parsed !== null) {
        deepseekBalance = parsed;
        if (parsed > 0) break;
      }
    } catch {
      /* balance check is best-effort; try the next key */
    }
  }
  if (kv && deepseekBalance !== null) {
    const warnAt = Number(env.AI_BALANCE_WARN_USD) > 0 ? Number(env.AI_BALANCE_WARN_USD) : 10;
    await kv.put("balance:deepseek", JSON.stringify({ at: new Date().toISOString(), usd: deepseekBalance, warnAt }));
    if (deepseekBalance < warnAt) {
      const last = await kv.get("balance:deepseek:notified");
      const age = last ? Date.now() - Date.parse(last) : Infinity;
      if (age > 24 * 3600 * 1000) {
        await notifyBoth(
          env,
          stub,
          `\u26A0\uFE0F DeepSeek balance low ($${deepseekBalance.toFixed(2)})`,
          `Below the $${warnAt} warning line. Top up at https://platform.deepseek.com/top_up (card form, ~2 minutes). Heavy agent work pauses automatically at $0.`,
          "NORMAL",
        );
        await kv.put("balance:deepseek:notified", new Date().toISOString());
      }
    }
  }

  const prev: Record<string, MonitorState | undefined> = {};
  if (kv) {
    for (const t of [...probeTargets.map((m) => m.id), "site:contract", "site:identity", "site:deploy-workflow", "whatsapp-bridge"]) {
      const raw = await kv.get(`monitor:${t}`);
      if (raw) prev[t] = safeJson(raw, undefined) as MonitorState | undefined;
    }
  }
  const now = new Date().toISOString();
  const { next, transitions } = evaluateChecks(prev, checks, now);
  if (kv) for (const s of next) await kv.put(`monitor:${s.id}`, JSON.stringify(s));

  const out: Array<{ id: string; to: string }> = [];
  for (const tr of transitions) {
    const state = next.find((s) => s.id === tr.id);
    const target = probeTargets.find((t) => t.id === tr.id);
    const subject = tr.to === "DOWN" ? `\uD83D\uDD34 ${tr.id} is DOWN` : `\u2705 ${tr.id} recovered`;
    const body =
      tr.to === "DOWN"
        ? `External check failed twice in a row (last HTTP ${state?.lastStatus ?? 0}).${target ? ` URL: ${target.url}.` : ""} The OS keeps running; this is an availability alert.`
        : `${tr.id} is responding again (HTTP ${state?.lastStatus ?? 0}).`;
    await notifyBoth(env, stub, subject, body, tr.to === "DOWN" ? "HIGH" : "NORMAL");
    if (kv) await kv.put(`monitor:notified:${tr.id}`, now);
    out.push({ id: tr.id, to: tr.to });
  }
  // Sustained-DOWN reminder: at most one every 6h per target.
  if (kv) {
    for (const s of next) {
      if (s.state !== "DOWN") continue;
      const last = await kv.get(`monitor:notified:${s.id}`);
      const age = last ? Date.now() - Date.parse(last) : Infinity;
      if (age > 6 * 3600 * 1000) {
        await notifyBoth(
          env,
          stub,
          `\u26A0\uFE0F still DOWN: ${s.id}`,
          `Still failing after repeated checks (last HTTP ${s.lastStatus}).`,
          "NORMAL",
        );
        await kv.put(`monitor:notified:${s.id}`, new Date().toISOString());
        out.push({ id: s.id, to: "DOWN_REMINDER" });
      }
    }
  }
  return { checks, transitions: out, balance: deepseekBalance };
}

/**
 * Alert through BOTH channels: the founder queue (WhatsApp bridge) and the
 * second, independent channel (ntfy) when ALERT_NTFY_URL is configured.
 */
async function notifyBoth(env: Env, stub: DurableObjectStub, subject: string, body: string, priority: string): Promise<void> {
  const secret = internalSecret(env);
  if (secret) {
    try {
      await stub.fetch(
        new Request("https://executive.internal/api/_alert", {
          method: "POST",
          headers: { [INTERNAL_HEADER]: secret, "content-type": "application/json" },
          body: JSON.stringify({ subject, body, priority }),
        }),
      );
    } catch {
      /* founder channel is best-effort; ntfy still fires */
    }
  }
  const ntfy = env.ALERT_NTFY_URL;
  if (ntfy) {
    try {
      await fetch(ntfy, {
        method: "POST",
        headers: {
          Title: subject,
          Priority: priority === "HIGH" ? "urgent" : "default",
          Tags: priority === "HIGH" ? "rotating_light" : "white_check_mark",
        },
        body,
      });
    } catch {
      /* second channel is best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // Continuity ops (founder-token authenticated): run/observe the cloud
    // backup and the external uptime monitor on demand. Worker-side (R2 + KV)
    // so the Durable Object is never woken just to answer monitoring.
    if (path === "/api/ops/backup" || path === "/api/ops/monitor") {
      if (!opsAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const opsId = env.EXECUTIVE_AGENT.idFromName("zarlino");
      const opsStub = env.EXECUTIVE_AGENT.get(opsId);
      if (path === "/api/ops/backup" && request.method === "POST") return json(await runDailyBackup(env, opsStub));
      if (path === "/api/ops/monitor" && request.method === "POST") return json(await runExternalChecks(env, opsStub));
      if (path === "/api/ops/monitor" && request.method === "GET") {
        const states: unknown[] = [];
        if (env.ZARLINO_KV) {
          // States are keyed per target id under `monitor:` — list them so the
          // view reflects the CURRENT target set (contract-derived), and never
          // a stale hard-coded list.
          const listed = await env.ZARLINO_KV.list({ prefix: "monitor:" });
          for (const k of listed.keys) {
            if (k.name.startsWith("monitor:notified:")) continue;
            const raw = await env.ZARLINO_KV.get(k.name);
            const id = k.name.replace(/^monitor:/, "");
            states.push(raw ? safeJson(raw, { id, state: "UNKNOWN" }) : { id, state: "UNKNOWN" });
          }
        }
        const last = env.ZARLINO_KV ? await env.ZARLINO_KV.get("backup:last") : null;
        const bal = env.ZARLINO_KV ? await env.ZARLINO_KV.get("balance:deepseek") : null;
        return json({ states, backup: last ? safeJson(last, null) : null, balance: bal ? safeJson(bal, null) : null });
      }
      return json({ error: "Method not allowed" }, 405);
    }
    // NOTE: /mcp must stay in this forward condition â€” the read-only MCP
    // plane lives on the DO, and dropping it 404s the whole plane (regression
    // guard in test/mcp.test.ts asserts this line).
    if (path.startsWith("/api/") || path === "/mcp") {
      // Chat SSE: stream the DO-buffered reply to the browser as real
      // Server-Sent Events (the DO runs the agent loop; we relay chunks).
      if (path === "/api/chat/sse" && request.method === "GET") {
        return handleChatSse(request, env);
      }
      const id = env.EXECUTIVE_AGENT.idFromName("zarlino");
      const stub = env.EXECUTIVE_AGENT.get(id);
      return stub.fetch(request);
    }
    // Serve the Founder web console from worker static assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: "Executive OS API only â€” build the console (npm run build:console) to enable assets." }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const id = env.EXECUTIVE_AGENT.idFromName("zarlino");
    const stub = env.EXECUTIVE_AGENT.get(id);
    // Every 15 min: external uptime checks (website, OS API, downloads, bridge
    // liveness). Reads KV only; the DO is woken solely on transitions/reminders.
    if (controller.cron === "*/15 * * * *") {
      try {
        await runExternalChecks(env, stub);
      } catch {
        /* the monitor must never throw */
      }
      // Factory builds are settled by backend truth (the published evidence
      // record, then the run, then the deadline), so this must happen whether or
      // not the customer still has the page open.
      try {
        const kick = internalSecret(env);
        if (kick) {
          await stub.fetch(
            new Request("https://executive.internal/api/_factory-reconcile", {
              method: "POST",
              headers: { [INTERNAL_HEADER]: kick },
            }),
          );
        }
      } catch {
        /* reconciliation must never throw */
      }
      controller.noRetry();
      return;
    }
    // Daily: export the whole OS database to R2 (kept 30 deep) â€” scheduled,
    // offsite, and independent of any local machine.
    if (controller.cron === "15 3 * * *") {
      try {
        await runDailyBackup(env, stub);
      } catch {
        /* retried on the next daily run */
      }
      controller.noRetry();
      return;
    }
    // Internal kick that runs doctor + auto-run + reschedules. Fail closed:
    // without INTERNAL_SECRET the DO refuses the kick, so skip it explicitly
    // instead of sending an unauthenticated request.
    const kickSecret = internalSecret(env);
    if (!kickSecret) {
      controller.noRetry();
      return;
    }
    await stub.fetch(
      new Request("https://executive.internal/api/_scheduled", {
        method: "POST",
        headers: { [INTERNAL_HEADER]: kickSecret },
      }),
    );
    controller.noRetry();
  },
};
