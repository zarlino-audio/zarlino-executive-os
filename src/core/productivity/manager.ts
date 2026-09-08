/**
 * Productivity Manager — the Executive OS's "do more with less" layer
 * (migration v18).
 *
 * Responsibilities:
 *  1. TRACK & MANAGE token budgets per scope (global / role / task) with
 *     usage actuals and safe reallocation.
 *  2. ASSIGN tasks to roles/agents by skill coverage + historical cost
 *     efficiency, so work goes to the cheapest competent pair.
 *  3. MAINTAIN a roles & skills inventory (role_skills, task_skills) and
 *     surface skill gaps.
 *  4. OPTIMIZE: apply safe, reversible optimizations automatically and
 *     record every applied/recommended change in optimization_events.
 *  5. RESOLVE contradictions/misconceptions: structural scans flag
 *     conflicting state (stale decisions, done-but-running, duplicates,
 *     shipped-but-gate-open, budget overrides vs defaults, misassignments)
 *     and let the Founder/Executive resolve them with an audit trail.
 *
 * Doctrine: only safe + reversible optimizations are applied automatically;
 * anything needing judgment becomes a recommendation the agent/Founder
 * reviews. All changes are recorded for audit.
 */

import type { ExecutiveStore } from "../../db/store";
import type { Task } from "../../types";
import { newId, nowIso } from "../../ids";

export interface ProductivityContext {
  store: ExecutiveStore;
  env: Record<string, string | undefined>;
  now(): string;
}

// Model tiers the Executive routes work to (cost ascending).
export const MODEL_TIERS = ["cheap", "medium", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

const DEFAULT_DAILY_BUDGET = 30_000_000; // tokens
const DEFAULT_MONTHLY_BUDGET = 900_000_000; // tokens
const STALE_ASSIGNMENT_MS = 48 * 60 * 60 * 1000; // 48h no-progress → STALLED

/** Skill keywords mapped from a task title/description for auto-skill tagging. */
const SKILL_KEYWORDS: Array<{ skill: string; re: RegExp }> = [
  { skill: "dsp_implementation", re: /\b(dsp|filter|compressor|eq|saturat|noise|pitch|reverb|algorithm|audio process)\b/i },
  { skill: "cpp", re: /\b(cpp|code|implement|source|build)\b|\bc\+\+/i },
  { skill: "juce", re: /\b(juce|plugin|vst|editor|audio\s*thread)\b/i },
  { skill: "testing", re: /\b(test|fuzz|qa|verify|golden|regression)\b/i },
  { skill: "code_review", re: /\b(review|correctness|audit\s+code|refactor)\b/i },
  { skill: "profiling", re: /\b(perf|latency|cpu|memory\s+usage|profile|benchmark)\b/i },
  { skill: "cmake", re: /\b(cmake|build\s+system|compile|link|packag)\b/i },
  { skill: "ci", re: /\b(ci|pipeline|github\s+actions|release\s+build|workflow)\b/i },
  { skill: "licensing", re: /\b(licens|signing|certificate|security|protection)\b/i },
  { skill: "documentation", re: /\b(doc|manual|readme|write[- ]?up|guide)\b/i },
  { skill: "market_analysis", re: /\b(market|spec|pricing|feature\s*set|positioning)\b/i },
  { skill: "competitive_research", re: /\b(research|competitor|compare|survey|gap)\b/i },
  { skill: "web_research", re: /\b(research|web|article|source|reference|look\s*up)\b/i },
  { skill: "apvts", re: /\b(param|apvts|preset|state|knob)\b/i },
  { skill: "look_and_feel", re: /\b(ui|look|feel|theme|design|graphic|skin)\b/i },
  { skill: "signal_chain", re: /\b(architecture|topology|signal\s*chain|design|spec)\b/i },
  { skill: "security", re: /\b(security|vulnerab|threat|permission)\b/i },
];

// ---------------------------------------------------------------------------
// Skill inference
// ---------------------------------------------------------------------------

/** Infer required skills from a task's title/description (deterministic). */
export function inferTaskSkills(task: Pick<Task, "title" | "description">): Array<{ skill: string; weight: number }> {
  const text = `${task.title} ${task.description ?? ""}`;
  const found = new Map<string, number>();
  for (const { skill, re } of SKILL_KEYWORDS) {
    const matches = text.match(re);
    if (matches) found.set(skill, (found.get(skill) ?? 0) + matches.length);
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([skill, count]) => ({ skill, weight: Math.min(3, 0.5 + count * 0.5) }));
}

/** Normalize a title for duplicate detection. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Assignment recommendation
// ---------------------------------------------------------------------------

export interface AssignmentRecommendation {
  taskId: string;
  taskTitle: string;
  roleId: string;
  roleName: string;
  score: number;
  skillsCovered: string[];
  skillsMissing: string[];
  estTokens: number;
  estCost: number;
  note: string;
}

const TOKEN_PER_COMPLEXITY = { P0: 120_000, P1: 60_000, P2: 30_000, P3: 12_000 } as const;

/**
 * Recommend the best role for a task: skill coverage first, then historical
 * cost efficiency (roles that finish work cheaper get a score bonus).
 */
export function recommendAssignment(store: ExecutiveStore, task: Task): AssignmentRecommendation | null {
  const skills = store.listTaskSkills(task.id);
  const required = skills.length > 0 ? skills : inferTaskSkills(task);
  const requiredNames = required.map((s) => s.skill);
  const persons = store.listPersons();
  const roles = persons.filter((p) => p.id.startsWith("person_role_") || p.role);
  if (roles.length === 0) return null;

  // Historical cost efficiency per role (cost per completed assignment).
  const assignments = store.listAssignments({ limit: 500 });
  const roleEfficiency = new Map<string, { done: number; cost: number }>();
  for (const a of assignments) {
    if (a.status !== "DONE" || !a.role_id) continue;
    const e = roleEfficiency.get(a.role_id) ?? { done: 0, cost: 0 };
    e.done += 1;
    e.cost += a.cost_actual;
    roleEfficiency.set(a.role_id, e);
  }

  const roleSkills = store.listRoleSkills();
  const byRole = new Map<string, Map<string, number>>();
  for (const rs of roleSkills) {
    if (!byRole.has(rs.role_id)) byRole.set(rs.role_id, new Map());
    byRole.get(rs.role_id)!.set(rs.skill, rs.proficiency);
  }

  let best: { roleId: string; roleName: string; score: number; covered: string[]; missing: string[] } | null = null;

  for (const role of roles) {
    const skillsOfRole = byRole.get(role.id) ?? new Map<string, number>();
    const covered: string[] = [];
    const missing: string[] = [];
    let score = 0;
    for (const r of required) {
      const prof = skillsOfRole.get(r.skill) ?? 0;
      if (prof > 0) {
        covered.push(r.skill);
        score += r.weight * prof;
      } else {
        missing.push(r.skill);
        score -= r.weight * 0.5;
      }
    }
    if (covered.length === 0 && missing.length > 0) continue; // no fit at all
    // Efficiency bonus: up to +3 for the cheapest successful role.
    const eff = roleEfficiency.get(role.id);
    if (eff && eff.done > 0 && eff.cost > 0) {
      const costPerTask = eff.cost / eff.done;
      score += Math.max(0, 3 - costPerTask / 0.5); // ~$0.50/task baseline
    }
    if (!best || score > best.score) {
      best = { roleId: role.id, roleName: role.role || role.name, score, covered, missing };
    }
  }

  if (!best) return null;
  const priority = (task.priority as keyof typeof TOKEN_PER_COMPLEXITY) ?? "P2";
  const estTokens = TOKEN_PER_COMPLEXITY[priority] ?? TOKEN_PER_COMPLEXITY.P2;
  const estCost = Math.round(estTokens * 0.0000008 * 100) / 100; // ~$0.8/M tokens
  const eff = roleEfficiency.get(best.roleId);
  return {
    taskId: task.id,
    taskTitle: task.title,
    roleId: best.roleId,
    roleName: best.roleName,
    score: Math.round(best.score * 100) / 100,
    skillsCovered: best.covered,
    skillsMissing: best.missing,
    estTokens,
    estCost,
    note: eff && eff.done > 0 ? `Historical cost/task ≈ $${(eff.cost / eff.done).toFixed(2)} across ${eff.done} done.` : "No historical cost yet — estimate based on priority.",
  };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export interface AssignOpts {
  roleId?: string;
  assignee?: string;
  modelTier?: ModelTier;
  tokenBudget?: number;
  note?: string;
}

/** Assign a task to a role/assignee; returns the created assignment id. */
export function assignTask(store: ExecutiveStore, taskId: string, opts: AssignOpts = {}): string {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const skills = store.listTaskSkills(task.id);
  const required = skills.length > 0 ? skills : inferTaskSkills(task);
  const rec = recommendAssignment(store, task);
  const roleId = opts.roleId ?? rec?.roleId;
  const skillMatched =
    rec && roleId === rec.roleId ? (rec.skillsCovered.length > 0 ? 1 : 0) : 0;
  const priority = (task.priority as keyof typeof TOKEN_PER_COMPLEXITY) ?? "P2";
  const estTokens = opts.tokenBudget ?? (TOKEN_PER_COMPLEXITY[priority] ?? TOKEN_PER_COMPLEXITY.P2);
  const id = newId("asg");
  const now = nowIso();
  store.insertAssignment({
    id,
    task_id: taskId,
    role_id: roleId,
    assignee: opts.assignee,
    status: "ASSIGNED",
    priority: String(task.priority),
    skill_matched: skillMatched,
    model_tier: opts.modelTier ?? "medium",
    token_budget: estTokens,
    tokens_used: 0,
    cost_estimate: Math.round(estTokens * 0.0000008 * 100) / 100,
    cost_actual: 0,
    started_at: now,
    note: opts.note,
    source: "manager",
    created_at: now,
    updated_at: now,
  });
  if (roleId) {
    store.updateTask(taskId, { assignee_person_id: roleId } as never);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Token budgets
// ---------------------------------------------------------------------------

export interface BudgetStatusEntry {
  scope: string;
  scopeId?: string;
  dailyBudget?: number;
  monthlyBudget?: number;
  tokensUsedToday: number;
  tokensUsedMonth: number;
  costToday: number;
  costMonth: number;
  usagePctMonth: number;
  status: "OK" | "WARN" | "OVER";
  modelTier?: string;
}

/** Current budget posture across all scopes. */
export function budgetStatus(store: ExecutiveStore): BudgetStatusEntry[] {
  return store.listTokenBudgets().map((b) => {
    const monthly = b.monthly_budget ?? DEFAULT_MONTHLY_BUDGET;
    const pct = monthly > 0 ? (b.tokens_used_month / monthly) * 100 : 0;
    const status: BudgetStatusEntry["status"] = pct >= 90 ? "OVER" : pct >= 60 ? "WARN" : "OK";
    return {
      scope: b.scope,
      scopeId: b.scope_id,
      dailyBudget: b.daily_budget,
      monthlyBudget: b.monthly_budget,
      tokensUsedToday: b.tokens_used_today,
      tokensUsedMonth: b.tokens_used_month,
      costToday: b.cost_used_today,
      costMonth: b.cost_used_month,
      usagePctMonth: Math.round(pct * 100) / 100,
      status,
      modelTier: b.model_tier,
    };
  });
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

export interface OptimizationResult {
  events: Array<{ kind: string; scope: string; scopeId?: string; reason: string; applied: boolean; impact: string }>;
  summary: { applied: number; recommended: number };
}

/**
 * Run optimization heuristics. Safe + reversible changes are APPLIED
 * (recorded as optimization_events with applied=1); judgment calls are
 * recorded as recommendations (applied=0) for the Founder/Executive.
 */
export function optimize(store: ExecutiveStore, env: Record<string, string | undefined>): OptimizationResult {
  const events: OptimizationResult["events"] = [];
  const now = nowIso();

  // 1. Safe: stale assignments → STALLED.
  const stalled = store.reapStaleAssignments(STALE_ASSIGNMENT_MS);
  if (stalled.length) {
    events.push({
      kind: "stale_assignment_fixed",
      scope: "assignment",
      reason: `${stalled.length} assignment(s) with no progress in 48h auto-marked STALLED.`,
      applied: true,
      impact: `reclaimed ${stalled.length} stalled assignment(s)`,
    });
    store.insertOptimizationEvent({ kind: "stale_assignment_fixed", scope: "assignment", reason: events[events.length - 1]!.reason, impact_json: JSON.stringify({ ids: stalled }), applied: 1 });
  }

  // 2. Safe: recalibrate global budget from env defaults (keeps budget in
  //    line with the founder's wrangler vars).
  const envDaily = numEnv(env.AI_DAILY_TOKEN_BUDGET) ?? DEFAULT_DAILY_BUDGET;
  const envMonthly = numEnv(env.AI_MONTHLY_TOKEN_BUDGET) ?? DEFAULT_MONTHLY_BUDGET;
  const g = store.getTokenBudget("global");
  if (g && (g.daily_budget !== envDaily || g.monthly_budget !== envMonthly)) {
    store.recalibrateGlobalBudget(envDaily, envMonthly);
    events.push({
      kind: "budget_recalibrated",
      scope: "global",
      reason: `Global budget aligned to env defaults (${envDaily}/day, ${envMonthly}/month).`,
      applied: true,
      impact: "budget recalibrated",
    });
    store.insertOptimizationEvent({ kind: "budget_recalibrated", scope: "global", reason: events[events.length - 1]!.reason, applied: 1 });
  }

  // 3. Safe: release budget from under-utilized scopes to over-utilized ones.
  const budgets = budgetStatus(store);
  const over = budgets.find((b) => b.status === "OVER" && b.monthlyBudget);
  const under = budgets.find((b) => b.status === "OK" && b.usagePctMonth < 20 && b.monthlyBudget);
  if (over && under && over.scope !== under.scope) {
    const release = Math.round((under.monthlyBudget ?? 0) * 0.1);
    const topUp = Math.round((over.monthlyBudget ?? 0) * 0.1);
    store.upsertTokenBudget({ scope: under.scope, scopeId: under.scopeId, monthlyBudget: (under.monthlyBudget ?? 0) - release });
    store.upsertTokenBudget({ scope: over.scope, scopeId: over.scopeId, monthlyBudget: (over.monthlyBudget ?? 0) + topUp });
    events.push({
      kind: "budget_reallocated",
      scope: over.scope,
      scopeId: over.scopeId,
      reason: `Reallocated ${release} tokens from under-utilized ${under.scope} to ${over.scope} (over budget).`,
      applied: true,
      impact: `${over.scope} +${topUp}, ${under.scope} -${release}`,
    });
    store.insertOptimizationEvent({ kind: "budget_reallocated", scope: over.scope, scopeId: over.scopeId, reason: events[events.length - 1]!.reason, impact_json: JSON.stringify({ from: under.scope, to: over.scope, amount: release }), applied: 1 });
  }

  // 4. Recommendation: batch small same-priority tasks into one run.
  const tasks = store.listTasks({ limit: 200 }).filter((t) => t.status === "OPEN");
  const byPriority = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = String(t.priority ?? "P2");
    if (!byPriority.has(key)) byPriority.set(key, []);
    byPriority.get(key)!.push(t);
  }
  for (const [prio, group] of byPriority) {
    if (group.length >= 3) {
      const ids = group.slice(0, 5).map((t) => t.id);
      events.push({
        kind: "batch_suggested",
        scope: "task",
        reason: `${group.length} OPEN ${prio} tasks could be batched into one agent run to cut per-run overhead.`,
        applied: false,
        impact: `batch ${ids.length} tasks`,
      });
      store.insertOptimizationEvent({ kind: "batch_suggested", scope: "task", reason: events[events.length - 1]!.reason, impact_json: JSON.stringify({ taskIds: ids }), applied: 0 });
      break;
    }
  }

  // 5. Recommendation: skill gaps (tasks requiring skills no role has).
  const roleSkills = store.listRoleSkills();
  const allSkills = new Set(roleSkills.map((rs) => rs.skill));
  const skillsByTask = new Map<string, { skill: string; weight: number }[]>();
  for (const t of tasks.slice(0, 100)) {
    const sk = store.listTaskSkills(t.id);
    skillsByTask.set(t.id, sk.length ? sk : inferTaskSkills(t));
  }
  const missingSkills = new Set<string>();
  for (const list of skillsByTask.values()) {
    for (const s of list) if (!allSkills.has(s.skill)) missingSkills.add(s.skill);
  }
  if (missingSkills.size) {
    events.push({
      kind: "skill_gap",
      scope: "organization",
      reason: `Skills no role covers: ${[...missingSkills].join(", ")}. Add to a role or expect higher cost/misassignment.`,
      applied: false,
      impact: `gap: ${[...missingSkills].join(", ")}`,
    });
    store.insertOptimizationEvent({ kind: "skill_gap", scope: "organization", reason: events[events.length - 1]!.reason, impact_json: JSON.stringify({ skills: [...missingSkills] }), applied: 0 });
  }

  // 6. Recommendation: model tier suggestion for heavy read/query scopes.
  for (const b of budgets) {
    if (b.tokensUsedMonth > 0 && b.modelTier === "strong" && b.scope !== "global") {
      events.push({
        kind: "model_tier_suggested",
        scope: b.scope,
        scopeId: b.scopeId,
        reason: `${b.scope} uses ${b.tokensUsedMonth.toLocaleString()} tokens/month on the strongest tier — consider cheap/medium for read-heavy work.`,
        applied: false,
        impact: "cheaper tier for read-heavy work",
      });
      store.insertOptimizationEvent({ kind: "model_tier_suggested", scope: b.scope, scopeId: b.scopeId, reason: events[events.length - 1]!.reason, applied: 0 });
    }
  }

  return {
    events,
    summary: {
      applied: events.filter((e) => e.applied).length,
      recommended: events.filter((e) => !e.applied).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Contradiction / misconception resolution
// ---------------------------------------------------------------------------

export interface ContradictionDetection {
  found: Array<{ kind: string; subjectA: string; subjectB: string; claimA: string; claimB: string }>;
  created: number;
}

/**
 * Structural scan for contradictions/misconceptions. Deterministic and
 * idempotent (identical OPEN findings are not duplicated).
 */
export function detectContradictions(store: ExecutiveStore): ContradictionDetection {
  const found: ContradictionDetection["found"] = [];
  let created = 0;

  const add = (kind: string, subjectA: string, subjectB: string, claimA: string, claimB: string): boolean => {
    found.push({ kind, subjectA, subjectB, claimA, claimB });
    const inserted = store.insertContradiction({ kind, subject_a: subjectA, subject_b: subjectB, claim_a: claimA, claim_b: claimB, status: "OPEN" });
    if (inserted) created += 1;
    return inserted;
  };

  // 1. Decision approved/done but linked task still open (stale decision).
  const decisions = store.listDecisions({ limit: 500 });
  const tasks = store.listTasks({ limit: 1000 });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const d of decisions) {
    if (d.status !== "DONE" && d.status !== "DECIDED") continue;
    const linked = tasks.filter((t) => t.decision_id === d.id && (t.status === "OPEN" || t.status === "IN_PROGRESS"));
    for (const t of linked) {
      add(
        "task.approved_but_open",
        `decision:${d.id}`,
        `task:${t.id}`,
        `Decision "${d.title}" is ${d.status}`,
        `Task "${t.title}" is still ${t.status}`,
      );
    }
  }

  // 2. Task done but an agent run for it is still RUNNING.
  const runs = store.listAgentRuns(500);
  for (const r of runs) {
    if (r.status !== "RUNNING" || !r.task_id) continue;
    const t = byId.get(r.task_id);
    if (t && t.status === "DONE") {
      add(
        "task.done_but_run",
        `task:${t.id}`,
        `run:${r.id}`,
        `Task "${t.title}" is DONE`,
        `Agent run ${r.id} still RUNNING for it`,
      );
    }
  }

  // 3. Duplicate open tasks (same normalized title — likely duplication).
  const seen = new Map<string, Task>();
  for (const t of tasks) {
    if (t.status !== "OPEN") continue;
    const key = normalizeTitle(t.title);
    const prev = seen.get(key);
    if (prev) {
      add(
        "duplicate_tasks",
        `task:${prev.id}`,
        `task:${t.id}`,
        `"${prev.title}" is OPEN`,
        `"${t.title}" is OPEN (same title)`,
      );
    } else {
      seen.set(key, t);
    }
  }

  // 4. Product SHIPPED but Gate 10 not SHIPPED (pipeline contradiction).
  const products = store.listProducts();
  const gates = store.listPipelineGates();
  for (const p of products) {
    if (p.status !== "SHIPPED") continue;
    const g10 = gates.find((g) => g.plugin_id === p.name && g.gate_number === 10);
    if (g10 && g10.status !== "SHIPPED") {
      add(
        "product.shipped_but_gate",
        `product:${p.id}`,
        `gate:${g10.id}`,
        `Product "${p.name}" is SHIPPED`,
        `Gate 10 for "${p.name}" is ${g10.status}`,
      );
    }
  }

  // 5. Auto-run task that is BLOCKED (wants to run but can't).
  for (const t of tasks) {
    if (t.auto_run === 1 && t.status === "BLOCKED") {
      add(
        "auto_run_but_blocked",
        `task:${t.id}`,
        "auto_run",
        `Task "${t.title}" is marked auto-run`,
        `Task is BLOCKED — no autonomous progress possible`,
      );
    }
  }

  // 6. Misassignment: assignment whose role lacks a required skill.
  const roleSkills = store.listRoleSkills();
  const skillsByRole = new Map<string, Set<string>>();
  for (const rs of roleSkills) {
    if (!skillsByRole.has(rs.role_id)) skillsByRole.set(rs.role_id, new Set());
    skillsByRole.get(rs.role_id)!.add(rs.skill);
  }
  for (const a of store.listAssignments({ status: "ASSIGNED", limit: 200 })) {
    if (!a.role_id) continue;
    const task = byId.get(a.task_id);
    if (!task) continue;
    const req = store.listTaskSkills(a.task_id);
    const required = req.length ? req : inferTaskSkills(task);
    const has = skillsByRole.get(a.role_id) ?? new Set<string>();
    const missing = required.filter((s) => !has.has(s.skill)).map((s) => s.skill);
    if (missing.length) {
      add(
        "assignment_skill_gap",
        `assignment:${a.id}`,
        `task:${a.task_id}`,
        `Assigned to ${a.role_id}`,
        `Role lacks skills: ${missing.join(", ")}`,
      );
    }
  }

  // 7. Budget override vs env default mismatch (>10x — likely misconception).
  const overrides = store.getBudgetOverrides();
  const daily = numEnv(process.env.AI_DAILY_BUDGET) ?? 5;
  const monthly = numEnv(process.env.AI_MONTHLY_BUDGET) ?? 80;
  if (overrides.aiDailyBudget && overrides.aiDailyBudget > daily * 10) {
    add(
      "budget_override_mismatch",
      "settings:aiDailyBudget",
      "env:AI_DAILY_BUDGET",
      `Daily override is $${overrides.aiDailyBudget}`,
      `Env default is $${daily} — ${overrides.aiDailyBudget > daily * 10 ? "10x+ higher (possible misconception)" : "different"}`,
    );
  }
  if (overrides.aiMonthlyBudget && overrides.aiMonthlyBudget > monthly * 10) {
    add(
      "budget_override_mismatch",
      "settings:aiMonthlyBudget",
      "env:AI_MONTHLY_BUDGET",
      `Monthly override is $${overrides.aiMonthlyBudget}`,
      `Env default is $${monthly} — 10x+ higher (possible misconception)`,
    );
  }

  return { found, created };
}
// ---------------------------------------------------------------------------
// Report + daily rollup
// ---------------------------------------------------------------------------

export interface ProductivityReport {
  generatedAt: string;
  budget: BudgetStatusEntry[];
  assignments: {
    total: number;
    byStatus: Record<string, number>;
    open: number;
  };
  contradictions: { open: number; resolved: number };
  optimizationEvents: { total: number; applied: number; recent: number };
  metrics: Array<{ day: string; tasksDone: number; tokensUsed: number; cost: number; tasksPerDollar: number; avgTokensPerTask: number }>;
  efficiency: Array<{ roleId: string; roleName: string; done: number; cost: number; costPerTask: number }>;
  today: { tokens: number; cost: number };
}

/** Assemble the full productivity report. */
export function productivityReport(store: ExecutiveStore): ProductivityReport {
  const assignments = store.listAssignments({ limit: 500 });
  const byStatus: Record<string, number> = {};
  for (const a of assignments) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  const events = store.listOptimizationEvents(500);
  const persons = new Map(store.listPersons().map((p) => [p.id, p.role || p.name]));
  const eff = new Map<string, { done: number; cost: number }>();
  for (const a of assignments) {
    if (a.status !== "DONE" || !a.role_id) continue;
    const e = eff.get(a.role_id) ?? { done: 0, cost: 0 };
    e.done += 1;
    e.cost += a.cost_actual;
    eff.set(a.role_id, e);
  }

  return {
    generatedAt: nowIso(),
    budget: budgetStatus(store),
    assignments: {
      total: assignments.length,
      byStatus,
      open: assignments.filter((a) => a.status === "ASSIGNED" || a.status === "IN_PROGRESS").length,
    },
    contradictions: {
      open: store.countOpenContradictions(),
      resolved: store.listContradictions({ status: "RESOLVED", limit: 500 }).length,
    },
    optimizationEvents: {
      total: events.length,
      applied: events.filter((e) => e.applied === 1).length,
      recent: events.length,
    },
    metrics: store.listProductivityMetrics(14).map((m) => ({
      day: m.day,
      tasksDone: m.tasks_done,
      tokensUsed: m.tokens_used,
      cost: m.cost,
      tasksPerDollar: m.tasks_per_dollar,
      avgTokensPerTask: m.avg_tokens_per_task,
    })),
    efficiency: [...eff.entries()]
      .map(([roleId, e]) => ({
        roleId,
        roleName: persons.get(roleId) ?? roleId,
        done: e.done,
        cost: Math.round(e.cost * 100) / 100,
        costPerTask: e.done > 0 ? Math.round((e.cost / e.done) * 100) / 100 : 0,
      }))
      .sort((a, b) => a.costPerTask - b.costPerTask),
    today: { tokens: store.tokensToday(), cost: store.tokensToday() * 0.0000008 },
  };
}

/** Compute and store today's rollup metric (idempotent per day). */
export function dailyRollup(store: ExecutiveStore): void {
  const tasksDone = store.listTasks({ limit: 1000 }).filter((t) => {
    const d = t.completed_at ?? t.updated_at;
    return t.status === "DONE" && d?.startsWith(new Date().toISOString().slice(0, 10));
  }).length;
  const tokens = store.tokensToday();
  const cost = tokens * 0.0000008;
  store.upsertProductivityMetric(new Date().toISOString().slice(0, 10), {
    tasks_done: tasksDone,
    tokens_used: tokens,
    cost: Math.round(cost * 100) / 100,
  });
}

// ---------------------------------------------------------------------------

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
