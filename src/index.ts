/**
 * Zarlino Executive OS — Worker entry.
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
import { collectiveMetrics, runChaosTest, runOrgAnalyst } from "./core/org/intelligence";
import { createTask } from "./core/tasks/model";
import { hashPassword, timingSafeEqual, verifyPassword } from "./core/auth/passwords";
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
import type { AgentRun, DoctorLog, Task } from "./types";
import type { ModelCallRecord as _M } from "./core/model/types";
type ModelCall = _M;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  EXECUTIVE_AGENT: DurableObjectNamespace;
  ZARLINO_KV?: KVNamespace;
  ASSETS?: Fetcher;
  DEEPSEEK_API_KEY?: string;
  FOUNDER_AUTH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  CF_API_TOKEN?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_CURRENCY?: string;
  ZARLINO_LICENSE_PRIVATE_KEY?: string;
  WEBSITE_URL?: string;
  AI_DAILY_BUDGET?: string;
  AI_MONTHLY_BUDGET?: string;
  AI_PER_TASK_BUDGET?: string;
  AI_PER_RUN_BUDGET?: string;
  DOCTOR_AUTOFIX?: string;
  MAX_AUTO_JOBS?: string;
  MAX_RUN_ITERATIONS?: string;
}

const INTERNAL_HEADER = "x-exec-internal";
const INTERNAL_SECRET = "zarlino-internal-scheduled";
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

function internal(request: Request): boolean {
  return request.headers.get(INTERNAL_HEADER) === INTERNAL_SECRET;
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

async function callDeepSeek(
  apiKey: string,
  messages: ChatMsg[],
  registry: ToolRegistry,
  recordCost: (c: ModelCall) => void,
  model = "deepseek-chat",
): Promise<ChatMsg> {
  // Tool names are sanitized for the wire (DeepSeek forbids dots in names).
  const tools = registry.functionSchemas();
  const started = Date.now();
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 2048,
      stream: false,
    }),
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
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  recordCost({
    provider: "deepseek",
    model,
    taskType: "chat",
    inputTokens,
    outputTokens,
    cost: (inputTokens / 1_000_000) * 0.27 + (outputTokens / 1_000_000) * 1.1,
    latencyMs,
    timestamp: new Date().toISOString(),
  });
  return message;
}

const SYSTEM_PROMPT = `You are the Zarlino Executive OS — the autonomous operator of Zarlino Audio, a small audio-plugins company (ZTame, ZScorch). You run the business through tools and a durable store.

Working rules:
1. Use tools to gather facts before asserting them. Never fabricate numbers (doctrine: HONEST_NUMBERS) — say UNKNOWN instead.
2. HIGH-risk / irreversible actions (spending money, deploys, cache purges) are gated behind Founder approval — never execute them yourself; request an approval or flag the Founder.
3. Audit-worthy actions are recorded automatically by the tool registry.
4. Keep replies concise and actionable. Use markdown for structure.
5. When the Founder asks, run the System Doctor (system.doctor) to check and repair the system; run maintenance (system.maintenance) when housekeeping is needed.
6. You can queue work for the LOCAL machine via executive.request_local_task / executive.delegate_idea and poll with executive.get_local_task.`;

function buildSystemContext(env: Env): ChatMsg {
  return {
    role: "system",
    content: `${SYSTEM_PROMPT}\n\nWebsite: ${env.WEBSITE_URL ?? "https://zarlinoaudio.com"}\nCurrency: ${env.PAYSTACK_CURRENCY ?? "GHS"}\nDaily AI budget: ${env.AI_DAILY_BUDGET ?? "5"}$\nMonthly AI budget: ${env.AI_MONTHLY_BUDGET ?? "80"}$`,
  };
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
  maxIterations?: number;
}): Promise<{ text: string; iterations: number; toolsCalled: number; limitReached: boolean }> {
  const apiKey = opts.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured — set it as a Worker secret.");
  const store = opts.store;
  const maxIter = opts.maxIterations ?? 8;
  const messages = [...opts.messages];
  const recordCost = (c: ModelCall) => {
    store.record({ ...c, sessionId: opts.sessionId, runId: opts.runId });
  };
  let iterations = 0;
  let toolsCalled = 0;
  // Keep the in-memory transcript bounded so very long runs don't overflow the
  // model context window (system + prompt head, recent tail).
  const prune = () => {
    if (messages.length > 100) {
      const head = messages.slice(0, 10);
      const tail = messages.slice(-70);
      messages.splice(0, messages.length, ...head, ...tail);
    }
  };

  for (let i = 0; i < maxIter; i++) {
    iterations++;
    // Keep the long-horizon run row alive + report live progress. Without
    // this, any run executing >15min was reaped as a "restart orphan" by the
    // Doctor's maintenance sweep even though it was actively working.
    if (opts.runId) store.heartbeatAgentRun(opts.runId, iterations, toolsCalled);
    const reply = await callDeepSeek(apiKey, messages, opts.registry, recordCost);
    messages.push(reply);
    const toolCalls = reply.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      for (const call of toolCalls) {
        toolsCalled++;
        // Map the provider-sanitized name back to the real tool before running.
        const realName = opts.registry.resolveName(call.function.name);
        // AOrgI §10 capability governance: agent → capability check →
        // governance check → autonomy check → tool. This loop is executed by
        // the registered `executive_do_01` instance (role_coa); DENY/REVIEW
        // blocks the tool and is reported back to the model + governance.
        const toolDef = opts.registry.getTool(realName);
        const capability = toolDef?.requiredPermission ?? "execute";
        const gate = store.capabilityVerdictForAgent("executive_do_01", capability, realName);
        if (gate.verdict !== "ALLOW") {
          // §11 hard-constraint handling: BLOCK → LOG → ESCALATE. The call is
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
      prune();
      if (opts.runId) store.checkpointAgentRun(opts.runId, JSON.stringify(messages));
      continue;
    }
    const text = String(reply.content ?? "");
    opts.onChunk?.(text);
    return { text, iterations, toolsCalled, limitReached: false };
  }
  // Ran out of iterations while still requesting tools — the caller decides
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
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}

// ---------------------------------------------------------------------------
// Auto-run sweep (automate fixing): start + execute auto-runnable tasks.
// ---------------------------------------------------------------------------

function startAutoRunnable(store: ExecutiveStore, maxJobs: number): { started: string[] } {
  const running = store.countRunningAgentRuns();
  const budget = Math.max(0, maxJobs - running);
  if (budget <= 0) return { started: [] };
  const tasks = store.listAutoRunnableTasks(budget * 3);
  const started: string[] = [];
  for (const t of tasks) {
    if (started.length >= budget) break;
    if (store.pendingApprovalForTask(t.id)) continue;
    if (store.hasRunningRunForTask(t.id)) continue;
    // Backoff: don't immediately re-spawn a run for a task whose last run just
    // failed (e.g. DeepSeek 402) — that would churn a run every wake.
    if (store.hasRecentFailedRunForTask(t.id)) continue;
    const now = nowIso();
    store.createAgentRun({
      id: newId("run"),
      task_id: t.id,
      prompt: `AUTO-RUN task: ${t.title}\n\n${t.description ?? ""}\n\nWork through PLAN → IMPLEMENT → VERIFY → REPORT using your tools, then mark the task DONE if the work is complete, or report what is blocking.`,
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
 * Resume resumable long-horizon runs — restart orphans (FAILED, 0 iterations —
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
  // their checkpoint (see resumeInterruptedRuns) — so a run can work all day,
  // bounded only by the AI spend gate, not an arbitrary call count.
  const maxIter = Math.max(1, Math.min(60, Number(env.MAX_RUN_ITERATIONS) || 40));
  try {
    // Resume from the durable checkpoint if one exists (keeps the transcript
    // across auto-continue sweeps instead of restarting from the bare prompt).
    let initial: ChatMsg[] = [buildSystemContext(env), { role: "user", content: run.prompt }];
    if (run.checkpoint_json) {
      try {
        const parsed = JSON.parse(run.checkpoint_json) as ChatMsg[];
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.role === "system") initial = parsed;
      } catch {
        /* malformed checkpoint — fall back to the prompt */
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
      // Not finished — keep it resumable; the sweep auto-continues it.
      // Deliberately NOT marking the task DONE (it isn't).
      store.finishAgentRun(run.id, "STOPPED", undefined, `Hit the ${maxIter}-iteration per-sweep limit — auto-continue scheduled.`);
      return;
    }
    store.finishAgentRun(run.id, "DONE", result.text);
    if (run.task_id) store.updateTask(run.task_id, { status: "DONE", completed_at: nowIso() } as never);
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
      : { lastRunAt: null, note: "Doctor has not run yet — it runs on DO wake." },
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

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = createDoSql(state.storage.sql);
    this.store = new ExecutiveStore(this.sql);
    this.state.blockConcurrencyWhile(async () => {
      this.store.migrate();
      // AOrgI registry: the DO runtime registers itself as the real instance
      // behind the Chief Operating Agent role (AOrgI §5, §7 — instances exist
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
    // Organizational analyst (AOrgI §36): self-observation on every sweep —
    // pure SQL computation, no model calls, cheap and safe.
    try {
      runOrgAnalyst(this.store, trigger);
    } catch {
      /* analyst must never break wake */
    }
    // Start + resume long-horizon runs (bounded, "automate fixing"). Runs are
    // executed on EVERY maintenance sweep — on wake via state.waitUntil (keeps
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
    // Arm the alarm WITHOUT deferring an already-pending one. Frequent cold
    // starts (console polls) used to re-arm it to +5min every wake, starving
    // the alarm path — the very reason auto-runs piled up un-executed.
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
    if (internal(request) && path === "/api/_scheduled") {
      await this.runWakeMaintenance("cron", { runAutoJobs: true });
      return json({ ok: true, trigger: "cron" });
    }

    // Public health (no auth) — minimal info for uptime monitors.
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

    // Auth (login is public; logout/status/change-password need a session/token).
    if (path === "/api/auth/login" && method === "POST") return this.handleLogin(request);
    if (!authorized(request, this.env, this.store)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (path === "/api/auth/logout" && method === "POST") return this.handleLogout(request);
    if (path === "/api/auth/status" && method === "GET") return json({ ok: true, authenticated: true });
    if (path === "/api/auth/bootstrap" && method === "POST") return this.handleBootstrap(request);
    if (path === "/api/auth/change-password" && method === "POST") return this.handleChangePassword(request);

    // Overview
    if (path === "/api/executive/overview" && method === "GET") {
      return json(buildOverview(this.store, this.env));
    }

    // Executive control — the Founder's kill-switches + autonomy dials.
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

    // Production reset — hands the whole company over to a new operator on a
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
      return json({ sessions: this.store.listChatSessions(50) });
    }
    if (path === "/api/chat/messages" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "default";
      return json({ messages: this.store.listChatMessages(sessionId, 200) });
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

    // Tasks
    if (path === "/api/tasks" && method === "GET") {
      return json({ tasks: this.store.listTasks({ limit: 100 }).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, project_id: t.project_id, created_at: t.created_at })) });
    }
    if (path === "/api/tasks" && method === "POST") {
      const body = (await readBody<{ title?: string; description?: string; priority?: string }>(request).catch(() => ({}))) as { title?: string; description?: string; priority?: string };
      if (!body.title || !body.title.trim()) return json({ error: "title required" }, 400);
      const task = createTask({ title: body.title, description: body.description, priority: body.priority as never, source: "founder" });
      this.store.insertTask(task);
      return json({ ok: true, id: task.id });
    }
    const taskPatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskPatch && method === "PATCH") {
      const id = decodeURIComponent(taskPatch[1]!);
      const task = this.store.getTask(id);
      if (!task) return json({ error: "Task not found" }, 404);
      const body = (await readBody<{ status?: string; priority?: string }>(request).catch(() => ({}))) as { status?: string; priority?: string };
      const patch: Partial<Task> = {};
      if (body.status) {
        if (!["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"].includes(body.status)) return json({ error: "Invalid status" }, 400);
        patch.status = body.status as never;
        if (body.status === "DONE") patch.completed_at = nowIso();
      }
      if (body.priority && ["P0", "P1", "P2", "P3"].includes(body.priority)) patch.priority = body.priority as never;
      this.store.updateTask(id, patch);
      return json({ ok: true });
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

    // Review queue — remote operator vetting of produced work (sound / UI / artifacts)
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
      if (typeof body.expected_version !== "number") return json({ error: "expected_version (number) required — READ the entry, then WRITE with its version (§14)" }, 400);
      const result = this.store.updateOrgMemory(id, {
        value: body.value,
        expectedVersion: body.expected_version,
        author: body.author as string | undefined,
      });
      if (result.status === "not_found") return json({ error: "Memory entry not found" }, 404);
      if (result.status === "conflict") {
        return json({ error: "ORG_MEMORY_CONFLICT", message: "Version mismatch — someone else wrote first. Re-read, merge, retry (§14: never silently overwrite).", current: result.record }, 409);
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

    // Evaluators (external human sensor network — NOT employees, spec §5)
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

    // Test registry (spec §6)
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

    // Results — APPEND-ONLY (spec §9): no PATCH/DELETE routes exist.
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

    // Product validation gates (spec §14)
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

    // Knowledge base (spec §27-29)
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

    // Failure taxonomy (spec §39)
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
        return json({ error: `Tool ${body.name} is ${tool.riskLevel} risk — pass confirm:true to execute.`, riskLevel: tool.riskLevel }, 403);
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
        recordCost: (c) => this.store.record(c),
      });
      return json(result);
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

    // Pipeline gates (PATCH) — founder/agent updates a single gate.
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
      const run = this.store.listAgentRuns(100).find((r) => r.id === id);
      if (!run) return json({ error: "Run not found" }, 404);
      this.store.resetAgentRun(id);
      // Actually re-execute the reopened run instead of leaving it RUNNING
      // forever (the old behaviour just let it get reaped again).
      this.state.waitUntil(executeAgentRun(this.store, this.buildRegistry(), this.env, { ...run, status: "RUNNING" }));
      return json({ ok: true, id });
    }

    // Local agent health beacon (daemon pings every ~30s).
    if (path === "/api/local-agent/heartbeat" && method === "POST") {
      const body = (await readBody<{ host?: string; version?: string; pid?: string; claimed?: boolean }>(request).catch(() => ({}))) as { host?: string; version?: string; pid?: string; claimed?: boolean };
      this.store.upsertLocalAgentHeartbeat({ host: body.host, version: body.version, pid: body.pid, claimed: body.claimed });
      // AOrgI registry: the daemon is a real runtime instance — register it
      // (software-engineering role: it executes local build/render/tooling
      // capability) with the same heartbeat so org liveness is honest.
      this.store.upsertOrgAgent({
        id: "local_daemon_01",
        roleId: "role_software_engineering",
        kind: "local",
        model: "deepseek-v4",
        host: body.host ?? "local",
        version: body.version,
        capabilitiesJson: JSON.stringify(["local_execution", "build", "render", "automation"]),
      });
      return json({ ok: true, lastSeen: nowIso() });
    }

    // Local machine daemon bridge
    if (path === "/api/local-tasks" && method === "GET") {
      return json({ tasks: this.store.listLocalTasks(50) });
    }
    if (path === "/api/local-tasks/claim" && method === "POST") {
      const body = (await readBody<{ claimer?: string }>(request).catch(() => ({}))) as { claimer?: string };
      const task = this.store.claimLocalTask(body.claimer ?? "api");
      return task ? json({ ok: true, task }) : json({ ok: true, task: null });
    }
    if (path === "/api/local-tasks/heartbeat" && method === "POST") {
      const body = (await readBody<{ id?: string; status?: string }>(request).catch(() => ({}))) as { id?: string; status?: string };
      this.store.heartbeatLocalTask(body.id ?? "", (body.status ?? "RUNNING") as never);
      return json({ ok: true });
    }
    if (path === "/api/local-tasks/finish" && method === "POST") {
      const body = (await readBody<{ id?: string; status?: string; result?: string; error?: string }>(request).catch(() => ({}))) as { id?: string; status?: string; result?: string; error?: string };
      this.store.finishLocalTask(body.id ?? "", (body.status === "FAILED" ? "FAILED" : "DONE") as never, body.result, body.error);
      // AOrgI Phase 2 — every finished local task is real evidence and a real
      // protocol message, not theater: trust for the daemon's local-execution
      // capability moves with measured outcomes; the COA receives a RESULT
      // (or DEVIATION on failure) message tied to the task.
      this.store.recordTrustEvidence("local_daemon_01", "local_execution", body.status !== "FAILED");
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
    const body = (await readBody<{ message?: string; sessionId?: string; stream?: boolean }>(request).catch(() => ({}))) as { message?: string; sessionId?: string; stream?: boolean };
    const message = (body.message ?? "").trim();
    if (!message) return json({ error: "message required" }, 400);
    const sessionId = body.sessionId ?? "default";
    const registry = this.buildRegistry();

    // Record the user message.
    const now = nowIso();
    this.store.insertChatMessage({ id: newId("msg"), session_id: sessionId, role: "user", content: message, source: "founder", created_at: now, updated_at: now });

    // Build history (system + last N messages).
    const history = this.store.listChatMessages(sessionId, 40);
    const messages: ChatMsg[] = [buildSystemContext(this.env)];
    for (const m of history) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content });
    }

    if (body.stream === true) {
      // Kick off async streaming into a chat_streams row.
      const streamId = newId("str");
      this.store.openChatStream(streamId, sessionId, nowIso());
      const promise = (async () => {
        try {
          const result = await agentLoop({
            store: this.store,
            registry,
            env: this.env,
            sessionId,
            messages,
            onChunk: (text) => this.store.appendChatStreamChunk(streamId, text),
            maxIterations: 8,
          });
          const now2 = nowIso();
          this.store.insertChatMessage({ id: newId("msg"), session_id: sessionId, role: "assistant", content: result.text, source: "executive", created_at: now2, updated_at: now2 });
          this.store.completeChatStream(streamId);
        } catch (err) {
          this.store.completeChatStream(streamId, err instanceof Error ? err.message : String(err));
        }
      })();
      // Best-effort: keep the work alive past the response where the runtime
      // exposes waitUntil on the DO state.
      (this.state as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(promise);
      return json({ ok: true, streamId, sessionId, note: "Poll /api/chat/stream?id=… to read the reply." });
    }

    try {
      const result = await agentLoop({ store: this.store, registry, env: this.env, sessionId, messages, maxIterations: 8 });
      const now2 = nowIso();
      this.store.insertChatMessage({ id: newId("msg"), session_id: sessionId, role: "assistant", content: result.text, source: "executive", created_at: now2, updated_at: now2 });
      return json({ ok: true, reply: result.text, iterations: result.iterations, toolsCalled: result.toolsCalled });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
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
  if (!streamId) return json({ error: "streamId required" }, 400);

  const id = env.EXECUTIVE_AGENT.idFromName("zarlino");
  const stub = env.EXECUTIVE_AGENT.get(id);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let after = 0;
      const timeout = 5 * 60 * 1000;
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
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
          }
          after = data.nextIndex ?? after;
          if (data.complete) {
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ error: data.error ?? null })}\n\n`));
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
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
      /* client disconnected — stop polling */
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
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
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
    return json({ error: "Executive OS API only — build the console (npm run build:console) to enable assets." }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const id = env.EXECUTIVE_AGENT.idFromName("zarlino");
    const stub = env.EXECUTIVE_AGENT.get(id);
    // Internal, auth-free kick that runs doctor + auto-run + reschedules.
    await stub.fetch(
      new Request("https://executive.internal/api/_scheduled", {
        method: "POST",
        headers: { [INTERNAL_HEADER]: INTERNAL_SECRET },
      }),
    );
    controller.noRetry();
  },
};
