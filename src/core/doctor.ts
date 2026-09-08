/**
 * System Doctor — the Executive OS's self-healing layer.
 *
 * Runs a battery of checks against the durable store and (optionally) fixes
 * what it finds, then logs every run to `doctor_logs` so self-healing is
 * auditable. It runs:
 *   - on every DO wake (constructor, blockConcurrencyWhile),
 *   - on the 6-hourly cron (scheduled handler),
 *   - on demand via `/api/doctor/run` or the `system.doctor` tool,
 *   - locally via `npm run doctor` / `npm run doctor:fix`.
 *
 * Doctrine: the Doctor only auto-fixes things that are unambiguously safe and
 * reversible (reaping stale runs, re-queuing expired leases, clearing expired
 * sessions, pruning orphaned streams, re-applying migrations). Anything that
 * needs judgment is reported with an `action` and left for the Founder.
 */
import { z } from "zod";
import type { ExecutiveStore } from "../db/store";
import type { DoctorCheckResult, DoctorReport, DoctorSeverity } from "../types";
import type { Tool, ToolContext } from "./tools/types";
import { newId } from "../ids";
import { evaluateProductGates } from "./perceptual/manager";
export interface DoctorContext {
  store: ExecutiveStore;
  env: Record<string, string | undefined>;
  /** Optional KV namespace (Cloudflare). Detected at runtime. */
  kv?: {
    list(opts: { limit: number }): Promise<{ keys: unknown[] }>;
    get(key: string): Promise<string | null>;
  };
  /** Optional tool registry — used by feature checks to verify the agent/chat layer. */
  registry?: {
    functionSchemas(): Array<{ function: { name: string } }>;
  };
  now(): string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  severity: DoctorSeverity;
  /** Run the check; when `autoFix` is true, repair safe issues in place. */
  run(ctx: DoctorContext, autoFix: boolean): Promise<DoctorCheckResult> | DoctorCheckResult;
}

const okResult = (id: string, label: string, severity: DoctorSeverity, detail: string): DoctorCheckResult => ({
  id, label, severity, status: "OK", detail,
});
const warnResult = (id: string, label: string, severity: DoctorSeverity, detail: string, action?: string): DoctorCheckResult => ({
  id, label, severity, status: "WARN", detail, action,
});
const failResult = (id: string, label: string, severity: DoctorSeverity, detail: string, action: string, fixed?: string): DoctorCheckResult => ({
  id, label, severity, status: "FAIL", detail, action, fixed,
});

const BUDGET_KEYS = ["ai_daily_budget", "ai_monthly_budget", "ai_per_task_budget", "ai_per_run_budget"] as const;

export const DOCTOR_CHECKS: DoctorCheck[] = [
  {
    id: "schema.migrations",
    label: "Schema migrations are current",
    severity: "CRITICAL",
    run: (ctx, autoFix) => {
      const applied = ctx.store.migrate();
      if (applied.length > 0) {
        return failResult(
          "schema.migrations",
          "Schema migrations are current",
          "CRITICAL",
          `Applied ${applied.length} pending migration(s): ${applied.map((v) => `v${v}`).join(", ")}.`,
          "Migrations are applied automatically on DO wake.",
          `applied ${applied.map((v) => `v${v}`).join(", ")}`,
        );
      }
      return okResult("schema.migrations", "Schema migrations are current", "CRITICAL", "All migrations applied (schema up to date).");
    },
  },
  {
    id: "db.tables",
    label: "Core tables exist and are queryable",
    severity: "HIGH",
    run: (ctx, autoFix) => {
      const required = ["executive_state", "tasks", "decisions", "approval_requests", "products", "pipeline_gates", "financial_snapshots", "memories", "audit_events", "agent_jobs", "local_tasks", "doctor_logs"];
      const missing: string[] = [];
      ctx.store.migrate(); // ensure tables exist via migrations
      for (const t of required) {
        try {
          if (!probeTable(ctx, t)) missing.push(t);
        } catch {
          missing.push(t);
        }
      }
      if (missing.length > 0) {
        return failResult("db.tables", "Core tables exist and are queryable", "HIGH", `Missing/unqueryable tables: ${missing.join(", ")}.`, "Run migrations (auto on wake).");
      }
      return okResult("db.tables", "Core tables exist and are queryable", "HIGH", `${required.length} core tables present and queryable.`);
    },
  },
  {
    id: "jobs.stale_runs",
    label: "No stale agent runs (restart orphans)",
    severity: "HIGH",
    run: (ctx, autoFix) => {
      const stale = ctx.store.stuckCounts().staleAgentRuns;
      if (stale > 0) {
        if (autoFix) {
          const reaped = ctx.store.reapStaleAgentRuns().length;
          return failResult("jobs.stale_runs", "No stale agent runs (restart orphans)", "HIGH", `Found ${stale} RUNNING agent job(s) with no heartbeat.`, "Auto-reaped.", `reaped ${reaped}`);
        }
        return warnResult("jobs.stale_runs", "No stale agent runs (restart orphans)", "HIGH", `Found ${stale} RUNNING agent job(s) with no heartbeat.`, "Run doctor with autoFix, or Continue from the durable checkpoint.");
      }
      return okResult("jobs.stale_runs", "No stale agent runs (restart orphans)", "HIGH", "No stale agent runs.");
    },
  },
  {
    id: "jobs.interrupted_runs",
    label: "No orphaned interrupted long-horizon runs",
    severity: "HIGH",
    run: (ctx, autoFix) => {
      // Dead weight first: orphans whose task already has a newer run can never
      // be resumed — delete them so the count reflects real work.
      if (autoFix) {
        try {
          ctx.store.cleanupSupersededOrphanRuns();
        } catch { /* cleanup is best-effort */ }
      }
      const orphans = ctx.store.countInterruptedRuns();
      const limitReached = ctx.store.countLimitReachedRuns();
      const n = orphans + limitReached;
      if (n > 0) {
        // Deliberately report-only: the maintenance sweep (runWakeMaintenance,
        // runs right after the doctor) auto-resumes both restart orphans and
        // limit-reached runs IN LOCKSTEP with execution (bounded by the
        // concurrency budget), so a bulk resume here would create RUNNING
        // zombies that never get picked up. The sweep drains the pile at
        // maxJobs per wake, continuing checkpointed runs until they finish.
        const what: string[] = [];
        if (orphans > 0) what.push(`${orphans} restart-orphan(s)`);
        if (limitReached > 0) what.push(`${limitReached} limit-reached (auto-continue pending)`);
        return failResult(
          "jobs.interrupted_runs",
          "No orphaned interrupted long-horizon runs",
          "HIGH",
          `Found ${n} resumable long-horizon run(s): ${what.join(", ")}.`,
          "The maintenance sweep auto-resumes and re-executes them (bounded).",
        );
      }
      return okResult("jobs.interrupted_runs", "No orphaned interrupted long-horizon runs", "HIGH", "No interrupted long-horizon runs.");
    },
  },
  {
    id: "provider.balance",
    label: "AI provider balance is healthy",
    severity: "HIGH",
    run: (ctx) => {
      const fail = ctx.store.recentProviderFailure();
      if (fail) {
        return failResult(
          "provider.balance",
          "AI provider balance is healthy",
          "HIGH",
          `AI provider is rejecting paid work: ${fail.kind} runs failing with HTTP 402 Insufficient Balance (last ${fail.at}).`,
          "Top up the DeepSeek account — cloud runs and the local daemon keep failing with 402 until then.",
        );
      }
      return okResult("provider.balance", "AI provider balance is healthy", "HIGH", "No recent AI provider payment failures.");
    },
  },
  {
    id: "tasks.expired_leases",
    label: "No expired local-task leases",
    severity: "MEDIUM",
    run: (ctx, autoFix) => {
      const expired = ctx.store.stuckCounts().expiredLeases;
      if (expired > 0) {
        if (autoFix) {
          const reaped = ctx.store.reapExpiredLocalTasks().length;
          return failResult("tasks.expired_leases", "No expired local-task leases", "MEDIUM", `Found ${expired} local task(s) with an expired claim lease.`, "Auto re-queued for any daemon.", `re-queued ${reaped}`);
        }
        return warnResult("tasks.expired_leases", "No expired local-task leases", "MEDIUM", `Found ${expired} local task(s) with an expired claim lease.`, "Run doctor with autoFix.");
      }
      return okResult("tasks.expired_leases", "No expired local-task leases", "MEDIUM", "No expired local-task leases.");
    },
  },
  {
    id: "sessions.expired",
    label: "No expired auth sessions",
    severity: "LOW",
    run: (ctx, autoFix) => {
      const count = ctx.store.runMaintenance().expiredSessions;
      if (count > 0) {
        return failResult("sessions.expired", "No expired auth sessions", "LOW", `Found ${count} expired session(s).`, "Auto-cleared.", `cleared ${count}`);
      }
      return okResult("sessions.expired", "No expired auth sessions", "LOW", "No expired sessions.");
    },
  },
  {
    id: "streams.orphaned",
    label: "No orphaned chat streams",
    severity: "LOW",
    run: (ctx, autoFix) => {
      if (autoFix) {
        const pruned = ctx.store.pruneCompletedChatStreams(24 * 60 * 60 * 1000);
        if (pruned > 0) {
          return failResult("streams.orphaned", "No orphaned chat streams", "LOW", `Pruned ${pruned} completed chat stream(s) older than 24h.`, "Auto-pruned.", `pruned ${pruned}`);
        }
      } else {
        const count = (ctx.store as unknown as { countCompletedChatStreams?: (olderThanMs: number) => number }).countCompletedChatStreams?.(24 * 60 * 60 * 1000) ?? 0;
        if (count > 0) {
          return warnResult("streams.orphaned", "No orphaned chat streams", "LOW", `${count} completed chat stream(s) older than 24h.`, "Run doctor with autoFix.");
        }
      }
      return okResult("streams.orphaned", "No orphaned chat streams", "LOW", "No orphaned chat streams.");
    },
  },
  {
    id: "state.executive",
    label: "Executive state row exists",
    severity: "HIGH",
    run: (ctx, autoFix) => {
      const existing = ctx.store.getExecutiveState();
      if (!existing) {
        ctx.store.ensureExecutiveState();
        return failResult("state.executive", "Executive state row exists", "HIGH", "Missing executive_state row.", "Auto-seeded.", "seeded");
      }
      return okResult("state.executive", "Executive state row exists", "HIGH", `State ${existing.overall_status} / ${existing.autonomy_mode}.`);
    },
  },
  {
    id: "settings.budget",
    label: "Budget overrides are valid positive numbers",
    severity: "MEDIUM",
    run: (ctx, autoFix) => {
      const invalid: string[] = [];
      for (const key of BUDGET_KEYS) {
        const v = ctx.store.getSetting(key);
        if (v === null || v === "") continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) invalid.push(key);
      }
      if (invalid.length > 0) {
        if (autoFix) {
          for (const key of invalid) ctx.store.setSetting(key, null);
          return failResult("settings.budget", "Budget overrides are valid positive numbers", "MEDIUM", `Invalid budget override(s): ${invalid.join(", ")}.`, "Auto-cleared.", `cleared ${invalid.join(", ")}`);
        }
        return warnResult("settings.budget", "Budget overrides are valid positive numbers", "MEDIUM", `Invalid budget override(s): ${invalid.join(", ")}.`, "Run doctor with autoFix.");
      }
      return okResult("settings.budget", "Budget overrides are valid positive numbers", "MEDIUM", "Budget overrides valid.");
    },
  },
  {
    id: "metrics.seed",
    label: "Headline product metrics seeded",
    severity: "LOW",
    run: (ctx, autoFix) => {
      const downloads = ctx.store.latestMetricByName("downloads");
      const licensed = ctx.store.latestMetricByName("licensed");
      if (!downloads || !licensed) {
        if (autoFix) {
          ctx.store.ensureProductMetrics();
          return failResult("metrics.seed", "Headline product metrics seeded", "LOW", "Missing downloads/licensed metric rows.", "Auto-seeded.", "seeded");
        }
        return warnResult("metrics.seed", "Headline product metrics seeded", "LOW", "Missing downloads/licensed metric rows.", "Run doctor with autoFix.");
      }
      return okResult("metrics.seed", "Headline product metrics seeded", "LOW", "downloads + licensed metrics present.");
    },
  },
  {
    id: "secrets.required",
    label: "Required secrets configured (presence only)",
    severity: "HIGH",
    run: (ctx, _autoFix) => {
      const required = ["DEEPSEEK_API_KEY", "FOUNDER_AUTH_TOKEN", "PAYSTACK_SECRET_KEY", "ZARLINO_LICENSE_PRIVATE_KEY"];
      const missing = required.filter((k) => !ctx.env[k]);
      if (missing.length > 0) {
        return warnResult(
          "secrets.required",
          "Required secrets configured (presence only)",
          "HIGH",
          `Missing secrets: ${missing.join(", ")}.`,
          "Set via `wrangler secret put <NAME>` (or .dev.vars locally). Values are never read by the Doctor.",
        );
      }
      return okResult("secrets.required", "Required secrets configured (presence only)", "HIGH", "All required secrets present (presence checked, values never read).");
    },
  },
  {
    id: "features.agent_ready",
    label: "Chat / agent feature layer is ready",
    severity: "HIGH",
    run: (ctx, _autoFix) => {
      const issues: string[] = [];
      // 1. Model provider key present (chat + agent runs need it).
      if (!ctx.env.DEEPSEEK_API_KEY) {
        issues.push("DEEPSEEK_API_KEY is missing — chat and agent runs will fail to authenticate.");
      }
      // 2. Tool names must be provider-safe: DeepSeek requires ^[a-zA-Z0-9_-]+$ (no dots).
      //    A dotted name like finance.get_snapshot makes every chat call 400.
      if (ctx.registry) {
        const invalid = ctx.registry
          .functionSchemas()
          .map((s) => s.function.name)
          .filter((n) => !/^[a-zA-Z0-9_-]+$/.test(n));
        if (invalid.length > 0) {
          issues.push(`Invalid tool name(s) sent to the model: ${invalid.slice(0, 5).join(", ")} — chat will fail with DeepSeek HTTP 400. Sanitize names in the registry.`);
        }
      } else {
        issues.push("Registry not attached — tool-name safety not verified.");
      }
      // 3. Spend gate: if the budget is exhausted the model calls stop.
      const daily = Number(ctx.env.AI_DAILY_BUDGET) || 0;
      const monthly = Number(ctx.env.AI_MONTHLY_BUDGET) || 0;
      const spentToday = ctx.store.spentToday();
      const spentMonth = ctx.store.spentThisMonth();
      if (daily > 0 && spentToday >= daily) issues.push(`Daily AI budget exhausted ($${spentToday.toFixed(2)}/$${daily}) — model calls are gated until it resets.`);
      if (monthly > 0 && spentMonth >= monthly) issues.push(`Monthly AI budget exhausted ($${spentMonth.toFixed(2)}/$${monthly}) — model calls are gated.`);
      if (issues.length > 0) {
        return failResult(
          "features.agent_ready",
          "Chat / agent feature layer is ready",
          "HIGH",
          issues.join(" "),
          "Fix the flagged configuration, then verify /api/chat returns a reply.",
        );
      }
      return okResult("features.agent_ready", "Chat / agent feature layer is ready", "HIGH", "Model key present, tool names provider-safe, budget headroom available.");
    },
  },
  {
    id: "local_agent.health",
    label: "Local agent (daemon) is online and processing",
    severity: "HIGH",
    run: (ctx, _autoFix) => {
      const agoMs = ctx.store.localAgentSeenAgoMs();
      const agingPending = ctx.store.countAgingPendingLocalTasks(30 * 60 * 1000);
      if (agoMs === null) {
        if (agingPending > 0) {
          return failResult(
            "local_agent.health",
            "Local agent (daemon) is online and processing",
            "HIGH",
            `Local agent has never reported in, and ${agingPending} local task(s) have been PENDING for 30+ minutes with no daemon to claim them.`,
            "Start the daemon: `npm run agent:daemon:loop` from executive-os/. It claims tasks, heartbeats, and reports results back here.",
          );
        }
        return warnResult(
          "local_agent.health",
          "Local agent (daemon) is online and processing",
          "HIGH",
          "No local-agent heartbeat yet — the on-machine daemon is not connected.",
          "Start it with `npm run agent:daemon:loop`.",
        );
      }
      if (agoMs > 5 * 60 * 1000) {
        return failResult(
          "local_agent.health",
          "Local agent (daemon) is online and processing",
          "HIGH",
          `Local agent offline — last heartbeat ${Math.round(agoMs / 60_000)} minutes ago. ${agingPending} task(s) are waiting for it.`,
          "Restart the daemon: `npm run agent:daemon:loop`.",
        );
      }
      const pending = ctx.store.listLocalTasks(100).filter((t) => t.status === "PENDING").length;
      if (pending > 0) {
        return warnResult(
          "local_agent.health",
          "Local agent (daemon) is online and processing",
          "HIGH",
          `Local agent is online (last seen ${Math.round(agoMs / 1000)}s ago) but ${pending} task(s) are still PENDING — the daemon may be idle or stuck.`,
          "Check the daemon logs; it claims the oldest PENDING task every ~30s.",
        );
      }
      return okResult("local_agent.health", "Local agent (daemon) is online and processing", "HIGH", "Local agent online and processing tasks.");
    },
  },
  {
    id: "org.registry",
    label: "AOrgI registry is coherent (roles, departments, agent instances)",
    severity: "HIGH",
    run: (ctx, _autoFix) => {
      // Rows exist only through migration v23; a missing table/seed means the
      // migration never ran on this store.
      const departments = ctx.store.listDepartments();
      const roles = ctx.store.listOrgRoles();
      if (departments.length === 0 || roles.length === 0) {
        return failResult(
          "org.registry",
          "AOrgI registry is coherent (roles, departments, agent instances)",
          "HIGH",
          `Registry empty: ${departments.length} department(s), ${roles.length} role manifest(s).`,
          "Run migrations (auto on DO wake).",
        );
      }
      // Every role must reference an existing department and every active
      // agent an existing role — dangling references break assignment.
      const deptIds = new Set(departments.map((d) => d.id));
      const orphanRoles = roles.filter((r) => !deptIds.has(r.department_id)).map((r) => r.id);
      if (orphanRoles.length > 0) {
        return failResult(
          "org.registry",
          "AOrgI registry is coherent (roles, departments, agent instances)",
          "HIGH",
          `Role manifest(s) reference missing department(s): ${orphanRoles.join(", ")}.`,
          "Repair the org_roles.department_id references.",
        );
      }
      const roleIds = new Set(roles.map((r) => r.id));
      const agents = ctx.store.listOrgAgents();
      const orphanAgents = agents.filter((a) => !roleIds.has(a.role_id)).map((a) => a.id);
      if (orphanAgents.length > 0) {
        return failResult(
          "org.registry",
          "AOrgI registry is coherent (roles, departments, agent instances)",
          "HIGH",
          `Agent instance(s) reference missing role(s): ${orphanAgents.join(", ")}.`,
          "Repair the org_agents.role_id references.",
        );
      }
      // Registered instances must keep heartbeating. The local daemon pings
      // every ~30s; the cloud DO re-registers on every wake. Two days without
      // a heartbeat means the instance is gone or its registration is broken.
      const stale = agents.filter(
        (a) => !a.last_seen || Date.parse(a.last_seen) < Date.now() - 2 * 24 * 60 * 60 * 1000,
      );
      if (stale.length > 0) {
        return warnResult(
          "org.registry",
          "AOrgI registry is coherent (roles, departments, agent instances)",
          "HIGH",
          `${stale.length} registered agent instance(s) have no heartbeat for 2+ days: ${stale.map((a) => a.id).join(", ")}.`,
          "Restart the runtime, or deregister the instance if it no longer exists.",
        );
      }
      return okResult(
        "org.registry",
        "AOrgI registry is coherent (roles, departments, agent instances)",
        "HIGH",
        `${departments.length} departments, ${roles.length} role manifests, ${agents.length} live agent instance(s) — registry coherent.`,
      );
    },
  },
  {
    id: "org.post_objective",
    label: "Completed objectives have PostObjectiveRecords",
    severity: "MEDIUM",
    run: (ctx, _autoFix) => {
      // AOrgI §38: after completing an objective the organization must record
      // what worked, what failed, and what to change — otherwise the next
      // objective cannot learn from this one.
      const completed = ctx.store.listObjectives().filter((o) => ["COMPLETED", "DONE", "ACHIEVED"].includes(String(o.status).toUpperCase()));
      const missing = completed.filter((o) => !ctx.store.hasPostObjectiveRecord(o.id));
      if (missing.length > 0) {
        return warnResult(
          "org.post_objective",
          "Completed objectives have PostObjectiveRecords",
          "MEDIUM",
          `${missing.length} completed objective(s) have no PostObjectiveRecord: ${missing.map((o) => o.id).join(", ")}.`,
          "Record outcomes via POST /api/org/post-objectives (outcome, successful/failed roles, bottlenecks, lessons).",
        );
      }
      if (completed.length === 0) {
        return okResult("org.post_objective", "Completed objectives have PostObjectiveRecords", "MEDIUM", "No completed objectives yet.");
      }
      return okResult(
        "org.post_objective",
        "Completed objectives have PostObjectiveRecords",
        "MEDIUM",
        `All ${completed.length} completed objective(s) have PostObjectiveRecords.`,
      );
    },
  },
  {
    id: "org.capability.coverage",
    label: "Every active role has capability grants (fail-closed, §10)",
    severity: "HIGH",
    run: (ctx, _autoFix) => {
      // A role with no grant rows at all — not even a wildcard — would DENY
      // every tool for its instances. Active roles must never be uncovered.
      const uncovered = ctx.store.listRolesWithoutCapabilityGrants();
      if (uncovered.length > 0) {
        return failResult(
          "org.capability.coverage",
          "Every active role has capability grants (fail-closed, §10)",
          "HIGH",
          `Active role(s) with no capability grant (their instances are fully blocked): ${uncovered.join(", ")}.`,
          "Upsert a wildcard grant: POST /api/org/capabilities {role_id, capability:'*', autonomy_level:'L2'}.",
        );
      }
      const agents = ctx.store.listOrgAgents();
      return okResult(
        "org.capability.coverage",
        "Every active role has capability grants (fail-closed, §10)",
        "HIGH",
        `All active roles covered by capability grants; ${agents.length} registered instance(s) checked.`,
      );
    },
  },
  {
    id: "org.task_contracts",
    label: "Substantial tasks carry a contract (acceptance + verifier, §18)",
    severity: "MEDIUM",
    run: (ctx, _autoFix) => {
      // §18: no substantial task should live as informal conversation. P0/P1
      // or BLOCKED tasks without acceptance criteria or a verification owner
      // are exactly that — surface them; the fix is a founder/COA decision,
      // not an auto-write.
      const substantial = ctx.store
        .listTasks({ limit: 500 })
        .filter((t) => t.status !== "DONE" && (t.status === "BLOCKED" || t.priority === "P0" || t.priority === "P1"));
      const uncovered = substantial.filter((t) => !t.acceptance_criteria || !t.verification_role_id);
      if (uncovered.length > 0) {
        return warnResult(
          "org.task_contracts",
          "Substantial tasks carry a contract (acceptance + verifier, §18)",
          "MEDIUM",
          `${uncovered.length} substantial task(s) without a full contract: ${uncovered.map((t) => t.id).join(", ")}.`,
          "Set acceptance criteria + verification role via POST /api/org/task-contracts/:id.",
        );
      }
      return okResult(
        "org.task_contracts",
        "Substantial tasks carry a contract (acceptance + verifier, §18)",
        "MEDIUM",
        `${substantial.length} substantial task(s) checked — all contracted.`,
      );
    },
  },
  {
    id: "org.negotiations_stale",
    label: "No stalled negotiations awaiting arbitration",
    severity: "MEDIUM",
    run: (ctx, _autoFix) => {
      // §23: after rounds are exhausted the arbiter must resolve. A verdict
      // pending for 24h+ (or a 72h+ silent OPEN negotiation) is a stall.
      const now = Date.now();
      const negotiations = ctx.store.listOrgNegotiations(100);
      const stalled = negotiations.filter((n) => {
        const age = now - Date.parse(n.updated_at);
        return (n.status === "ARBITRATED" && age > 24 * 60 * 60 * 1000) || (n.status === "OPEN" && age > 72 * 60 * 60 * 1000);
      });
      if (stalled.length > 0) {
        return warnResult(
          "org.negotiations_stale",
          "No stalled negotiations awaiting arbitration",
          "MEDIUM",
          `${stalled.length} negotiation(s) stalled: ${stalled.map((n) => n.id).join(", ")}.`,
          "Arbitrate via POST /api/org/negotiations/:id/arbitrate (or resolve the rounds).",
        );
      }
      return okResult("org.negotiations_stale", "No stalled negotiations awaiting arbitration", "MEDIUM", `${negotiations.length} negotiation(s) checked — none stalled.`);
    },
  },
  {
    id: "org.analyst.fresh",
    label: "Organizational analyst has observed the org recently (§36)",
    severity: "LOW",
    run: (ctx, _autoFix) => {
      // The analyst runs on every maintenance sweep (wake/cron). A missing or
      // stale report means self-observation stopped — the org is flying blind.
      const latest = ctx.store.latestAnalystReport();
      if (!latest) {
        return warnResult(
          "org.analyst.fresh",
          "Organizational analyst has observed the org recently (§36)",
          "LOW",
          "No organizational analyst report yet.",
          "Run POST /api/org/analyst/run (also runs automatically on each maintenance sweep).",
        );
      }
      const age = Date.now() - Date.parse(latest.generated_at);
      if (age > 26 * 60 * 60 * 1000) {
        return warnResult(
          "org.analyst.fresh",
          "Organizational analyst has observed the org recently (§36)",
          "LOW",
          `Latest analyst report is ${Math.round(age / 3_600_000)}h old.`,
          "Run POST /api/org/analyst/run.",
        );
      }
      return okResult(
        "org.analyst.fresh",
        "Organizational analyst has observed the org recently (§36)",
        "LOW",
        `Latest analyst report ${Math.round(age / 60_000)}min old (trigger: ${latest.trigger}).`,
      );
    },
  },
  {
    id: "org.dod",
    label: "Explicit DefinitionOfDone exists (§30)",
    severity: "LOW",
    run: (ctx, _autoFix) => {
      const dod = ctx.store.getDefinitionOfDone();
      if (!dod) {
        return warnResult(
          "org.dod",
          "Explicit DefinitionOfDone exists (§30)",
          "LOW",
          "No ACTIVE definition_of_done entry in organizational memory.",
          "Restore it via POST /api/org/memory with key 'definition_of_done'.",
        );
      }
      return okResult("org.dod", "Explicit DefinitionOfDone exists (§30)", "LOW", `DefinitionOfDone v${dod.version} present in org memory.`);
    },
  },
  {
    id: "org.incidents_open",
    label: "Open incidents are tracked (never hidden, §31)",
    severity: "MEDIUM",
    run: (ctx, _autoFix) => {
      const open = ctx.store.listOrgIncidents({ limit: 100 }).filter((i) => i.status !== "RESOLVED");
      const critical = open.filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH");
      if (critical.length > 0) {
        return warnResult(
          "org.incidents_open",
          "Open incidents are tracked (never hidden, §31)",
          "MEDIUM",
          `${critical.length} open HIGH/CRITICAL incident(s): ${critical.map((i) => i.id).join(", ")}.`,
          "Work the response loop (§31) and resolve via POST /api/org/incidents/:id/status.",
        );
      }
      return okResult(
        "org.incidents_open",
        "Open incidents are tracked (never hidden, §31)",
        "MEDIUM",
        open.length > 0 ? `${open.length} low-severity incident(s) open.` : "No open incidents.",
      );
    },
  },
  {
    id: "kv.health",
    label: "KV namespace reachable",
    severity: "LOW",
    run: async (ctx, _autoFix) => {
      if (!ctx.kv) {
        return warnResult("kv.health", "KV namespace reachable", "LOW", "ZARLINO_KV not bound — counters/affiliate state unavailable.", "Bind ZARLINO_KV in wrangler.toml.");
      }
      try {
        await ctx.kv.list({ limit: 1 });
        return okResult("kv.health", "KV namespace reachable", "LOW", "KV reachable.");
      } catch {
        return warnResult("kv.health", "KV namespace reachable", "LOW", "KV unreachable at check time.", "Check the ZARLINO_KV binding.");
      }
    },
  },
  {
    id: "productivity.stale_assignments",
    label: "Productivity assignments are progressing",
    severity: "MEDIUM",
    run: (ctx, autoFix) => {
      const stale = ctx.store.countStaleAssignments(48 * 60 * 60 * 1000);
      if (stale > 0) {
        if (autoFix) {
          const ids = ctx.store.reapStaleAssignments(48 * 60 * 60 * 1000);
          return failResult(
            "productivity.stale_assignments",
            "Productivity assignments are progressing",
            "MEDIUM",
            `${stale} assignment(s) with no progress in 48h.`,
            "Assignments are auto-marked STALLED so they can be re-planned.",
            `marked ${ids.length} assignment(s) STALLED`,
          );
        }
        return warnResult(
          "productivity.stale_assignments",
          "Productivity assignments are progressing",
          "MEDIUM",
          `${stale} assignment(s) with no progress in 48h.`,
          "Run with auto-fix to mark them STALLED.",
        );
      }
      return okResult("productivity.stale_assignments", "Productivity assignments are progressing", "MEDIUM", "No stale assignments.");
    },
  },
  {
    id: "productivity.budget_health",
    label: "Token budgets are within limits",
    severity: "MEDIUM",
    run: (ctx, _autoFix) => {
      try {
        const budgets = ctx.store.listTokenBudgets();
        if (budgets.length === 0) {
          return warnResult("productivity.budget_health", "Token budgets are within limits", "MEDIUM", "No token budgets tracked yet.", "Run productivity.optimize once to seed the global budget.");
        }
        const over = budgets.filter((b) => {
          const monthly = b.monthly_budget ?? 0;
          return monthly > 0 && b.tokens_used_month >= monthly * 0.9;
        });
        if (over.length) {
          return warnResult(
            "productivity.budget_health",
            "Token budgets are within limits",
            "MEDIUM",
            `${over.length} scope(s) at ≥90% of monthly token budget: ${over.map((b) => b.scope).join(", ")}.`,
            "Reallocate budget (productivity.optimize) or raise the cap in wrangler vars.",
          );
        }
        return okResult("productivity.budget_health", "Token budgets are within limits", "MEDIUM", "All token budgets within limits.");
      } catch {
        return okResult("productivity.budget_health", "Token budgets are within limits", "MEDIUM", "Budget check unavailable (no productivity tables yet).");
      }
    },
  },
  {
    id: "productivity.contradictions",
    label: "No open contradictions/misconceptions",
    severity: "LOW",
    run: (ctx, _autoFix) => {
      const open = ctx.store.countOpenContradictions();
      if (open > 0) {
        return warnResult(
          "productivity.contradictions",
          "No open contradictions/misconceptions",
          "LOW",
          `${open} open contradiction(s)/misconception(s) — run productivity.detect_contradictions, review and resolve.`,
          "Review and resolve in the Productivity view.",
        );
      }
      return okResult("productivity.contradictions", "No open contradictions/misconceptions", "LOW", "No open contradictions.");
    },
  },
  {
    id: "perceptual.evidence_gaps",
    label: "No unresolved perceptual evidence gaps",
    severity: "MEDIUM",
    run: (ctx, _autoFix) => {
      try {
        const validations = ctx.store.listProductValidations();
        const gapIds = validations
          .map((v) => ({ id: v.product_id, e: evaluateProductGates(v) }))
          .filter(({ e }) => e.blockers.includes("perceptual") || e.insufficient.includes("perceptual"))
          .map(({ id }) => id);
        if (gapIds.length > 0) {
          return warnResult(
            "perceptual.evidence_gaps",
            "No unresolved perceptual evidence gaps",
            "MEDIUM",
            `${gapIds.length} product(s) lack adequate perceptual evidence: ${gapIds.join(", ")}. AI judgment is NOT equivalent to external human listening evidence (spec §2).`,
            "Design + run a controlled listening test (blind preference / ABX / workflow) via the Perceptual view.",
          );
        }
        return okResult("perceptual.evidence_gaps", "No unresolved perceptual evidence gaps", "MEDIUM", "All products have adequate perceptual evidence or no validation gate requiring it.");
      } catch {
        return okResult("perceptual.evidence_gaps", "No unresolved perceptual evidence gaps", "MEDIUM", "Perceptual check unavailable (schema older than v22).");
      }
    },
  },
];

/** Probe whether a table exists by running a guarded SELECT against it. */
function probeTable(ctx: DoctorContext, table: string): boolean {
  try {
    const store = ctx.store as unknown as { probeTableExists(t: string): boolean };
    if (typeof store.probeTableExists === "function") return store.probeTableExists(table);
  } catch {
    /* fall through */
  }
  return true; // conservative: store-level probe unavailable
}

export interface RunDoctorOptions {
  autoFix: boolean;
  trigger: string;
}

/** Run every Doctor check, apply fixes when autoFix, and log the run. */
export async function runDoctor(ctx: DoctorContext, opts: RunDoctorOptions): Promise<DoctorReport> {
  const results: DoctorCheckResult[] = [];
  for (const check of DOCTOR_CHECKS) {
    try {
      const r = await check.run(ctx, opts.autoFix);
      results.push(r);
    } catch (err) {
      results.push({
        id: check.id,
        label: check.label,
        severity: check.severity,
        status: "FAIL",
        detail: `Check crashed: ${err instanceof Error ? err.message : String(err)}`,
        action: "Review the Doctor logs and the store state manually.",
      });
    }
  }
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "OK").length,
    warn: results.filter((r) => r.status === "WARN").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    fixed: results.filter((r) => Boolean(r.fixed)).length,
  };
  const report: DoctorReport = {
    generatedAt: ctx.now(),
    trigger: opts.trigger,
    autoFix: opts.autoFix,
    checks: results,
    summary,
    healthy: summary.fail === 0,
  };
  try {
    ctx.store.insertDoctorLog({
      id: newId("doc"),
      run_at: report.generatedAt,
      trigger: opts.trigger,
      auto_fix: opts.autoFix ? 1 : 0,
      summary_json: JSON.stringify(summary),
      checks_json: JSON.stringify(results),
      source: "system",
      created_at: report.generatedAt,
      updated_at: report.generatedAt,
    });
  } catch {
    /* logging must never break the Doctor */
  }
  return report;
}

// ---------------------------------------------------------------------------
// Doctor tools exposed to the Executive agent
// ---------------------------------------------------------------------------

function doctorContextFromTool(ctx: ToolContext): DoctorContext {
  return {
    store: ctx.store!,
    env: ctx.env ?? {},
    now: () => new Date().toISOString(),
  };
}

export function doctorTools(): Tool[] {
  return [
    {
      name: "system.doctor",
      description:
        "Run the System Doctor: checks schema/migrations, stale agent runs, expired local-task leases, expired sessions, orphaned chat streams, executive state, budget overrides, metrics seed, secrets presence and KV health. With autoFix (default true) it safely repairs what it finds and logs the run. Returns the full check report.",
      inputSchema: z.object({ autoFix: z.boolean().optional(), trigger: z.string().max(40).optional() }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext, input: { autoFix?: boolean; trigger?: string }) => {
        if (!ctx.store) throw new Error("store unavailable");
        const report = await runDoctor(doctorContextFromTool(ctx), {
          autoFix: input.autoFix ?? true,
          trigger: input.trigger ?? "system.doctor tool",
        });
        return {
          healthy: report.healthy,
          summary: report.summary,
          checks: report.checks.map((c) => ({ id: c.id, status: c.status, severity: c.severity, detail: c.detail, fixed: c.fixed, action: c.action })),
          note: report.healthy ? "All systems green." : "Issues found — see check details. Warnings may need human action.",
        };
      },
    },
    {
      name: "system.self_test",
      description: "Run a read-only self test: verify the store is wired, migrations are current, and core subsystems respond. Does not mutate anything.",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext) => {
        if (!ctx.store) throw new Error("store unavailable");
        const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
        const ok = (name: string, detail: string) => checks.push({ name, ok: true, detail });
        const bad = (name: string, detail: string) => checks.push({ name, ok: false, detail });

        const before = ctx.store.migrate().length;
        ok("migrations", before === 0 ? "schema current" : `${before} pending (will apply on wake)`);

        const state = ctx.store.getExecutiveState();
        state ? ok("executive_state", `present (${state.overall_status})`) : bad("executive_state", "missing");

        const tasks = ctx.store.listTasks({ limit: 3 });
        ok("tasks", `queryable (${tasks.length} returned)`);

        const products = ctx.store.listProducts();
        ok("products", `queryable (${products.length} products)`);

        const gates = ctx.store.listPipelineGates();
        ok("pipeline_gates", `queryable (${gates.length} gates)`);

        const costs = ctx.store.spentToday();
        ok("cost_tracking", `spentToday=${costs}`);

        const audit = ctx.store.listAudit(1);
        ok("audit", `queryable (${audit.length} events)`);

        return { ok: checks.every((c) => c.ok), checks, note: "Read-only self test — no data was mutated." };
      },
    },
    {
      name: "system.maintenance",
      description: "Run the maintenance sweep: reap stale agent runs, re-queue expired local-task leases, delete expired sessions, and prune old completed chat streams. Audited.",
      inputSchema: z.object({}),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (ctx: ToolContext) => {
        if (!ctx.store) throw new Error("store unavailable");
        const maintenance = ctx.store.runMaintenance();
        const pruned = ctx.store.pruneCompletedChatStreams(24 * 60 * 60 * 1000);
        ctx.audit("executive", "system.maintenance", "system", "maintenance", { ...maintenance, prunedStreams: pruned });
        return { ran: true, staleRunsReaped: maintenance.staleRuns.length, localTasksRequeued: maintenance.reapedLocal.length, expiredSessions: maintenance.expiredSessions, prunedStreams: pruned };
      },
    },
  ];
}
