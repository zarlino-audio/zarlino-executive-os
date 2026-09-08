import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
import {
  assignTask,
  budgetStatus,
  dailyRollup,
  detectContradictions,
  inferTaskSkills,
  normalizeTitle,
  optimize,
  productivityReport,
  recommendAssignment,
} from "../src/core/productivity/manager";

describe("Productivity Manager (node:sqlite)", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });

  it("migration v18 creates productivity tables and seeds role skills", () => {
    // Tables exist and are queryable.
    expect(store.listAssignments({ limit: 1 })).toEqual([]);
    expect(store.listRoleSkills().length).toBeGreaterThanOrEqual(20);
    expect(store.getTokenBudget("global")?.scope).toBe("global");
    expect(store.listContradictions({ limit: 1 })).toEqual([]);
    expect(store.listProductivityMetrics(5)).toEqual([]);
    expect(store.listOptimizationEvents(5)).toEqual([]);
  });

  it("infers required skills from a task title/description", () => {
    const skills = inferTaskSkills({ title: "Fix DSP noise floor in ZTame", description: "Improve the noise suppressor algorithm in C++" });
    expect(skills.some((s) => s.skill === "dsp_implementation")).toBe(true);
    expect(skills.some((s) => s.skill === "cpp")).toBe(true);
  });

  it("normalizes titles for duplicate detection", () => {
    expect(normalizeTitle("  Fix  the   Bug!! ")).toBe("fix the bug");
    expect(normalizeTitle("Fix the Bug")).toBe("fix the bug");
  });

  it("recommends a role by skill coverage", () => {
    const task = createTask({ title: "Implement a DSP compressor", priority: "P1", source: "test" });
    store.insertTask(task);
    store.setTaskSkills(task.id, [{ skill: "dsp_implementation", weight: 2 }, { skill: "cpp", weight: 1 }]);
    const rec = recommendAssignment(store, task);
    expect(rec).not.toBeNull();
    expect(rec!.roleId).toBe("person_role_dsp_engineer");
    expect(rec!.skillsCovered).toContain("dsp_implementation");
    expect(rec!.estTokens).toBeGreaterThan(0);
  });

  it("assigns a task with token budget and cost estimate", () => {
    const task = createTask({ title: "Write QA tests for ZScorch", priority: "P2", source: "test" });
    store.insertTask(task);
    const id = assignTask(store, task.id, { roleId: "person_role_qa_engineer", modelTier: "cheap" });
    const asg = store.getAssignment(id);
    expect(asg).not.toBeNull();
    expect(asg!.role_id).toBe("person_role_qa_engineer");
    expect(asg!.status).toBe("ASSIGNED");
    expect(asg!.token_budget).toBeGreaterThan(0);
    expect(asg!.cost_estimate).toBeGreaterThan(0);
    // Assigning also links the task to the role.
    expect(store.getTask(task.id)?.assignee_person_id).toBe("person_role_qa_engineer");
  });

  it("tracks token usage against scope budgets and assignment actuals", () => {
    const task = createTask({ title: "Track usage task", priority: "P3", source: "test" });
    store.insertTask(task);
    const id = assignTask(store, task.id, { roleId: "person_role_research_engineer" });
    store.addTokenUse("task", task.id, 5000, 0.004);
    const asg = store.getAssignment(id);
    expect(asg!.tokens_used).toBe(5000);
    expect(asg!.cost_actual).toBeCloseTo(0.004);
    const budget = store.getTokenBudget("task", task.id);
    expect(budget!.tokens_used_today).toBe(5000);
  });

  it("reports budget status with OVER/WARN flags", () => {
    const g = store.getTokenBudget("global")!;
    store.upsertTokenBudget({ scope: "global", dailyBudget: 1000, monthlyBudget: 1000 });
    store.addTokenUse("global", undefined, 950, 0.001);
    const statuses = budgetStatus(store);
    const global = statuses.find((s) => s.scope === "global")!;
    expect(global.status).toBe("OVER");
    expect(global.usagePctMonth).toBe(95);
    // Restore global budget so later tests aren't affected.
    store.upsertTokenBudget({ scope: "global", dailyBudget: g.daily_budget, monthlyBudget: g.monthly_budget });
  });

  it("optimize applies safe fixes: stale assignments + budget recalibration", () => {
    const task = createTask({ title: "Stale task", priority: "P3", source: "test" });
    store.insertTask(task);
    const id = assignTask(store, task.id, { roleId: "person_role_research_engineer" });
    // Backdate the assignment so it looks stale (3 days = 3 * 24 * 3600 * 1000 ms).
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    store.updateAssignment(id, { started_at: old } as never);
    const result = optimize(store, {});
    expect(result.summary.applied).toBeGreaterThanOrEqual(1);
    expect(store.getAssignment(id)?.status).toBe("STALLED");
    expect(store.listOptimizationEvents(50).length).toBeGreaterThanOrEqual(1);
  });

  it("detects contradictions: duplicate tasks and done-but-running", () => {
    // Duplicate open tasks.
    const t1 = createTask({ title: "Fix duplicate issue", priority: "P2", source: "test" });
    const t2 = createTask({ title: "fix DUPLICATE issue", priority: "P2", source: "test" });
    store.insertTask(t1);
    store.insertTask(t2);

    // Done task with a running run.
    const t3 = createTask({ title: "Done task with run", priority: "P2", source: "test" });
    store.insertTask(t3);
    store.updateTask(t3.id, { status: "DONE", completed_at: new Date().toISOString() } as never);
    const now = new Date().toISOString();
    store.createAgentRun({
      id: "run_contra", prompt: "x", status: "RUNNING", iterations: 0, tools_called: 0,
      task_id: t3.id, started_at: now, source: "test", created_at: now, updated_at: now,
      last_heartbeat: now,
    });

    const result = detectContradictions(store);
    const kinds = result.found.map((f) => f.kind);
    expect(kinds).toContain("duplicate_tasks");
    expect(kinds).toContain("task.done_but_run");

    // Idempotent: a second detection does not duplicate findings.
    const again = detectContradictions(store);
    expect(again.created).toBe(0);
  });

  it("resolves a contradiction with an audit trail", () => {
    const open = store.listContradictions({ status: "OPEN", limit: 10 });
    expect(open.length).toBeGreaterThan(0);
    const c = open[0]!;
    store.resolveContradiction(c.id, "RESOLVED", "Duplicate task merged into the canonical one.", "test");
    expect(store.getContradiction(c.id)?.status).toBe("RESOLVED");
    expect(store.countOpenContradictions()).toBeLessThan(open.length);
  });

  it("builds a productivity report and daily rollup", () => {
    const report = productivityReport(store);
    expect(report.assignments.total).toBeGreaterThan(0);
    expect(report.contradictions.open).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.budget)).toBe(true);
    expect(Array.isArray(report.efficiency)).toBe(true);
    dailyRollup(store);
    expect(store.listProductivityMetrics(5).length).toBeGreaterThanOrEqual(1);
  });
});
