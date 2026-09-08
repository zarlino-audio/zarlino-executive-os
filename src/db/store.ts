/**
 * ExecutiveStore — typed data access over the Sql abstraction.
 *
 * This is the durable brain of the Executive OS (spec §4). It runs unchanged
 * on:
 *   - the Durable Object's embedded SQLite (production),
 *   - node:sqlite (tests / local tooling).
 *
 * Every important record carries provenance. JSON is used only for flexible
 * metadata columns, never as the primary store (spec §31).
 */

import { migrate } from "./migrations";
import { PRODUCT_METRICS_SQL } from "./schema";
import { newId } from "../ids";
import type { Sql, SqlParam } from "./sql";
import type {
  AgentRun,
  ApprovalRequest,
  AuditEvent,
  CalendarEvent,
  ChatMessage,
  Contact,
  Contradiction,
  ContradictionStatus,
  Decision,
  Department,
  DoctrineRule,
  DoctorLog,
  EngineeringIssue,
  ExecutiveStateRow,
  FinancialSnapshot,
  LocalTask,
  MarketingCampaign,
  Memory,
  Metric,
  Note,
  Objective,
  OptimizationEvent,
  Organization,
  OrgAgent,
  OrgArbiter,
  OrgAnalystReport,
  OrgCapabilityGrant,
  OrgChaosTest,
  OrgIncident,
  OrgMemory,
  OrgMessage,
  OrgMessageType,
  OrgNegotiation,
  OrgNegotiationRound,
  OrgPlan,
  OrgPlanDeviation,
  OrgPlanStep,
  OrgRole,
  OrgTopologyProposal,
  OrgTrust,
  PerceptualEvaluator,
  PerceptualKnowledge,
  PerceptualResult,
  PerceptualTest,
  Person,
  PipelineGate,
  Policy,
  Product,
  ProductValidation,
  PostObjectiveRecord,
  ProductivityAssignment,
  ProductivityMetric,
  ProductStatusRecord,
  Project,
  ReasoningTrace,
  Reminder,
  ReviewItem,
  Risk,
  RoleSkill,
  Task,
  TaskSkill,
  TokenBudget,
  ToolExecution,
  UploadedFile,
  Workstream,
  FailureAnalysis,
} from "../types";
import { retrieve, scoreMemory } from "../core/memory/retrieval";
import { applyTrustEvidence, decayedTrust, TRUST_INITIAL } from "../core/org/trust";
import { capabilityVerdictForRole, type CapabilityDecision } from "../core/org/governance";
import { allowedRoundKinds, negotiationPhase } from "../core/org/negotiation";
import type { ModelCallRecord } from "../core/model/types";
import type { CostStorage } from "../core/model/cost";

type Row = Record<string, unknown>;

export class ExecutiveStore implements CostStorage {
  constructor(private readonly sql: Sql) {}

  // -- migrations ---------------------------------------------------------
  migrate(): number[] {
    return migrate(this.sql).map((m) => m.version);
  }

  // -- generic helpers ----------------------------------------------------
  private insert(table: string, row: object): void {
    const rec = row as Record<string, unknown>;
    const keys = Object.keys(rec);
    const cols = keys.join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    this.sql.run(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
      ...keys.map((k) => normalize(rec[k])),
    );
  }

  private update(table: string, id: string, patch: object): void {
    const rec = patch as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.sql.run(`UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`, ...keys.map((k) => normalize(rec[k])), new Date().toISOString(), id);
  }

  // -- executive state ----------------------------------------------------
  getExecutiveState(): ExecutiveStateRow | null {
    const rows = this.sql.all<Row>("SELECT * FROM executive_state WHERE id = ?", "zarlino");
    if (rows.length === 0) return null;
    return rowTo<ExecutiveStateRow>(rows[0]!);
  }

  ensureExecutiveState(): ExecutiveStateRow {
    const existing = this.getExecutiveState();
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: ExecutiveStateRow = {
      id: "zarlino",
      overall_status: "GREEN",
      current_objective_id: undefined,
      top_priorities_json: "[]",
      paused: 0,
      autonomy_mode: "CONTROLLED",
      spending_disabled: 0,
      deployments_disabled: 0,
      delegate_mode: 0,
      full_access: 0,
      updated_at: now,
    };
    this.insert("executive_state", state);
    return state;
  }

  updateExecutiveState(patch: Partial<Omit<ExecutiveStateRow, "id">>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.sql.run(`UPDATE executive_state SET ${sets}, updated_at = ? WHERE id = ?`, ...keys.map((k) => normalize(patch[k as keyof typeof patch])), new Date().toISOString(), "zarlino");
  }

  // -- founder profile / organization -------------------------------------
  upsertFounderProfile(profile: { id: string; name: string; email?: string; role: string }): void {
    const now = new Date().toISOString();
    const existing = this.sql.all<Row>("SELECT id FROM founder_profile WHERE id = ?", profile.id);
    if (existing.length > 0) {
      this.sql.run("UPDATE founder_profile SET name = ?, email = ?, role = ?, updated_at = ? WHERE id = ?", profile.name, profile.email ?? null, profile.role, now, profile.id);
    } else {
      this.insert("founder_profile", { id: profile.id, name: profile.name, email: profile.email ?? null, role: profile.role, authority_level: "FOUNDER", created_at: now, updated_at: now });
    }
  }

  insertOrganization(org: Organization): void {
    this.insert("organizations", org);
  }

  getOrganization(id: string): Organization | null {
    const rows = this.sql.all<Row>("SELECT * FROM organizations WHERE id = ?", id);
    return rows.length ? rowTo<Organization>(rows[0]) : null;
  }

  // -- objectives ---------------------------------------------------------
  insertObjective(o: Objective): void {
    this.insert("objectives", o);
  }
  listObjectives(status?: string): Objective[] {
    const rows = status
      ? this.sql.all<Row>("SELECT * FROM objectives WHERE status = ? ORDER BY priority ASC, created_at ASC", status)
      : this.sql.all<Row>("SELECT * FROM objectives ORDER BY priority ASC, created_at ASC");
    return rows.map((r) => rowTo<Objective>(r));
  }
  getObjective(id: string): Objective | null {
    const rows = this.sql.all<Row>("SELECT * FROM objectives WHERE id = ?", id);
    return rows.length ? rowTo<Objective>(rows[0]) : null;
  }

  // -- projects -----------------------------------------------------------
  insertProject(p: Project): void {
    this.insert("projects", p);
  }
  listProjects(): Project[] {
    return this.sql.all<Row>("SELECT * FROM projects ORDER BY priority ASC, created_at ASC").map((r) => rowTo<Project>(r));
  }
  getProject(id: string): Project | null {
    const rows = this.sql.all<Row>("SELECT * FROM projects WHERE id = ?", id);
    return rows.length ? rowTo<Project>(rows[0]) : null;
  }
  updateProject(id: string, patch: Partial<Project>): void {
    this.update("projects", id, patch as Row);
  }

  // -- tasks --------------------------------------------------------------
  insertTask(t: Task): void {
    this.insert("tasks", t);
  }
  listTasks(opts?: { status?: string; projectId?: string; decisionId?: string; limit?: number }): Task[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts?.projectId) { sql += " AND project_id = ?"; params.push(opts.projectId); }
    if (opts?.decisionId) { sql += " AND decision_id = ?"; params.push(opts.decisionId); }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<Task>(r));
  }
  /**
   * Tasks eligible for AUTONOMOUS execution (auto-run): auto_run=1, not done,
   * ordered by priority then oldest-first. The Executive sweep runs these
   * without any Founder click (skipped only when a decision needs approval).
   */
  listAutoRunnableTasks(limit = 20): Task[] {
    const rows = this.sql.all<Row>(
      "SELECT * FROM tasks WHERE auto_run = 1 AND status IN ('OPEN','IN_PROGRESS') " +
        "ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at ASC LIMIT ?",
      limit,
    );
    return rows.map((r) => rowTo<Task>(r));
  }
  /** True if an agent run is currently executing for this task. */
  hasRunningRunForTask(taskId: string): boolean {
    const rows = this.sql.all<Row>("SELECT id FROM agent_jobs WHERE task_id = ? AND status = 'RUNNING' LIMIT 1", taskId);
    return rows.length > 0;
  }
  /** Number of agent runs currently executing (auto-run concurrency guard). */
  countRunningAgentRuns(): number {
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM agent_jobs WHERE status = 'RUNNING'");
    return Number(rows[0]?.c ?? 0);
  }
  /** True if the task's decision has a PENDING approval (needs the Founder). */
  pendingApprovalForTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task?.decision_id) return false;
    const rows = this.sql.all<Row>(
      "SELECT id FROM approval_requests WHERE decision_id = ? AND status = 'PENDING' LIMIT 1",
      task.decision_id,
    );
    return rows.length > 0;
  }
  getTask(id: string): Task | null {
    const rows = this.sql.all<Row>("SELECT * FROM tasks WHERE id = ?", id);
    return rows.length ? rowTo<Task>(rows[0]) : null;
  }
  updateTask(id: string, patch: Partial<Task>): void {
    this.update("tasks", id, patch as Row);
  }
  countOpenTasks(): number {
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('OPEN','IN_PROGRESS','BLOCKED')");
    return Number(rows[0]?.c ?? 0);
  }

  // -- decisions ----------------------------------------------------------
  insertDecision(d: Decision): void {
    this.insert("decisions", d);
  }
  listDecisions(opts?: { status?: string; category?: string; limit?: number }): Decision[] {
    let sql = "SELECT * FROM decisions WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts?.category) { sql += " AND category = ?"; params.push(opts.category); }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit) sql += " LIMIT ?";
    if (opts?.limit) params.push(opts.limit);
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<Decision>(r));
  }
  getDecision(id: string): Decision | null {
    const rows = this.sql.all<Row>("SELECT * FROM decisions WHERE id = ?", id);
    return rows.length ? rowTo<Decision>(rows[0]) : null;
  }
  updateDecision(id: string, patch: Partial<Decision>): void {
    this.update("decisions", id, patch as Row);
  }

  // -- approvals ----------------------------------------------------------
  insertApproval(a: ApprovalRequest): void {
    this.insert("approval_requests", a);
  }
  listApprovals(opts?: { status?: string; limit?: number }): ApprovalRequest[] {
    const where = opts?.status ? "WHERE status = ?" : "";
    const params: SqlParam[] = opts?.status ? [opts.status] : [];
    let sql = `SELECT * FROM approval_requests ${where} ORDER BY created_at DESC`;
    if (opts?.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<ApprovalRequest>(r));
  }
  getApproval(id: string): ApprovalRequest | null {
    const rows = this.sql.all<Row>("SELECT * FROM approval_requests WHERE id = ?", id);
    return rows.length ? rowTo<ApprovalRequest>(rows[0]) : null;
  }
  updateApproval(id: string, patch: Partial<ApprovalRequest>): void {
    this.update("approval_requests", id, patch as Row);
  }

  // -- review queue (sound / UI / artifact vetting by a remote operator) -----
  createReviewItem(r: ReviewItem): void {
    this.insert("review_items", r);
  }
  listReviewItems(opts: { status?: string; limit?: number } = {}): ReviewItem[] {
    const where = opts.status ? "WHERE status = ?" : "";
    const params: SqlParam[] = opts.status ? [opts.status] : [];
    let sql = `SELECT * FROM review_items ${where} ORDER BY created_at DESC`;
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<ReviewItem>(r));
  }
  getReviewItem(id: string): ReviewItem | null {
    const rows = this.sql.all<Row>("SELECT * FROM review_items WHERE id = ?", id);
    return rows.length ? rowTo<ReviewItem>(rows[0]) : null;
  }
  countPendingReviews(): number {
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM review_items WHERE status = 'PENDING'");
    return Number(rows[0]?.c ?? 0);
  }
  decideReviewItem(id: string, status: "APPROVED" | "REJECTED" | "NEEDS_WORK", note: string, by: string): void {
    this.sql.run(
      "UPDATE review_items SET status = ?, note = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?",
      status, note, new Date().toISOString(), by, new Date().toISOString(), id,
    );
  }

  // -- AOrgI org registry (migration v23) ----------------------------------
  // Departments, role manifests and the agent-instance registry (AOrgI §5, §9,
  // §24). Instances are NOT roles: rows here appear only when a real runtime
  // registers with a heartbeat.
  listDepartments(): Department[] {
    return this.sql.all<Row>("SELECT * FROM departments ORDER BY name ASC").map((r) => rowTo<Department>(r));
  }
  getDepartment(id: string): Department | null {
    const rows = this.sql.all<Row>("SELECT * FROM departments WHERE id = ?", id);
    return rows[0] ? rowTo<Department>(rows[0]) : null;
  }

  listOrgRoles(opts: { departmentId?: string; status?: string } = {}): OrgRole[] {
    let sql = "SELECT * FROM org_roles WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.departmentId) { sql += " AND department_id = ?"; params.push(opts.departmentId); }
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY department_id ASC, name ASC";
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgRole>(r));
  }
  getOrgRole(id: string): OrgRole | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_roles WHERE id = ?", id);
    return rows[0] ? rowTo<OrgRole>(rows[0]) : null;
  }

  listOrgAgents(opts: { roleId?: string; limit?: number } = {}): OrgAgent[] {
    let sql = "SELECT * FROM org_agents WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.roleId) { sql += " AND role_id = ?"; params.push(opts.roleId); }
    sql += " ORDER BY last_seen DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgAgent>(r));
  }
  getOrgAgent(id: string): OrgAgent | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_agents WHERE id = ?", id);
    return rows[0] ? rowTo<OrgAgent>(rows[0]) : null;
  }

  /**
   * Register or heartbeat an agent instance. First sighting inserts the row
   * (status REGISTERED, started_at set); later heartbeats refresh last_seen
   * and re-mark ACTIVE. Preserves the original started_at.
   */
  upsertOrgAgent(input: {
    id: string;
    roleId: string;
    kind?: string;
    model?: string;
    status?: string;
    host?: string;
    version?: string;
    capabilitiesJson?: string;
    autonomyJson?: string;
    source?: string;
  }): void {
    const now = new Date().toISOString();
    const existing = this.sql.all<Row>("SELECT id FROM org_agents WHERE id = ?", input.id);
    if (existing.length === 0) {
      this.insert("org_agents", {
        id: input.id,
        role_id: input.roleId,
        kind: input.kind ?? "cloud",
        model: input.model ?? "",
        status: input.status ?? "ACTIVE",
        host: input.host ?? null,
        version: input.version ?? null,
        last_seen: now,
        capabilities_json: input.capabilitiesJson ?? "[]",
        autonomy_json: input.autonomyJson ?? "{}",
        started_at: now,
        source: input.source ?? "runtime",
        created_at: now,
        updated_at: now,
      });
      return;
    }
    const sets = ["last_seen = ?", "updated_at = ?", "status = ?"];
    const params: SqlParam[] = [now, now, input.status ?? "ACTIVE"];
    if (input.host) { sets.push("host = ?"); params.push(input.host); }
    if (input.version) { sets.push("version = ?"); params.push(input.version); }
    if (input.model) { sets.push("model = ?"); params.push(input.model); }
    if (input.capabilitiesJson) { sets.push("capabilities_json = ?"); params.push(input.capabilitiesJson); }
    if (input.autonomyJson) { sets.push("autonomy_json = ?"); params.push(input.autonomyJson); }
    params.push(input.id);
    this.sql.run(`UPDATE org_agents SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  /** Agent instances not seen since the given ISO time (for the Doctor). */
  countStaleOrgAgents(staleBeforeIso: string): number {
    const rows = this.sql.all<Row>(
      "SELECT COUNT(*) AS c FROM org_agents WHERE last_seen IS NULL OR last_seen < ?",
      staleBeforeIso,
    );
    return Number(rows[0]?.c ?? 0);
  }

  // -- task contracts (AOrgI §18) -------------------------------------------
  /** Tasks that carry an explicit contract (acceptance criteria + verifier). */
  listTaskContracts(opts: { limit?: number } = {}): Task[] {
    let sql =
      "SELECT * FROM tasks WHERE acceptance_criteria IS NOT NULL OR verification_role_id IS NOT NULL ORDER BY updated_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; return this.sql.all<Row>(sql, opts.limit).map((r) => rowTo<Task>(r)); }
    return this.sql.all<Row>(sql).map((r) => rowTo<Task>(r));
  }
  getTaskContract(id: string): Task | null {
    const t = this.getTask(id);
    if (!t || (t.acceptance_criteria === undefined && t.verification_role_id === undefined)) return null;
    return t;
  }
  setTaskContract(
    id: string,
    patch: {
      acceptance_criteria?: string;
      verification_role_id?: string | null;
      autonomy_level?: string;
      deadline_at?: string | null;
      escalation_path?: string | null;
    },
  ): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;
    this.sql.run(
      `UPDATE tasks SET
         acceptance_criteria = COALESCE(?, acceptance_criteria),
         verification_role_id = COALESCE(?, verification_role_id),
         autonomy_level = COALESCE(?, autonomy_level),
         deadline_at = COALESCE(?, deadline_at),
         escalation_path = COALESCE(?, escalation_path),
         updated_at = ?
       WHERE id = ?`,
      patch.acceptance_criteria ?? null,
      patch.verification_role_id ?? null,
      patch.autonomy_level ?? null,
      patch.deadline_at ?? null,
      patch.escalation_path ?? null,
      new Date().toISOString(),
      id,
    );
    return this.getTask(id);
  }

  // -- AOrgI Phase 2: org memory / post-objective / trust / messages (v24) --

  // -- versioned organizational memory (AOrgI §14) ---------------------------
  /** ACTIVE entries by default; includeSuperseded adds the version history. */
  listOrgMemory(opts: { includeSuperseded?: boolean; limit?: number } = {}): OrgMemory[] {
    let sql = "SELECT * FROM org_memory";
    const params: SqlParam[] = [];
    if (!opts.includeSuperseded) { sql += " WHERE status = 'ACTIVE'"; }
    sql += " ORDER BY updated_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgMemory>(r));
  }
  getOrgMemory(id: string): OrgMemory | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_memory WHERE id = ?", id);
    return rows[0] ? rowTo<OrgMemory>(rows[0]) : null;
  }

  /**
   * Write a NEW organizational memory entry (version 1), optionally
   * superseding an existing ACTIVE entry (the old entry is marked
   * SUPERSEDED and linked via supersedes — history is never destroyed).
   */
  writeOrgMemory(input: { key: string; value: unknown; author?: string; taskId?: string; supersedes?: string }): OrgMemory {
    const now = new Date().toISOString();
    const id = newId("orgm");
    this.insert("org_memory", {
      id,
      key: input.key,
      value_json: JSON.stringify(input.value),
      version: 1,
      author: input.author ?? "executive",
      task_id: input.taskId ?? null,
      supersedes: input.supersedes ?? null,
      status: "ACTIVE",
      source: "system",
      created_at: now,
      updated_at: now,
    });
    if (input.supersedes) {
      this.sql.run(
        "UPDATE org_memory SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'",
        now, input.supersedes,
      );
    }
    return this.getOrgMemory(id)!;
  }

  /**
   * Update an organizational memory entry with optimistic concurrency (§14:
   * READ VERSION → MODIFY → WRITE WITH VERSION → CONFLICT). Never silently
   * overwrites a version the caller has not read.
   */
  updateOrgMemory(
    id: string,
    input: { value: unknown; expectedVersion: number; author?: string },
  ): { status: "updated" | "not_found" | "conflict"; record?: OrgMemory } {
    const existing = this.getOrgMemory(id);
    if (!existing) return { status: "not_found" };
    if (existing.version !== input.expectedVersion) {
      // §14: VERSION MISMATCH → ARBITRATE. The conflict is escalated to the
      // governance arbiter as a protocol message — it is never silent.
      this.sendOrgMessage({
        fromRole: input.author ?? "role_coa",
        toRole: "role_finance_governance",
        type: "ESCALATION",
        taskId: existing.task_id,
        payload: {
          memoryId: id,
          key: existing.key,
          expectedVersion: input.expectedVersion,
          currentVersion: existing.version,
        },
      });
      return { status: "conflict", record: existing };
    }
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE org_memory SET value_json = ?, version = ?, author = ?, updated_at = ? WHERE id = ? AND version = ?",
      JSON.stringify(input.value),
      existing.version + 1,
      input.author ?? existing.author ?? "executive",
      now,
      id,
      input.expectedVersion,
    );
    return { status: "updated", record: this.getOrgMemory(id) ?? undefined };
  }

  // -- PostObjectiveRecord (AOrgI §38) ---------------------------------------
  createPostObjectiveRecord(r: PostObjectiveRecord): void {
    this.insert("post_objective_records", r);
  }
  listPostObjectiveRecords(limit = 50): PostObjectiveRecord[] {
    return this.sql
      .all<Row>("SELECT * FROM post_objective_records ORDER BY created_at DESC LIMIT ?", limit)
      .map((row) => rowTo<PostObjectiveRecord>(row));
  }
  getPostObjectiveRecord(id: string): PostObjectiveRecord | null {
    const rows = this.sql.all<Row>("SELECT * FROM post_objective_records WHERE id = ?", id);
    return rows[0] ? rowTo<PostObjectiveRecord>(rows[0]) : null;
  }
  hasPostObjectiveRecord(objectiveId: string): boolean {
    const rows = this.sql.all<Row>("SELECT id FROM post_objective_records WHERE objective_id = ? LIMIT 1", objectiveId);
    return rows.length > 0;
  }

  // -- trust per agent × capability (AOrgI §21) ------------------------------
  /** Record one measured outcome (true/false) as trust evidence. */
  recordTrustEvidence(agentId: string, capability: string, ok: boolean): void {
    const now = new Date().toISOString();
    const rows = this.sql.all<Row>("SELECT * FROM org_trust WHERE agent_id = ? AND capability = ?", agentId, capability);
    if (rows.length === 0) {
      const initial = applyTrustEvidence(TRUST_INITIAL, now, ok ? 1 : 0, now);
      this.insert("org_trust", {
        id: newId("trust"),
        agent_id: agentId,
        capability,
        value: initial.value,
        evidence_count: 1,
        last_updated: now,
        source: "system",
        created_at: now,
        updated_at: now,
      });
      return;
    }
    const cur = rows[0]!;
    const next = applyTrustEvidence(Number(cur.value), String(cur.last_updated), ok ? 1 : 0, now);
    this.sql.run(
      "UPDATE org_trust SET value = ?, evidence_count = evidence_count + 1, last_updated = ?, updated_at = ? WHERE agent_id = ? AND capability = ?",
      next.value, now, now, agentId, capability,
    );
  }
  /** Stored value + effective (decayed) value, per agent × capability. */
  listOrgTrust(): Array<OrgTrust & { effective_value: number }> {
    const now = new Date().toISOString();
    return this.sql
      .all<Row>("SELECT * FROM org_trust ORDER BY agent_id ASC, capability ASC")
      .map((r) => ({ ...rowTo<OrgTrust>(r), effective_value: decayedTrust(Number(r.value), String(r.last_updated), now) }));
  }

  // -- inter-agent message protocol (AOrgI §16) -------------------------------
  /** Send a structured message; type is validated against the core set. */
  sendOrgMessage(input: {
    fromRole: string;
    toRole: string;
    type: OrgMessageType | string;
    taskId?: string;
    payload?: unknown;
  }): OrgMessage | { error: string } {
    const CORE_TYPES: string[] = ["STATUS", "REQUEST", "RESULT", "DEVIATION", "ESCALATION"];
    if (!CORE_TYPES.includes(input.type)) {
      return { error: `type must be one of ${CORE_TYPES.join(" | ")}` };
    }
    if (!input.fromRole.trim() || !input.toRole.trim()) {
      return { error: "from_role and to_role are required" };
    }
    const now = new Date().toISOString();
    const msg: OrgMessage = {
      id: newId("orgmsg"),
      from_role: input.fromRole,
      to_role: input.toRole,
      type: input.type,
      task_id: input.taskId ?? undefined,
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: now,
    };
    this.insert("org_messages", msg);
    return msg;
  }
  listOrgMessages(opts: { type?: string; limit?: number } = {}): OrgMessage[] {
    let sql = "SELECT * FROM org_messages";
    const params: SqlParam[] = [];
    if (opts.type) { sql += " WHERE type = ?"; params.push(opts.type); }
    sql += " ORDER BY created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgMessage>(r));
  }

  // -- AOrgI Phase 3: capability grants / plans / negotiations (v25) ---------

  // -- CapabilityGrants (§10, §12) -------------------------------------------
  listCapabilityGrants(opts: { roleId?: string } = {}): OrgCapabilityGrant[] {
    const sql = opts.roleId
      ? "SELECT * FROM org_capability_grants WHERE role_id = ? ORDER BY capability ASC"
      : "SELECT * FROM org_capability_grants ORDER BY role_id ASC, capability ASC";
    const params: SqlParam[] = opts.roleId ? [opts.roleId] : [];
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgCapabilityGrant>(r));
  }
  upsertCapabilityGrant(input: {
    id?: string;
    roleId: string;
    capability: string;
    allowedActions?: string[];
    autonomyLevel: string;
    requiresReview?: boolean;
    rateLimitPerHour?: number;
    dataScope?: string;
  }): OrgCapabilityGrant {
    if (!["L0", "L1", "L2", "L3"].includes(input.autonomyLevel)) {
      throw new Error(`autonomy_level must be L0-L3, got '${input.autonomyLevel}'`);
    }
    const existing = input.id
      ? this.sql.all<Row>("SELECT * FROM org_capability_grants WHERE id = ?", input.id)
      : this.sql.all<Row>("SELECT * FROM org_capability_grants WHERE role_id = ? AND capability = ?", input.roleId, input.capability);
    const now = new Date().toISOString();
    if (existing.length > 0) {
      const id = String(existing[0]!.id);
      this.sql.run(
        `UPDATE org_capability_grants SET
           allowed_actions_json = COALESCE(?, allowed_actions_json),
           autonomy_level = COALESCE(?, autonomy_level),
           requires_review = COALESCE(?, requires_review),
           rate_limit_per_hour = COALESCE(?, rate_limit_per_hour),
           data_scope = COALESCE(?, data_scope),
           updated_at = ?
         WHERE id = ?`,
        input.allowedActions ? JSON.stringify(input.allowedActions) : null,
        input.autonomyLevel,
        input.requiresReview === undefined ? null : input.requiresReview ? 1 : 0,
        input.rateLimitPerHour ?? null,
        input.dataScope ?? null,
        now,
        id,
      );
      return this.sql.all<Row>("SELECT * FROM org_capability_grants WHERE id = ?", id).map((r) => rowTo<OrgCapabilityGrant>(r))[0]!;
    }
    const grant: OrgCapabilityGrant = {
      id: input.id ?? newId("grant"),
      role_id: input.roleId,
      capability: input.capability,
      allowed_actions_json: JSON.stringify(input.allowedActions ?? ["*"]),
      autonomy_level: input.autonomyLevel,
      requires_review: input.requiresReview ? 1 : 0,
      rate_limit_per_hour: input.rateLimitPerHour ?? undefined,
      data_scope: input.dataScope ?? "",
      source: "founder",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_capability_grants", grant);
    return grant;
  }

  /** Roles with NO grant rows at all (not even a wildcard) — fail-closed gap. */
  listRolesWithoutCapabilityGrants(): string[] {
    const rows = this.sql.all<Row>(
      `SELECT r.id FROM org_roles r
        WHERE r.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM org_capability_grants g WHERE g.role_id = r.id)`,
    );
    return rows.map((r) => String(r.id));
  }

  /** The capability decision for a registered agent instance (§10 chain). */
  capabilityVerdictForAgent(agentId: string, capability: string, action: string): CapabilityDecision | { verdict: "DENY"; grantId: null; reason: string; agentId: string } {
    const agent = this.getOrgAgent(agentId);
    if (!agent) return { verdict: "DENY", grantId: null, reason: `Unknown agent instance '${agentId}'.`, agentId };
    const grants = this.listCapabilityGrants({ roleId: agent.role_id });
    return capabilityVerdictForRole(grants, capability, action);
  }

  // -- hierarchical plans (§19) ----------------------------------------------
  createOrgPlan(input: { objectiveId?: string; title: string; ownerRole: string }): OrgPlan {
    const now = new Date().toISOString();
    const plan: OrgPlan = {
      id: newId("plan"),
      objective_id: input.objectiveId ?? undefined,
      title: input.title,
      version: 1,
      owner_role: input.ownerRole,
      status: "DRAFT",
      source: "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_plans", plan);
    return plan;
  }
  getOrgPlan(id: string): OrgPlan | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_plans WHERE id = ?", id);
    return rows[0] ? rowTo<OrgPlan>(rows[0]) : null;
  }
  listOrgPlans(limit = 50): OrgPlan[] {
    return this.sql.all<Row>("SELECT * FROM org_plans ORDER BY updated_at DESC LIMIT ?", limit).map((r) => rowTo<OrgPlan>(r));
  }

  /** Bump a plan's version; every change records a PlanDeviationEvent (§19). */
  reviseOrgPlan(id: string, patch: { title?: string; ownerRole?: string; status?: string; description?: string }): OrgPlan | null {
    const plan = this.getOrgPlan(id);
    if (!plan) return null;
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE org_plans SET title = COALESCE(?, title), owner_role = COALESCE(?, owner_role), status = COALESCE(?, status), version = version + 1, updated_at = ? WHERE id = ?",
      patch.title ?? null,
      patch.ownerRole ?? null,
      patch.status ?? null,
      now,
      id,
    );
    this.insert("org_plan_deviations", {
      id: newId("pdev"),
      plan_id: id,
      kind: "revision",
      description: patch.description ?? `Plan v${plan.version} → v${plan.version + 1}: ${Object.keys(patch).join(", ")}`,
      resolution: null,
      status: "OPEN",
      source: "system",
      created_at: now,
      updated_at: now,
    });
    return this.getOrgPlan(id);
  }

  addOrgPlanStep(planId: string, input: { title: string; ownerRole: string; dependencies?: string[]; seq?: number }): OrgPlanStep | null {
    const plan = this.getOrgPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const seq = input.seq ?? this.sql.all<Row>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM org_plan_steps WHERE plan_id = ?", planId)[0]!.n as number;
    const step: OrgPlanStep = {
      id: newId("pstep"),
      plan_id: planId,
      seq: Number(seq),
      title: input.title,
      owner_role: input.ownerRole,
      dependencies_json: JSON.stringify(input.dependencies ?? []),
      status: "PENDING",
      started_at: undefined,
      completed_at: undefined,
      source: "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_plan_steps", step);
    return step;
  }
  listOrgPlanSteps(planId: string): OrgPlanStep[] {
    return this.sql.all<Row>("SELECT * FROM org_plan_steps WHERE plan_id = ? ORDER BY seq ASC", planId).map((r) => rowTo<OrgPlanStep>(r));
  }

  /** Status transition; a BLOCKED step records a deviation event automatically. */
  updateOrgPlanStepStatus(stepId: string, status: string): OrgPlanStep | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_plan_steps WHERE id = ?", stepId);
    if (rows.length === 0) return null;
    const step = rowTo<OrgPlanStep>(rows[0]);
    const now = new Date().toISOString();
    this.sql.run(
      `UPDATE org_plan_steps SET status = ?,
         started_at = CASE WHEN ? = 'IN_PROGRESS' THEN COALESCE(started_at, ?) ELSE started_at END,
         completed_at = CASE WHEN ? = 'DONE' THEN ? ELSE completed_at END,
         updated_at = ? WHERE id = ?`,
      status, status, now, status, now, now, stepId,
    );
    if (status === "BLOCKED") {
      this.insert("org_plan_deviations", {
        id: newId("pdev"),
        plan_id: step.plan_id,
        kind: "blocker",
        description: `Step '${step.title}' (${stepId}) is BLOCKED.`,
        resolution: null,
        status: "OPEN",
        source: "system",
        created_at: now,
        updated_at: now,
      });
    }
    return this.sql.all<Row>("SELECT * FROM org_plan_steps WHERE id = ?", stepId).map((r) => rowTo<OrgPlanStep>(r))[0]!;
  }

  linkTaskToPlanStep(taskId: string, planId: string, stepId: string): Task | null {
    const task = this.getTask(taskId);
    const plan = this.getOrgPlan(planId);
    if (!task || !plan) return null;
    const stepRows = this.sql.all<Row>("SELECT id FROM org_plan_steps WHERE id = ? AND plan_id = ?", stepId, planId);
    if (stepRows.length === 0) return null;
    this.sql.run("UPDATE tasks SET plan_id = ?, plan_step_id = ?, updated_at = ? WHERE id = ?", planId, stepId, new Date().toISOString(), taskId);
    return this.getTask(taskId);
  }
  listOrgPlanDeviations(planId?: string, limit = 50): OrgPlanDeviation[] {
    const sql = planId
      ? "SELECT * FROM org_plan_deviations WHERE plan_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM org_plan_deviations ORDER BY created_at DESC LIMIT ?";
    const params: SqlParam[] = planId ? [planId, limit] : [limit];
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgPlanDeviation>(r));
  }

  // -- negotiation + arbitration (§22, §23) ------------------------------------
  createOrgNegotiation(input: { topic: string; taskId?: string; maxRounds?: number; arbiterRole?: string }): OrgNegotiation {
    const now = new Date().toISOString();
    const n: OrgNegotiation = {
      id: newId("neg"),
      topic: input.topic,
      task_id: input.taskId ?? undefined,
      status: "OPEN",
      round: 0,
      max_rounds: input.maxRounds ?? 3,
      arbiter_role: input.arbiterRole ?? undefined,
      verdict: undefined,
      source: "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_negotiations", n);
    return n;
  }
  getOrgNegotiation(id: string): OrgNegotiation | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_negotiations WHERE id = ?", id);
    return rows[0] ? rowTo<OrgNegotiation>(rows[0]) : null;
  }
  listOrgNegotiations(limit = 50): OrgNegotiation[] {
    return this.sql.all<Row>("SELECT * FROM org_negotiations ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<OrgNegotiation>(r));
  }
  listNegotiationRounds(negotiationId: string): OrgNegotiationRound[] {
    return this.sql
      .all<Row>("SELECT * FROM org_negotiation_rounds WHERE negotiation_id = ? ORDER BY round ASC, created_at ASC", negotiationId)
      .map((r) => rowTo<OrgNegotiationRound>(r));
  }

  /** Record one round; hard cap enforced — reaching it forces ARBITRATION. */
  addNegotiationRound(negotiationId: string, input: { kind: string; role: string; content: string }): { ok: true; negotiation: OrgNegotiation; round: OrgNegotiationRound } | { ok: false; error: string } {
    const n = this.getOrgNegotiation(negotiationId);
    if (!n) return { ok: false, error: "Negotiation not found" };
    if (n.status !== "OPEN") return { ok: false, error: `Negotiation is ${n.status} — no further rounds.` };
    const phase = negotiationPhase(n.round, n.max_rounds);
    if (!allowedRoundKinds(phase).includes(input.kind)) {
      return { ok: false, error: `Phase ${phase} accepts rounds of kind ${allowedRoundKinds(phase).join(" | ")} — got '${input.kind}'.` };
    }
    const now = new Date().toISOString();
    const round = n.round + 1;
    const rec: OrgNegotiationRound = {
      id: newId("negrd"),
      negotiation_id: negotiationId,
      round,
      kind: input.kind,
      role: input.role,
      content: input.content,
      created_at: now,
    };
    this.insert("org_negotiation_rounds", rec);
    const newStatus = round >= n.max_rounds ? "ARBITRATED" : "OPEN";
    this.sql.run("UPDATE org_negotiations SET round = ?, status = ?, updated_at = ? WHERE id = ?", round, newStatus, now, negotiationId);
    return { ok: true, negotiation: this.getOrgNegotiation(negotiationId)!, round: rec };
  }

  /** The arbiter resolves the negotiation — recorded, never silent. */
  arbitrateNegotiation(id: string, verdict: string, byRole: string): OrgNegotiation | null {
    const n = this.getOrgNegotiation(id);
    if (!n || n.status === "RESOLVED") return null;
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE org_negotiations SET status = 'RESOLVED', verdict = ?, arbiter_role = COALESCE(?, arbiter_role), updated_at = ? WHERE id = ?",
      verdict, byRole, now, id,
    );
    // §13: the arbiter's decision is a consequential one — record a reasoning
    // trace with the actual evidence (the recorded rounds), never chain-of-thought.
    const rounds = this.listNegotiationRounds(id).map((r) => ({ round: r.round, kind: r.kind, role: r.role, content: r.content }));
    this.createReasoningTrace({
      agentId: byRole || n.arbiter_role || "role_coa",
      taskId: n.task_id,
      mode: "arbitration",
      evidence: rounds,
      hypothesis: `Negotiation '${n.topic}' exhausted ${n.max_rounds} rounds.`,
      confidence: null,
      finalAction: verdict,
      visibility: "internal",
    });
    return this.getOrgNegotiation(id);
  }

  listOrgArbiters(): OrgArbiter[] {
    return this.sql.all<Row>("SELECT * FROM org_arbiters ORDER BY disagreement_class ASC").map((r) => rowTo<OrgArbiter>(r));
  }
  getOrgArbiter(disagreementClass: string): OrgArbiter | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_arbiters WHERE disagreement_class = ?", disagreementClass);
    return rows[0] ? rowTo<OrgArbiter>(rows[0]) : null;
  }

  // -- reasoning traces (AOrgI §13) -------------------------------------------
  createReasoningTrace(input: {
    agentId: string;
    taskId?: string;
    mode?: string;
    evidence?: unknown;
    hypothesis?: string;
    confidence?: number | null;
    finalAction?: string;
    visibility?: "internal" | "reviewer" | "public";
  }): ReasoningTrace {
    const now = new Date().toISOString();
    const trace: ReasoningTrace = {
      id: newId("rt"),
      agent_id: input.agentId,
      task_id: input.taskId ?? undefined,
      mode: input.mode ?? "decision",
      evidence_json: JSON.stringify(input.evidence ?? []),
      hypothesis: input.hypothesis ?? "",
      confidence: input.confidence ?? undefined,
      final_action: input.finalAction ?? "",
      trace_visibility: input.visibility ?? "internal",
      source: "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("reasoning_traces", trace);
    return trace;
  }
  listReasoningTraces(opts: { agentId?: string; taskId?: string; limit?: number } = {}): ReasoningTrace[] {
    let sql = "SELECT * FROM reasoning_traces WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.agentId) { sql += " AND agent_id = ?"; params.push(opts.agentId); }
    if (opts.taskId) { sql += " AND task_id = ?"; params.push(opts.taskId); }
    sql += " ORDER BY created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<ReasoningTrace>(r));
  }

  // -- AOrgI Phase 4: analyst reports + chaos tests (v27) ---------------------
  createAnalystReport(input: {
    generatedAt: string;
    trigger: string;
    metrics: unknown;
    observations: unknown[];
    recommendations: unknown[];
  }): OrgAnalystReport {
    const now = new Date().toISOString();
    const report: OrgAnalystReport = {
      id: newId("oar"),
      generated_at: input.generatedAt,
      trigger: input.trigger,
      metrics_json: JSON.stringify(input.metrics),
      observations_json: JSON.stringify(input.observations),
      recommendations_json: JSON.stringify(input.recommendations),
      source: "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_analyst_reports", report);
    return report;
  }
  listAnalystReports(limit = 20): OrgAnalystReport[] {
    return this.sql.all<Row>("SELECT * FROM org_analyst_reports ORDER BY generated_at DESC LIMIT ?", limit).map((r) => rowTo<OrgAnalystReport>(r));
  }
  latestAnalystReport(): OrgAnalystReport | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_analyst_reports ORDER BY generated_at DESC LIMIT 1");
    return rows[0] ? rowTo<OrgAnalystReport>(rows[0]) : null;
  }

  createChaosTest(input: { kind: string; target: string; source?: string }): OrgChaosTest {
    const now = new Date().toISOString();
    const t: OrgChaosTest = {
      id: newId("chaos"),
      kind: input.kind,
      target: input.target,
      status: "RUNNING",
      result_json: "{}",
      started_at: now,
      finished_at: undefined,
      source: input.source ?? "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_chaos_tests", t);
    return t;
  }
  finishChaosTest(id: string, status: "PASSED" | "FAILED" | "REFUSED", result: unknown): void {
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE org_chaos_tests SET status = ?, result_json = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      status, JSON.stringify(result), now, now, id,
    );
  }
  listChaosTests(limit = 50): OrgChaosTest[] {
    return this.sql.all<Row>("SELECT * FROM org_chaos_tests ORDER BY started_at DESC LIMIT ?", limit).map((r) => rowTo<OrgChaosTest>(r));
  }

  /** Chaos primitives (guarded at the module level — never called raw). */
  setOrgAgentLastSeen(id: string, iso: string): void {
    this.sql.run("UPDATE org_agents SET last_seen = ?, updated_at = ? WHERE id = ?", iso, new Date().toISOString(), id);
  }
  deleteOrgAgent(id: string): void {
    this.sql.run("DELETE FROM org_agents WHERE id = ?", id);
  }
  deleteCapabilityGrant(id: string): void {
    this.sql.run("DELETE FROM org_capability_grants WHERE id = ?", id);
  }

  // -- AOrgI Phase 1–4 round-2 fixes: incidents (v28) --------------------------
  createOrgIncident(input: {
    title: string;
    severity?: string;
    description?: string;
    source?: string;
  }): OrgIncident {
    const now = new Date().toISOString();
    const incident: OrgIncident = {
      id: newId("inc"),
      title: input.title,
      severity: input.severity ?? "MEDIUM",
      status: "OPEN",
      description: input.description ?? "",
      resolution: undefined,
      detected_at: now,
      contained_at: undefined,
      resolved_at: undefined,
      source: input.source ?? "system",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_incidents", incident);
    return incident;
  }
  listOrgIncidents(opts: { status?: string; limit?: number } = {}): OrgIncident[] {
    let sql = "SELECT * FROM org_incidents";
    const params: SqlParam[] = [];
    if (opts.status) { sql += " WHERE status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgIncident>(r));
  }
  getOrgIncident(id: string): OrgIncident | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_incidents WHERE id = ?", id);
    return rows[0] ? rowTo<OrgIncident>(rows[0]) : null;
  }

  /** Status transition — timestamps track the response loop (§31). */
  updateOrgIncidentStatus(id: string, status: "OPEN" | "CONTAINED" | "RESOLVED", resolution?: string): OrgIncident | null {
    const existing = this.getOrgIncident(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.sql.run(
      `UPDATE org_incidents SET status = ?,
         contained_at = CASE WHEN ? = 'CONTAINED' THEN COALESCE(contained_at, ?) ELSE contained_at END,
         resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_at END,
         resolution = COALESCE(?, resolution),
         updated_at = ? WHERE id = ?`,
      status, status, now, status, now, resolution ?? null, now, id,
    );
    return this.getOrgIncident(id);
  }

  /** The explicit DefinitionOfDone (§30), from versioned org memory. */
  getDefinitionOfDone(): { id: string; value: Record<string, unknown>; version: number } | null {
    const entry = this.listOrgMemory({ limit: 500 }).find((m) => m.key === "definition_of_done" && m.status === "ACTIVE");
    if (!entry) return null;
    try {
      return { id: entry.id, value: JSON.parse(entry.value_json) as Record<string, unknown>, version: entry.version };
    } catch {
      return null;
    }
  }

  // -- AOrgI Phase 5: topology proposals (v29) ---------------------------------
  createTopologyProposal(input: {
    kind: string;
    roleId?: string;
    rationale: string;
    evidence?: unknown;
    source?: string;
  }): OrgTopologyProposal {
    const now = new Date().toISOString();
    const p: OrgTopologyProposal = {
      id: newId("topo"),
      kind: input.kind,
      role_id: input.roleId ?? undefined,
      rationale: input.rationale,
      evidence_json: JSON.stringify(input.evidence ?? []),
      status: "PROPOSED",
      decided_by: undefined,
      decided_at: undefined,
      source: input.source ?? "analyst",
      created_at: now,
      updated_at: now,
    };
    this.insert("org_topology_proposals", p);
    return p;
  }
  listTopologyProposals(opts: { status?: string; limit?: number } = {}): OrgTopologyProposal[] {
    let sql = "SELECT * FROM org_topology_proposals";
    const params: SqlParam[] = [];
    if (opts.status) { sql += " WHERE status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<OrgTopologyProposal>(r));
  }
  getTopologyProposal(id: string): OrgTopologyProposal | null {
    const rows = this.sql.all<Row>("SELECT * FROM org_topology_proposals WHERE id = ?", id);
    return rows[0] ? rowTo<OrgTopologyProposal>(rows[0]) : null;
  }
  updateTopologyProposal(id: string, patch: { status: string; decidedBy?: string }): OrgTopologyProposal | null {
    const existing = this.getTopologyProposal(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE org_topology_proposals SET status = ?, decided_by = COALESCE(?, decided_by), decided_at = ?, updated_at = ? WHERE id = ?",
      patch.status, patch.decidedBy ?? null, now, now, id,
    );
    return this.getTopologyProposal(id);
  }

  // -- perceptual intelligence (migration v22, specs/zarlino-artificial-organization.md)
  // -- evaluators (the human sensor network; NOT employees — spec §4-5) -----
  createPerceptualEvaluator(e: PerceptualEvaluator): void {
    this.insert("perceptual_evaluators", e);
  }
  listPerceptualEvaluators(opts: { actorType?: string; availability?: string; limit?: number } = {}): PerceptualEvaluator[] {
    let sql = "SELECT * FROM perceptual_evaluators WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.actorType) { sql += " AND actor_type = ?"; params.push(opts.actorType); }
    if (opts.availability) { sql += " AND availability = ?"; params.push(opts.availability); }
    sql += " ORDER BY reliability_score DESC, created_at ASC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<PerceptualEvaluator>(r));
  }
  getPerceptualEvaluator(id: string): PerceptualEvaluator | null {
    const rows = this.sql.all<Row>("SELECT * FROM perceptual_evaluators WHERE id = ?", id);
    return rows[0] ? rowTo<PerceptualEvaluator>(rows[0]) : null;
  }
  updatePerceptualEvaluator(id: string, patch: Partial<PerceptualEvaluator>): PerceptualEvaluator | null {
    const existing = this.getPerceptualEvaluator(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
    this.update("perceptual_evaluators", id, next);
    return this.getPerceptualEvaluator(id);
  }
  deletePerceptualEvaluator(id: string): boolean {
    if (!this.getPerceptualEvaluator(id)) return false;
    this.sql.run("DELETE FROM perceptual_evaluators WHERE id = ?", id);
    return true;
  }

  // -- test registry (spec §6) ---------------------------------------------
  createPerceptualTest(t: PerceptualTest): void {
    this.insert("perceptual_tests", t);
  }
  listPerceptualTests(opts: { productId?: string; status?: string; tier?: string; limit?: number } = {}): PerceptualTest[] {
    let sql = "SELECT * FROM perceptual_tests WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.productId) { sql += " AND product_id = ?"; params.push(opts.productId); }
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.tier) { sql += " AND tier = ?"; params.push(opts.tier); }
    sql += " ORDER BY created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<PerceptualTest>(r));
  }
  getPerceptualTest(id: string): PerceptualTest | null {
    const rows = this.sql.all<Row>("SELECT * FROM perceptual_tests WHERE id = ?", id);
    return rows[0] ? rowTo<PerceptualTest>(rows[0]) : null;
  }
  updatePerceptualTest(id: string, patch: Partial<PerceptualTest>): PerceptualTest | null {
    const existing = this.getPerceptualTest(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
    this.update("perceptual_tests", id, next);
    return this.getPerceptualTest(id);
  }

  // -- results: APPEND-ONLY (spec §9 — engineering must not edit human evidence)
  createPerceptualResult(r: PerceptualResult): void {
    this.insert("perceptual_results", r);
  }
  listPerceptualResults(opts: { testId?: string; evaluatorId?: string; limit?: number } = {}): PerceptualResult[] {
    let sql = "SELECT * FROM perceptual_results WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.testId) { sql += " AND test_id = ?"; params.push(opts.testId); }
    if (opts.evaluatorId) { sql += " AND evaluator_id = ?"; params.push(opts.evaluatorId); }
    sql += " ORDER BY created_at ASC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<PerceptualResult>(r));
  }
  countAcceptedPerceptualResults(testId: string): number {
    const rows = this.sql.all<Row>(
      "SELECT COUNT(*) AS c FROM perceptual_results WHERE test_id = ? AND status = 'accepted'",
      testId,
    );
    return Number(rows[0]?.c ?? 0);
  }

  // -- perceptual knowledge (organizational memory — spec §27-29) ----------
  createPerceptualKnowledge(k: PerceptualKnowledge): void {
    this.insert("perceptual_knowledge", k);
  }
  listPerceptualKnowledge(opts: { productCategory?: string; evidenceTier?: string; limit?: number } = {}): PerceptualKnowledge[] {
    let sql = "SELECT * FROM perceptual_knowledge WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.productCategory) { sql += " AND product_category = ?"; params.push(opts.productCategory); }
    if (opts.evidenceTier) { sql += " AND evidence_tier = ?"; params.push(opts.evidenceTier); }
    sql += " ORDER BY confidence DESC, created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<PerceptualKnowledge>(r));
  }
  getPerceptualKnowledge(id: string): PerceptualKnowledge | null {
    const rows = this.sql.all<Row>("SELECT * FROM perceptual_knowledge WHERE id = ?", id);
    return rows[0] ? rowTo<PerceptualKnowledge>(rows[0]) : null;
  }
  deletePerceptualKnowledge(id: string): boolean {
    if (!this.getPerceptualKnowledge(id)) return false;
    this.sql.run("DELETE FROM perceptual_knowledge WHERE id = ?", id);
    return true;
  }

  // -- product validation gate (spec §14) -----------------------------------
  listProductValidations(): ProductValidation[] {
    return this.sql.all<Row>("SELECT * FROM product_validations ORDER BY updated_at DESC").map((r) => rowTo<ProductValidation>(r));
  }
  getProductValidation(productId: string): ProductValidation | null {
    const rows = this.sql.all<Row>("SELECT * FROM product_validations WHERE product_id = ?", productId);
    return rows[0] ? rowTo<ProductValidation>(rows[0]) : null;
  }
  upsertProductValidation(v: ProductValidation): void {
    const rows = this.sql.all<Row>("SELECT product_id FROM product_validations WHERE product_id = ?", v.product_id);
    if (rows.length > 0) this.update("product_validations", v.product_id, v);
    else this.insert("product_validations", v);
  }

  // -- failure taxonomy (spec §39) ------------------------------------------
  createFailureAnalysis(f: FailureAnalysis): void {
    this.insert("failure_analyses", f);
  }
  listFailureAnalyses(opts: { productId?: string; failureClass?: string; limit?: number } = {}): FailureAnalysis[] {
    let sql = "SELECT * FROM failure_analyses WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts.productId) { sql += " AND product_id = ?"; params.push(opts.productId); }
    if (opts.failureClass) { sql += " AND failure_class = ?"; params.push(opts.failureClass); }
    sql += " ORDER BY created_at DESC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<FailureAnalysis>(r));
  }
  getFailureAnalysis(id: string): FailureAnalysis | null {
    const rows = this.sql.all<Row>("SELECT * FROM failure_analyses WHERE id = ?", id);
    return rows[0] ? rowTo<FailureAnalysis>(rows[0]) : null;
  }

  // -- risks --------------------------------------------------------------
  insertRisk(r: Risk): void {
    this.insert("risks", r);
  }
  listRisks(opts?: { status?: string; level?: string }): Risk[] {
    let sql = "SELECT * FROM risks WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts?.level) { sql += " AND level = ?"; params.push(opts.level); }
    sql += " ORDER BY CASE level WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at DESC";
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<Risk>(r));
  }
  openRisks(): Risk[] {
    return this.listRisks({ status: "OPEN" });
  }

  // -- metrics ------------------------------------------------------------
  insertMetric(m: Metric): void {
    this.insert("metrics", m);
  }
  listMetrics(limit = 50): Metric[] {
    return this.sql.all<Row>("SELECT * FROM metrics ORDER BY recorded_at DESC LIMIT ?", limit).map((r) => rowTo<Metric>(r));
  }
  /** Latest recorded metric with the given name (e.g. downloads, licensed). */
  latestMetricByName(name: string): Metric | null {
    const rows = this.sql.all<Row>("SELECT * FROM metrics WHERE name = ? ORDER BY recorded_at DESC LIMIT 1", name);
    return rows.length ? rowTo<Metric>(rows[0]) : null;
  }
  /** Insert a metric, or update in place if the id already exists. */
  upsertMetric(m: Metric): void {
    const rows = this.sql.all<Row>("SELECT id FROM metrics WHERE id = ?", m.id);
    if (rows.length > 0) this.update("metrics", m.id, m as unknown as Row);
    else this.insert("metrics", m);
  }

  // -- financial snapshots ------------------------------------------------
  insertSnapshot(s: FinancialSnapshot): void {
    this.insert("financial_snapshots", s);
  }
  latestSnapshot(): FinancialSnapshot | null {
    const rows = this.sql.all<Row>("SELECT * FROM financial_snapshots ORDER BY period DESC LIMIT 1");
    return rows.length ? rowTo<FinancialSnapshot>(rows[0]) : null;
  }
  listSnapshots(limit = 12): FinancialSnapshot[] {
    return this.sql.all<Row>("SELECT * FROM financial_snapshots ORDER BY period DESC LIMIT ?", limit).map((r) => rowTo<FinancialSnapshot>(r));
  }

  // -- products -----------------------------------------------------------
  insertProduct(p: Product): void {
    this.insert("products", p);
  }
  listProducts(): Product[] {
    return this.sql.all<Row>("SELECT * FROM products ORDER BY priority ASC, created_at ASC").map((r) => rowTo<Product>(r));
  }
  getProduct(id: string): Product | null {
    const rows = this.sql.all<Row>("SELECT * FROM products WHERE id = ?", id);
    return rows.length ? rowTo<Product>(rows[0]) : null;
  }
  updateProduct(id: string, patch: Partial<Product>): void {
    this.update("products", id, patch as Row);
  }
  insertProductStatus(ps: ProductStatusRecord): void {
    this.insert("product_status", ps);
  }
  listProductStatus(productId: string): ProductStatusRecord[] {
    return this.sql.all<Row>("SELECT * FROM product_status WHERE product_id = ? ORDER BY recorded_at DESC", productId).map((r) => rowTo<ProductStatusRecord>(r));
  }

  /**
   * Ship a plugin: mark the product SHIPPED (with optional version), record a
   * product_status history row, and set its Gate 10 to SHIPPED. This is the
   * "Ship" action — the single source of truth that a plugin is released.
   */
  shipProduct(pluginId: string, opts: { version?: string; note?: string }): void {
    const now = new Date().toISOString();
    this.updateProduct(pluginId, {
      status: "SHIPPED",
      ...(opts.version ? { version: opts.version } : {}),
    });
    const product = this.getProduct(pluginId);
    this.insertProductStatus({
      id: newId("ps"),
      created_at: now,
      source: "founder",
      product_id: pluginId,
      status: "SHIPPED",
      gate: "Gate 10",
      note: opts.note ?? `Shipped${opts.version ? ` v${opts.version}` : ""} (${product?.name ?? pluginId})`,
      recorded_at: now,
    });
    // pipeline_gates uses the product NAME as plugin_id (e.g. "ZScorch"),
    // not the product id ("prod_zscorch").
    this.sql.run(
      "UPDATE pipeline_gates SET status = 'SHIPPED', note = ?, updated_at = ? WHERE plugin_id = ? AND gate_number = 10",
      opts.note ?? `Shipped${opts.version ? ` v${opts.version}` : ""}`, now, product?.name ?? pluginId,
    );
  }

  // -- engineering issues -------------------------------------------------
  insertEngineeringIssue(e: EngineeringIssue): void {
    this.insert("engineering_issues", e);
  }
  listEngineeringIssues(opts?: { status?: string }): EngineeringIssue[] {
    const rows = opts?.status
      ? this.sql.all<Row>("SELECT * FROM engineering_issues WHERE status = ? ORDER BY created_at DESC", opts.status)
      : this.sql.all<Row>("SELECT * FROM engineering_issues ORDER BY created_at DESC");
    return rows.map((r) => rowTo<EngineeringIssue>(r));
  }

  // -- marketing ----------------------------------------------------------
  insertCampaign(c: MarketingCampaign): void {
    this.insert("marketing_campaigns", c);
  }
  listCampaigns(): MarketingCampaign[] {
    return this.sql.all<Row>("SELECT * FROM marketing_campaigns ORDER BY created_at DESC").map((r) => rowTo<MarketingCampaign>(r));
  }

  // -- persons ------------------------------------------------------------
  insertPerson(p: Person): void {
    this.insert("persons", p);
  }
  listPersons(): Person[] {
    return this.sql.all<Row>("SELECT * FROM persons ORDER BY created_at ASC").map((r) => rowTo<Person>(r));
  }

  // -- memory -------------------------------------------------------------
  insertMemory(m: Memory): void {
    this.insert("memories", m);
  }
  listMemories(opts?: { layer?: string; status?: string }): Memory[] {
    let sql = "SELECT * FROM memories WHERE 1=1";
    const params: SqlParam[] = [];
    if (opts?.layer) { sql += " AND layer = ?"; params.push(opts.layer); }
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC";
    return this.sql.all<Row>(sql, ...params).map((r) => rowTo<Memory>(r));
  }
  getMemory(id: string): Memory | null {
    const rows = this.sql.all<Row>("SELECT * FROM memories WHERE id = ?", id);
    return rows.length ? rowTo<Memory>(rows[0]) : null;
  }
  updateMemory(id: string, patch: Partial<Memory>): void {
    this.update("memories", id, patch as Row);
  }
  /** Semantic + recency + importance retrieval (spec §27). */
  retrieveMemories(query: string, opts: { limit?: number; layers?: Memory["layer"][] } = {}): Memory[] {
    const memories = this.listMemories({ status: "ACTIVE" });
    return retrieve(memories, { query, limit: opts.limit ?? 8, layers: opts.layers });
  }
  scoreMemories(query: string): Array<{ memory: Memory; score: number }> {
    return this.listMemories({ status: "ACTIVE" }).map((m) => ({ memory: m, score: scoreMemory(m, query) })).sort((a, b) => b.score - a.score);
  }

  // -- doctrine -----------------------------------------------------------
  insertDoctrineRule(r: DoctrineRule): void {
    // Do not duplicate an ACTIVE rule with the same code.
    const existing = this.sql.all<Row>("SELECT id FROM doctrine_rules WHERE code = ? AND status = 'ACTIVE'", r.code);
    if (r.status === "ACTIVE" && existing.length > 0) return;
    this.insert("doctrine_rules", r);
  }
  listDoctrine(opts?: { status?: string }): DoctrineRule[] {
    const rows = opts?.status
      ? this.sql.all<Row>("SELECT * FROM doctrine_rules WHERE status = ? ORDER BY code ASC", opts.status)
      : this.sql.all<Row>("SELECT * FROM doctrine_rules ORDER BY code ASC");
    return rows.map((r) => rowTo<DoctrineRule>(r));
  }
  listActiveDoctrine(): DoctrineRule[] {
    return this.listDoctrine({ status: "ACTIVE" });
  }
  listDoctrineByCode(code: string): DoctrineRule[] {
    return this.sql.all<Row>("SELECT * FROM doctrine_rules WHERE code = ? ORDER BY version ASC", code).map((r) => rowTo<DoctrineRule>(r));
  }
  updateDoctrineRule(id: string, patch: Partial<DoctrineRule>): void {
    this.update("doctrine_rules", id, patch as Row);
  }

  // -- policies -----------------------------------------------------------
  insertPolicy(p: Policy): void {
    this.insert("policies", p);
  }
  listPolicies(): Policy[] {
    return this.sql.all<Row>("SELECT * FROM policies ORDER BY code ASC").map((r) => rowTo<Policy>(r));
  }

  // -- audit --------------------------------------------------------------
  insertAudit(e: AuditEvent): void {
    this.insert("audit_events", e);
  }
  listAudit(limit = 100): AuditEvent[] {
    return this.sql.all<Row>("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<AuditEvent>(r));
  }
  auditForEntity(entityType: string, entityId: string, limit = 20): AuditEvent[] {
    return this.sql.all<Row>("SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?", entityType, entityId, limit).map((r) => rowTo<AuditEvent>(r));
  }

  // -- chat ---------------------------------------------------------------
  insertChatMessage(m: ChatMessage): void {
    this.insert("chat_messages", m);
  }
  listChatMessages(sessionId: string, limit = 200): ChatMessage[] {
    return this.sql.all<Row>("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?", sessionId, limit).map((r) => rowTo<ChatMessage>(r));
  }

  /** Recent chat sessions (history), most recent first. */
  listChatSessions(limit = 20): Array<{ session_id: string; message_count: number; last_at: string; last_message: string }> {
    return this.sql
      .all<Row>(
        `SELECT session_id, COUNT(*) AS message_count, MAX(created_at) AS last_at,
           (SELECT content FROM chat_messages AS inner_m
             WHERE inner_m.session_id = outer_m.session_id
             ORDER BY inner_m.created_at DESC LIMIT 1) AS last_message
         FROM chat_messages AS outer_m
         GROUP BY session_id ORDER BY last_at DESC LIMIT ?`,
        limit,
      )
      .map((r) => ({
        session_id: String(r.session_id),
        message_count: Number(r.message_count),
        last_at: String(r.last_at),
        last_message: String(r.last_message ?? ""),
      }));
  }

  clearChat(sessionId: string): void {
    this.sql.run("DELETE FROM chat_messages WHERE session_id = ?", sessionId);
  }

  // -- chat streams (migration v6 — buffered SSE deltas) ------------------
  openChatStream(id: string, sessionId: string, createdAt: string): void {
    this.sql.run(
      "INSERT INTO chat_streams (id, session_id, chunks_json, complete, source, created_at, updated_at) VALUES (?, ?, '[]', 0, 'executive', ?, ?)",
      id, sessionId, createdAt, createdAt,
    );
  }
  appendChatStreamChunk(id: string, text: string): void {
    const rows = this.sql.all<Row>("SELECT chunks_json FROM chat_streams WHERE id = ?", id);
    const chunks = rows.length ? (JSON.parse(String(rows[0]!.chunks_json ?? "[]")) as string[]) : [];
    chunks.push(text);
    this.sql.run(
      "UPDATE chat_streams SET chunks_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(chunks), new Date().toISOString(), id,
    );
  }
  completeChatStream(id: string, error?: string): void {
    this.sql.run(
      "UPDATE chat_streams SET complete = 1, error = ?, updated_at = ? WHERE id = ?",
      error ?? null, new Date().toISOString(), id,
    );
  }
  readChatStream(id: string, afterIndex: number): { chunks: string[]; nextIndex: number; complete: boolean; error?: string } {
    const rows = this.sql.all<Row>("SELECT * FROM chat_streams WHERE id = ?", id);
    if (!rows.length) return { chunks: [], nextIndex: afterIndex, complete: true, error: "Stream not found" };
    const all = JSON.parse(String(rows[0]!.chunks_json ?? "[]")) as string[];
    // afterIndex = number of chunks already consumed (-1 = none). We return
    // chunks from that count onward and report the total count as nextIndex so
    // the next poll resumes exactly after what was returned.
    const chunks = all.slice(Math.max(0, afterIndex));
    return {
      chunks,
      nextIndex: all.length,
      complete: rows[0]!.complete === 1,
      error: rows[0]!.error ? String(rows[0]!.error) : undefined,
    };
  }
  deleteChatStream(id: string): void {
    this.sql.run("DELETE FROM chat_streams WHERE id = ?", id);
  }

  // -- model costs (implements CostStorage) -------------------------------
  record(call: ModelCallRecord): void {
    const now = new Date().toISOString();
    this.insert("model_costs", {
      id: `mcr_${crypto.randomUUID()}`,
      provider: call.provider,
      model: call.model,
      task_type: call.taskType,
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
      cost: call.cost,
      session_id: call.sessionId ?? null,
      run_id: call.runId ?? null,
      latency_ms: call.latencyMs,
      source: "executive",
      created_at: now,
      updated_at: now,
    });
  }
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.sql.all<Row>("SELECT COALESCE(SUM(cost),0) AS s FROM model_costs WHERE substr(created_at,1,10) = ?", day);
    return Number(rows[0]?.s ?? 0);
  }
  spentThisMonth(): number {
    const month = new Date().toISOString().slice(0, 7);
    const rows = this.sql.all<Row>("SELECT COALESCE(SUM(cost),0) AS s FROM model_costs WHERE substr(created_at,1,7) = ?", month);
    return Number(rows[0]?.s ?? 0);
  }
  /** Total tokens (input + output) consumed today (UTC). */
  tokensToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.sql.all<Row>("SELECT COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0) AS t FROM model_costs WHERE substr(created_at,1,10) = ?", day);
    return Number(rows[0]?.t ?? 0);
  }
  /** Total tokens (input + output) consumed this calendar month (UTC). */
  tokensThisMonth(): number {
    const month = new Date().toISOString().slice(0, 7);
    const rows = this.sql.all<Row>("SELECT COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0) AS t FROM model_costs WHERE substr(created_at,1,7) = ?", month);
    return Number(rows[0]?.t ?? 0);
  }
  spentThisRun(runId?: string): number {
    if (!runId) return 0;
    const rows = this.sql.all<Row>("SELECT COALESCE(SUM(cost),0) AS s FROM model_costs WHERE run_id = ?", runId);
    return Number(rows[0]?.s ?? 0);
  }
  spentThisSession(sessionId?: string): number {
    if (!sessionId) return 0;
    const rows = this.sql.all<Row>("SELECT COALESCE(SUM(cost),0) AS s FROM model_costs WHERE session_id = ?", sessionId);
    return Number(rows[0]?.s ?? 0);
  }
  costHistory(limit = 100): ModelCallRecord[] {
    return this.sql.all<Row>("SELECT * FROM model_costs ORDER BY created_at DESC LIMIT ?", limit).map((r) => ({
      provider: String(r.provider),
      model: String(r.model),
      taskType: String(r.task_type) as ModelCallRecord["taskType"],
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cost: Number(r.cost),
      sessionId: r.session_id ? String(r.session_id) : undefined,
      runId: r.run_id ? String(r.run_id) : undefined,
      latencyMs: Number(r.latency_ms),
      timestamp: String(r.created_at),
    }));
  }

  // -- settings (migration v13) ------------------------------------------
  /**
   * Founder-editable key/value overrides (persisted across deploys). Used for
   * AI budget overrides and the cached provider balance.
   */
  getSetting(key: string): string | null {
    const rows = this.sql.all<Row>("SELECT value FROM settings WHERE key = ?", key);
    return rows[0]?.value ? String(rows[0].value) : null;
  }
  setSetting(key: string, value: string | null): void {
    const now = new Date().toISOString();
    if (value === null) {
      this.sql.run("DELETE FROM settings WHERE key = ?", key);
      return;
    }
    this.sql.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value, now,
    );
  }
  getSettingUpdatedAt(key: string): string | null {
    const rows = this.sql.all<Row>("SELECT updated_at FROM settings WHERE key = ?", key);
    return rows[0]?.updated_at ? String(rows[0].updated_at) : null;
  }

  /** Persisted AI budget overrides (numbers or undefined = use env default). */
  getBudgetOverrides(): { aiDailyBudget?: number; aiMonthlyBudget?: number; aiPerTaskBudget?: number; aiPerRunBudget?: number } {
    const num = (k: string): number | undefined => {
      const v = this.getSetting(k);
      if (v === null || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    return {
      aiDailyBudget: num("ai_daily_budget"),
      aiMonthlyBudget: num("ai_monthly_budget"),
      aiPerTaskBudget: num("ai_per_task_budget"),
      aiPerRunBudget: num("ai_per_run_budget"),
    };
  }
  /** Persist AI budget overrides. Pass undefined/omit to keep the env default. */
  setBudgetOverrides(o: { aiDailyBudget?: number; aiMonthlyBudget?: number; aiPerTaskBudget?: number; aiPerRunBudget?: number }): void {
    const set = (k: string, v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v) && v > 0) this.setSetting(k, String(v));
    };
    set("ai_daily_budget", o.aiDailyBudget);
    set("ai_monthly_budget", o.aiMonthlyBudget);
    set("ai_per_task_budget", o.aiPerTaskBudget);
    set("ai_per_run_budget", o.aiPerRunBudget);
  }

  /** Cached AI-provider balance (JSON string + when it was fetched). */
  getProviderBalanceCache(): { json: string | null; updatedAt: string | null } {
    return { json: this.getSetting("provider_balance_json"), updatedAt: this.getSettingUpdatedAt("provider_balance_json") };
  }
  setProviderBalanceCache(json: string | null): void {
    this.setSetting("provider_balance_json", json);
  }

  // -- calendar (migration v14) ------------------------------------------
  listCalendarEvents(fromIso?: string, toIso?: string, limit = 100): CalendarEvent[] {
    if (fromIso && toIso) {
      return this.sql
        .all<Row>("SELECT * FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC LIMIT ?", fromIso, toIso, limit)
        .map((r) => rowTo<CalendarEvent>(r));
    }
    return this.sql.all<Row>("SELECT * FROM calendar_events ORDER BY start_at ASC LIMIT ?", limit).map((r) => rowTo<CalendarEvent>(r));
  }
  getCalendarEvent(id: string): CalendarEvent | null {
    const rows = this.sql.all<Row>("SELECT * FROM calendar_events WHERE id = ?", id);
    return rows[0] ? rowTo<CalendarEvent>(rows[0]) : null;
  }
  createCalendarEvent(e: CalendarEvent): void {
    this.insert("calendar_events", e);
  }
  updateCalendarEvent(id: string, patch: Partial<CalendarEvent>): CalendarEvent | null {
    const existing = this.getCalendarEvent(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
    this.update("calendar_events", id, next);
    return this.getCalendarEvent(id);
  }
  deleteCalendarEvent(id: string): boolean {
    const existing = this.getCalendarEvent(id);
    if (!existing) return false;
    this.sql.run("DELETE FROM calendar_events WHERE id = ?", id);
    return true;
  }

  // -- notes (migration v14) ---------------------------------------------
  listNotes(limit = 100): Note[] {
    return this.sql.all<Row>("SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT ?", limit).map((r) => rowTo<Note>(r));
  }
  getNote(id: string): Note | null {
    const rows = this.sql.all<Row>("SELECT * FROM notes WHERE id = ?", id);
    return rows[0] ? rowTo<Note>(rows[0]) : null;
  }
  createNote(n: Note): void {
    this.insert("notes", n);
  }
  updateNote(id: string, patch: Partial<Note>): Note | null {
    const existing = this.getNote(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
    this.update("notes", id, next);
    return this.getNote(id);
  }
  deleteNote(id: string): boolean {
    const existing = this.getNote(id);
    if (!existing) return false;
    this.sql.run("DELETE FROM notes WHERE id = ?", id);
    return true;
  }

  // -- reminders (migration v14) -----------------------------------------
  /** Open reminders, soonest first. Optionally only overdue (due <= now). */
  listReminders(opts: { includeDone?: boolean; overdueOnly?: boolean; limit?: number } = {}): Reminder[] {
    const limit = opts.limit ?? 100;
    if (opts.overdueOnly) {
      return this.sql
        .all<Row>("SELECT * FROM reminders WHERE done = 0 AND due_at <= ? ORDER BY due_at ASC LIMIT ?", new Date().toISOString(), limit)
        .map((r) => rowTo<Reminder>(r));
    }
    if (opts.includeDone) {
      return this.sql.all<Row>("SELECT * FROM reminders ORDER BY due_at ASC LIMIT ?", limit).map((r) => rowTo<Reminder>(r));
    }
    return this.sql.all<Row>("SELECT * FROM reminders WHERE done = 0 ORDER BY due_at ASC LIMIT ?", limit).map((r) => rowTo<Reminder>(r));
  }
  getReminder(id: string): Reminder | null {
    const rows = this.sql.all<Row>("SELECT * FROM reminders WHERE id = ?", id);
    return rows[0] ? rowTo<Reminder>(rows[0]) : null;
  }
  createReminder(r: Reminder): void {
    this.insert("reminders", r);
  }
  markReminderDone(id: string): Reminder | null {
    const existing = this.getReminder(id);
    if (!existing) return null;
    return this.updateReminder(id, { done: 1, done_at: new Date().toISOString() });
  }
  updateReminder(id: string, patch: Partial<Reminder>): Reminder | null {
    const existing = this.getReminder(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
    this.update("reminders", id, next);
    return this.getReminder(id);
  }
  deleteReminder(id: string): boolean {
    const existing = this.getReminder(id);
    if (!existing) return false;
    this.sql.run("DELETE FROM reminders WHERE id = ?", id);
    return true;
  }

  // -- contacts (migration v14) ------------------------------------------
  listContacts(limit = 200): Contact[] {
    return this.sql.all<Row>("SELECT * FROM contacts ORDER BY name ASC LIMIT ?", limit).map((r) => rowTo<Contact>(r));
  }
  getContact(id: string): Contact | null {
    const rows = this.sql.all<Row>("SELECT * FROM contacts WHERE id = ?", id);
    return rows[0] ? rowTo<Contact>(rows[0]) : null;
  }
  createContact(c: Contact): void {
    this.insert("contacts", c);
  }
  deleteContact(id: string): boolean {
    const existing = this.getContact(id);
    if (!existing) return false;
    this.sql.run("DELETE FROM contacts WHERE id = ?", id);
    return true;
  }

  // -- tool executions ----------------------------------------------------
  /**
   * Record (or update) a tool execution. The tool registry reuses the same
   * executionId across lifecycle records (RUNNING → SUCCESS/FAILED), so this
   * is an upsert keyed on id — a plain INSERT would violate the primary key.
   */
  recordToolExecution(t: ToolExecution): void {
    this.sql.run(
      `INSERT INTO tool_executions
         (id, tool_name, input_json, output_json, permission, verdict, status,
          cost_estimate, reversible, run_id, error, started_at, finished_at,
          source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         output_json = excluded.output_json,
         verdict = excluded.verdict,
         status = excluded.status,
         error = excluded.error,
         finished_at = excluded.finished_at`,
      t.id,
      t.tool_name,
      t.input_json,
      t.output_json ?? null,
      t.permission,
      t.verdict,
      t.status,
      t.cost_estimate ?? null,
      t.reversible ? 1 : 0,
      t.run_id ?? null,
      t.error ?? null,
      t.started_at ?? null,
      t.finished_at ?? null,
      t.source ?? "executive",
      t.created_at,
    );
  }
  listToolExecutions(limit = 50): ToolExecution[] {
    return this.sql.all<Row>("SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<ToolExecution>(r));
  }

  // -- long-horizon agent runs (migration v9) ----------------------------
  createAgentRun(r: AgentRun): void {
    this.insert("agent_jobs", r);
  }
  heartbeatAgentRun(id: string, iterations: number, toolsCalled: number): void {
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE agent_jobs SET iterations = ?, tools_called = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
      iterations, toolsCalled, now, now, id,
    );
  }
  /** Save a durable transcript snapshot so a run can resume after a restart. */
  checkpointAgentRun(id: string, checkpointJson: string): void {
    this.sql.run(
      "UPDATE agent_jobs SET checkpoint_json = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
      checkpointJson, new Date().toISOString(), new Date().toISOString(), id,
    );
  }
  finishAgentRun(id: string, status: AgentRun["status"], result?: string, error?: string): void {
    this.sql.run(
      "UPDATE agent_jobs SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      status, result ?? null, error ?? null, new Date().toISOString(), new Date().toISOString(), id,
    );
  }
  getAgentRun(id: string): AgentRun | null {
    const rows = this.sql.all<Row>("SELECT * FROM agent_jobs WHERE id = ?", id);
    return rows.length ? rowTo<AgentRun>(rows[0]) : null;
  }
  /** Reopen a stopped/timed-out/failed run: back to RUNNING, history kept. */
  resetAgentRun(id: string): void {
    // Refresh last_heartbeat too — a resumed run with a NULL/stale heartbeat
    // would be instantly reaped again as a "restart orphan" by maintenance.
    const now = new Date().toISOString();
    this.sql.run(
      "UPDATE agent_jobs SET status = 'RUNNING', result = NULL, error = NULL, finished_at = NULL, last_heartbeat = ?, updated_at = ? WHERE id = ?",
      now, now, id,
    );
  }
  listAgentRuns(limit = 20): AgentRun[] {
    return this.sql.all<Row>("SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<AgentRun>(r));
  }
  /**
   * Long-horizon runs that were interrupted by a restart before doing any work
   * (0 iterations) — the "Interrupted by a restart" orphans. These are safe to
   * auto-resume because no tool side-effects could have happened yet.
   */
  listInterruptedRuns(limit = 50): AgentRun[] {
    return this.sql
      .all<Row>(
        "SELECT * FROM agent_jobs WHERE status = 'FAILED' AND iterations = 0 AND error LIKE '%Interrupted by a restart%' ORDER BY updated_at ASC LIMIT ?",
        limit,
      )
      .map((r) => rowTo<AgentRun>(r));
  }
  countInterruptedRuns(): number {
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM agent_jobs WHERE status = 'FAILED' AND iterations = 0 AND error LIKE '%Interrupted by a restart%'");
    return Number(rows[0]?.c ?? 0);
  }
  /** Reopen a batch of interrupted (0-iteration) runs back to RUNNING. Returns the reopened ids. */
  resetInterruptedRuns(limit = 10): string[] {
    const rows = this.sql.all<Row>(
      "SELECT id FROM agent_jobs WHERE status = 'FAILED' AND iterations = 0 AND error LIKE '%Interrupted by a restart%' ORDER BY updated_at ASC LIMIT ?",
      limit,
    );
    const ids: string[] = [];
    for (const r of rows) {
      const id = String(r.id);
      // Must go through resetAgentRun (refreshes last_heartbeat) — otherwise a
      // resumed run with a NULL heartbeat is instantly reaped again as stale.
      this.resetAgentRun(id);
      ids.push(id);
    }
    return ids;
  }
  /**
   * Long-horizon runs that hit the per-sweep iteration limit and were parked as
   * STOPPED with an auto-continue note. They hold a durable checkpoint, so the
   * maintenance sweep resumes them and they keep working across sweeps (all-day
   * execution, bounded only by the AI spend gate).
   */
  listLimitReachedRuns(limit = 50): AgentRun[] {
    return this.sql
      .all<Row>(
        "SELECT * FROM agent_jobs WHERE status = 'STOPPED' AND error LIKE '%auto-continue%' ORDER BY updated_at ASC LIMIT ?",
        limit,
      )
      .map((r) => rowTo<AgentRun>(r));
  }
  countLimitReachedRuns(): number {
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM agent_jobs WHERE status = 'STOPPED' AND error LIKE '%auto-continue%'");
    return Number(rows[0]?.c ?? 0);
  }
  /** Reopen a batch of limit-reached runs back to RUNNING (checkpoint preserved). */
  resetLimitReachedRuns(limit = 10): string[] {
    const rows = this.sql.all<Row>(
      "SELECT id FROM agent_jobs WHERE status = 'STOPPED' AND error LIKE '%auto-continue%' ORDER BY updated_at ASC LIMIT ?",
      limit,
    );
    const ids: string[] = [];
    for (const r of rows) {
      const id = String(r.id);
      this.resetAgentRun(id);
      ids.push(id);
    }
    return ids;
  }
  /**
   * Delete superseded restart-orphan runs — 0-iteration FAILED "Interrupted by
   * a restart" runs whose task already has a newer non-FAILED run. They can
   * never be resumed (a newer run owns the task), so they are dead weight that
   * makes the Doctor's interrupted pile look bigger than the real work. Safe:
   * 0 iterations means no tool side-effects happened. Returns deleted ids.
   */
  cleanupSupersededOrphanRuns(): string[] {
    const rows = this.sql.all<Row>(
      "SELECT id, task_id, created_at FROM agent_jobs WHERE status = 'FAILED' AND iterations = 0 AND error LIKE '%Interrupted by a restart%' AND task_id IS NOT NULL",
    );
    const deleted: string[] = [];
    for (const r of rows) {
      const taskId = String(r.task_id);
      const created = String(r.created_at);
      const newer = this.sql.all<Row>(
        "SELECT id FROM agent_jobs WHERE task_id = ? AND status <> 'FAILED' AND created_at > ? LIMIT 1",
        taskId, created,
      );
      if (newer.length === 0) continue;
      this.sql.run("DELETE FROM agent_jobs WHERE id = ?", String(r.id));
      deleted.push(String(r.id));
    }
    return deleted;
  }
  /**
   * Most recent AI-provider payment failure (HTTP 402 / Insufficient Balance)
   * across cloud runs and local tasks — surfaces "the account needs topping up"
   * as a first-class Doctor concern instead of dozens of cryptic 402 errors.
   */
  recentProviderFailure(): { kind: string; at: string } | null {
    const runs = this.sql.all<Row>(
      "SELECT error, updated_at FROM agent_jobs WHERE error LIKE '%402%' OR error LIKE '%Insufficient Balance%' ORDER BY updated_at DESC LIMIT 1",
    );
    if (runs.length) return { kind: "cloud", at: String(runs[0]?.updated_at ?? "") };
    const local = this.sql.all<Row>(
      "SELECT error, updated_at FROM local_tasks WHERE error LIKE '%402%' OR error LIKE '%Insufficient Balance%' ORDER BY updated_at DESC LIMIT 1",
    );
    if (local.length) return { kind: "local-daemon", at: String(local[0]?.updated_at ?? "") };
    return null;
  }
  /** True if the task had a run end in a terminal failure within `withinMs` (re-creation backoff). */
  hasRecentFailedRunForTask(taskId: string, withinMs = 10 * 60_000): boolean {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    const rows = this.sql.all<Row>(
      "SELECT id FROM agent_jobs WHERE task_id = ? AND status IN ('FAILED','STOPPED','TIMEOUT') AND updated_at >= ? LIMIT 1",
      taskId, cutoff,
    );
    return rows.length > 0;
  }
  /**
   * Reap long-horizon runs that were left RUNNING with no heartbeat for the
   * given stale window (e.g. the DO restarted mid-run). Marks them FAILED so
   * the Founder can Continue from the durable checkpoint. Returns the ids.
   */
  reapStaleAgentRuns(staleAfterMs = 15 * 60_000): string[] {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const rows = this.sql.all<Row>(
      "SELECT id FROM agent_jobs WHERE status = 'RUNNING' AND (last_heartbeat IS NULL OR last_heartbeat < ?)",
      cutoff,
    );
    const ids = rows.map((r) => String(r.id));
    for (const id of ids) {
      this.sql.run(
        "UPDATE agent_jobs SET status = 'FAILED', error = 'Interrupted by a restart — use Continue to resume from the checkpoint.', finished_at = ?, updated_at = ? WHERE id = ?",
        new Date().toISOString(), new Date().toISOString(), id,
      );
    }
    return ids;
  }

  // -- local machine tasks (migration v10) -------------------------------
  createLocalTask(r: LocalTask): void {
    this.insert("local_tasks", r);
  }
  /**
   * Atomically claim the oldest PENDING task for a local daemon, with a lease
   * (default 10 min, extended by heartbeats). If the daemon's machine goes
   * offline, the lease lapses and another daemon can re-claim the task.
   */
  claimLocalTask(claimer: string, leaseMs = 10 * 60_000): LocalTask | null {
    const rows = this.sql.all<Row>(
      "SELECT * FROM local_tasks WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1",
    );
    const task = rows[0];
    if (!task) return null;
    const id = task.id as string;
    const now = new Date();
    this.sql.run(
      "UPDATE local_tasks SET status = 'CLAIMED', claimed_by = ?, started_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'",
      claimer, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), id,
    );
    return this.getLocalTask(id);
  }
  heartbeatLocalTask(id: string, status: LocalTask["status"], leaseMs = 10 * 60_000): void {
    const now = new Date();
    this.sql.run(
      "UPDATE local_tasks SET status = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?",
      status, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), id,
    );
  }
  finishLocalTask(id: string, status: "DONE" | "FAILED", result?: string, error?: string): void {
    this.sql.run(
      "UPDATE local_tasks SET status = ?, result = ?, error = ?, finished_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      status, result ?? null, error ?? null, new Date().toISOString(), new Date().toISOString(), id,
    );
  }
  getLocalTask(id: string): LocalTask | null {
    const rows = this.sql.all<Row>("SELECT * FROM local_tasks WHERE id = ?", id);
    return rows.length ? rowTo<LocalTask>(rows[0]) : null;
  }
  listLocalTasks(limit = 25): LocalTask[] {
    // updated_at DESC so the most RECENTLY ACTIVE tasks (claimed / running /
    // just finished / heartbeated) surface first — otherwise, with a long
    // backlog of older-created tasks, the dashboard always shows stale
    // "last done hours ago" even while the daemon is actively working.
    return this.sql.all<Row>("SELECT * FROM local_tasks ORDER BY updated_at DESC LIMIT ?", limit).map((r) => rowTo<LocalTask>(r));
  }
  /**
   * Reap local tasks whose claim lease has expired (the machine went offline
   * mid-task). They return to PENDING so any daemon can re-claim them.
   * Returns the reaped ids.
   */
  reapExpiredLocalTasks(): string[] {
    const now = new Date().toISOString();
    const rows = this.sql.all<Row>(
      "SELECT id FROM local_tasks WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
      now,
    );
    const ids = rows.map((r) => String(r.id));
    for (const id of ids) {
      this.sql.run(
        "UPDATE local_tasks SET status = 'PENDING', claimed_by = NULL, started_at = NULL, lease_expires_at = NULL, error = 'Re-queued: the previous worker lease expired (machine likely offline).', updated_at = ? WHERE id = ?",
        now, id,
      );
    }
    return ids;
  }
  /**
   * Requeue completed/failed local tasks whose result or error mentions a
   * retryable condition (default: the tool-call limit). A task that "finished"
   * with the tool-call-limit message never actually completed — it returns to
   * PENDING so the daemon retries it with the extended limit. Tasks whose text
   * contains `exclude` (default "402" — insufficient balance, needs funding)
   * are skipped. Uses SQL LIKE so only matching rows are read (row-budget safe).
   * Returns the requeued ids.
   */
  requeueLocalTasks(opts: { match?: string; exclude?: string; limit?: number } = {}): string[] {
    const match = opts.match ?? "tool-call limit";
    const exclude = opts.exclude ?? "402";
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 2000));
    const like = `%${match}%`;
    const rows = this.sql.all<Row>(
      "SELECT id, result, error FROM local_tasks WHERE status IN ('DONE','FAILED') AND (result LIKE ? OR error LIKE ?) ORDER BY updated_at ASC LIMIT ?",
      like, like, limit,
    );
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (const r of rows) {
      const text = `${String(r.result ?? "")} ${String(r.error ?? "")}`;
      if (exclude && text.includes(exclude)) continue;
      this.sql.run(
        "UPDATE local_tasks SET status = 'PENDING', result = NULL, error = NULL, finished_at = NULL, claimed_by = NULL, started_at = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        now, String(r.id),
      );
      ids.push(String(r.id));
    }
    return ids;
  }

  // -- uploaded files (migration v11) -------------------------------------
  createUploadedFile(f: UploadedFile): void {
    this.insert("uploaded_files", f);
  }
  getUploadedFile(id: string): UploadedFile | null {
    const rows = this.sql.all<Row>("SELECT * FROM uploaded_files WHERE id = ?", id);
    return rows.length ? rowTo<UploadedFile>(rows[0]) : null;
  }
  listUploadedFiles(limit = 50): UploadedFile[] {
    return this.sql.all<Row>("SELECT * FROM uploaded_files ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<UploadedFile>(r));
  }
  deleteUploadedFile(id: string): boolean {
    const existing = this.getUploadedFile(id);
    if (!existing) return false;
    this.sql.run("DELETE FROM uploaded_files WHERE id = ?", id);
    return true;
  }

  // -- workstreams & pipeline gates ---------------------------------------
  insertWorkstream(w: Workstream): void {
    this.insert("workstreams", w);
  }  listWorkstreams(): Workstream[] {
    return this.sql.all<Row>("SELECT * FROM workstreams ORDER BY created_at ASC").map((r) => rowTo<Workstream>(r));
  }
  insertPipelineGate(g: PipelineGate): void {
    this.insert("pipeline_gates", g);
  }
  listPipelineGates(pluginId?: string): PipelineGate[] {
    const rows = pluginId
      ? this.sql.all<Row>("SELECT * FROM pipeline_gates WHERE plugin_id = ? ORDER BY gate_number ASC", pluginId)
      : this.sql.all<Row>("SELECT * FROM pipeline_gates ORDER BY plugin_id ASC, gate_number ASC");
    return rows.map((r) => rowTo<PipelineGate>(r));
  }
  updatePipelineGate(id: string, patch: Partial<PipelineGate>): void {
    this.update("pipeline_gates", id, patch as Row);
  }

  // -- local agent health beacon (migration v20) --------------------------
  getLocalAgentStatus(): { id: string; host?: string; version?: string; pid?: string; last_seen?: string; last_claim_at?: string; started_at?: string } | null {
    const rows = this.sql.all<Row>("SELECT * FROM local_agent_status WHERE id = 'local'");
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: String(r.id),
      host: r.host ? String(r.host) : undefined,
      version: r.version ? String(r.version) : undefined,
      pid: r.pid ? String(r.pid) : undefined,
      last_seen: r.last_seen ? String(r.last_seen) : undefined,
      last_claim_at: r.last_claim_at ? String(r.last_claim_at) : undefined,
      started_at: r.started_at ? String(r.started_at) : undefined,
    };
  }
  /** Record a heartbeat from the local daemon (idempotent single row). */
  upsertLocalAgentHeartbeat(input: { host?: string; version?: string; pid?: string; claimed?: boolean }): void {
    const now = new Date().toISOString();
    const existing = this.sql.all<Row>("SELECT id FROM local_agent_status WHERE id = 'local'");
    if (existing.length === 0) {
      this.insert("local_agent_status", {
        id: "local",
        host: input.host ?? null,
        version: input.version ?? null,
        pid: input.pid ?? null,
        last_seen: now,
        last_claim_at: input.claimed ? now : null,
        started_at: now,
        created_at: now,
        updated_at: now,
      });
      return;
    }
    const sets = ["last_seen = ?", "updated_at = ?"];
    const params: SqlParam[] = [now, now];
    if (input.host) { sets.push("host = ?"); params.push(input.host); }
    if (input.version) { sets.push("version = ?"); params.push(input.version); }
    if (input.pid) { sets.push("pid = ?"); params.push(input.pid); }
    if (input.claimed) { sets.push("last_claim_at = ?"); params.push(now); }
    params.push("local");
    this.sql.run(`UPDATE local_agent_status SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }
  /** Age (ms) since the daemon's last heartbeat, or null if never seen. */
  localAgentSeenAgoMs(): number | null {
    const s = this.getLocalAgentStatus();
    if (!s?.last_seen) return null;
    const t = Date.parse(s.last_seen);
    if (Number.isNaN(t)) return null;
    return Date.now() - t;
  }
  /** Count PENDING local tasks older than the given age (ms). */
  countAgingPendingLocalTasks(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM local_tasks WHERE status = 'PENDING' AND created_at < ?", cutoff);
    return Number(rows[0]?.c ?? 0);
  }

  // -- founder credentials & sessions --------------------------------------
  getFounderCredentials(): { id: string; username: string; password_hash: string; failed_attempts: number; locked_until?: string } | null {
    const rows = this.sql.all<Row>("SELECT * FROM founder_credentials WHERE id = ?", "founder");
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: String(r.id),
      username: String(r.username),
      password_hash: String(r.password_hash),
      failed_attempts: Number(r.failed_attempts ?? 0),
      locked_until: r.locked_until ? String(r.locked_until) : undefined,
    };
  }

  setFounderCredentials(input: { username: string; password_hash: string }): void {
    const now = new Date().toISOString();
    const existing = this.getFounderCredentials();
    if (existing) {
      this.sql.run(
        "UPDATE founder_credentials SET username = ?, password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
        input.username,
        input.password_hash,
        now,
        "founder",
      );
    } else {
      this.insert("founder_credentials", {
        id: "founder",
        username: input.username,
        password_hash: input.password_hash,
        failed_attempts: 0,
        locked_until: null,
        created_at: now,
        updated_at: now,
      });
    }
  }

  updateFounderCredentials(patch: { password_hash?: string; failed_attempts?: number; locked_until?: string | null }): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    if (patch.password_hash !== undefined) { sets.push("password_hash = ?"); params.push(patch.password_hash); }
    if (patch.failed_attempts !== undefined) { sets.push("failed_attempts = ?"); params.push(patch.failed_attempts); }
    if (patch.locked_until !== undefined) { sets.push("locked_until = ?"); params.push(patch.locked_until); }
    if (sets.length === 0) return;
    params.push(new Date().toISOString());
    this.sql.run(`UPDATE founder_credentials SET ${sets.join(", ")}, updated_at = ? WHERE id = 'founder'`, ...params);
  }

  createSession(input: { token: string; username: string; expires_at: string }): void {
    const now = new Date().toISOString();
    this.insert("auth_sessions", {
      id: `sess_${crypto.randomUUID()}`,
      token: input.token,
      username: input.username,
      created_at: now,
      expires_at: input.expires_at,
    });
  }

  getSession(token: string): { username: string; expires_at: string } | null {
    const rows = this.sql.all<Row>("SELECT * FROM auth_sessions WHERE token = ?", token);
    if (rows.length === 0) return null;
    return { username: String(rows[0]!.username), expires_at: String(rows[0]!.expires_at) };
  }

  deleteSession(token: string): void {
    this.sql.run("DELETE FROM auth_sessions WHERE token = ?", token);
  }

  /** Delete every session except the caller's (used after a password change). Pass null to delete all. */
  deleteSessionsExcept(keepToken: string | null): void {
    if (keepToken) {
      this.sql.run("DELETE FROM auth_sessions WHERE token <> ?", keepToken);
    } else {
      this.sql.run("DELETE FROM auth_sessions");
    }
  }

  deleteExpiredSessions(): void {
    this.sql.run("DELETE FROM auth_sessions WHERE expires_at < ?", new Date().toISOString());
  }
  /**
   * Full maintenance sweep — run on every DO wake + on a daily schedule so the
   * system self-heals after restarts: reaps stale agent runs, re-queues
   * expired local-task leases, and deletes expired sessions.
   */
  runMaintenance(opts: { staleRunMs?: number } = {}): { staleRuns: string[]; reapedLocal: string[]; expiredSessions: number } {
    const staleRuns = this.reapStaleAgentRuns(opts.staleRunMs);
    const reapedLocal = this.reapExpiredLocalTasks();
    const before = this.sql.all<Row>("SELECT COUNT(*) AS c FROM auth_sessions WHERE expires_at < ?", new Date().toISOString());
    const count = Number(before[0]?.c ?? 0);
    this.deleteExpiredSessions();
    return { staleRuns, reapedLocal, expiredSessions: count };
  }
  /** Counts of stuck work (for health checks / overview). */
  stuckCounts(): { staleAgentRuns: number; expiredLeases: number } {
    const now = new Date().toISOString();
    const staleAgentRuns = this.sql.all<Row>("SELECT COUNT(*) AS c FROM agent_jobs WHERE status = 'RUNNING' AND (last_heartbeat IS NULL OR last_heartbeat < ?)", new Date(Date.now() - 15 * 60_000).toISOString());
    const expiredLeases = this.sql.all<Row>("SELECT COUNT(*) AS c FROM local_tasks WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?", now);
    return {
      staleAgentRuns: Number(staleAgentRuns[0]?.c ?? 0),
      expiredLeases: Number(expiredLeases[0]?.c ?? 0),
    };
  }
  /**
   * Reset the whole company's PRODUCTION PROGRESS to a clean slate so a new
   * operator starts fresh (used when handing the company over). Safe by design:
   * nothing is deleted — active tasks are CANCELLED (archived in place), gates
   * go back to NOT_STARTED, products back to CONCEPT, and in-flight local work
   * is cancelled. A full snapshot is returned for the caller to keep as a
   * backup before the reset is considered complete.
   */
  resetProductionProgress(): {
    archivedTasks: number;
    resetGates: number;
    resetProducts: number;
    cancelledLocal: number;
    clearedReviews: number;
  } {
    const now = new Date().toISOString();
    const count = (q: string) => Number(this.sql.all<Row>(q)[0]?.c ?? 0);
    const archivedTasks = count("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('OPEN','IN_PROGRESS','BLOCKED')");
    if (archivedTasks > 0) this.sql.run("UPDATE tasks SET status = 'CANCELLED', updated_at = ?, completed_at = ? WHERE status IN ('OPEN','IN_PROGRESS','BLOCKED')", now, now);
    const resetGates = count("SELECT COUNT(*) AS c FROM pipeline_gates WHERE status IN ('PASSED','IN_PROGRESS','BLOCKED','SHIPPED')");
    if (resetGates > 0) this.sql.run("UPDATE pipeline_gates SET status = 'NOT_STARTED', note = NULL, updated_at = ? WHERE status IN ('PASSED','IN_PROGRESS','BLOCKED','SHIPPED')", now);
    const resetProducts = count("SELECT COUNT(*) AS c FROM products WHERE status IN ('SHIPPED','PLANNED','IN-THE-LAB')");
    if (resetProducts > 0) this.sql.run("UPDATE products SET status = 'CONCEPT', version = NULL, updated_at = ? WHERE status IN ('SHIPPED','PLANNED','IN-THE-LAB')", now);
    const cancelledLocal = count("SELECT COUNT(*) AS c FROM local_tasks WHERE status IN ('PENDING','CLAIMED','RUNNING')");
    if (cancelledLocal > 0) this.sql.run("UPDATE local_tasks SET status = 'CANCELLED', updated_at = ? WHERE status IN ('PENDING','CLAIMED','RUNNING')", now);
    // Operator review history is worth keeping, but pending reviews from the old
    // regime are reset so the new operator starts a clean queue.
    const clearedReviews = count("SELECT COUNT(*) AS c FROM review_items WHERE status = 'PENDING'");
    if (clearedReviews > 0) this.sql.run("UPDATE review_items SET status = 'NEEDS_WORK', note = 'Superseded by production reset.', updated_at = ? WHERE status = 'PENDING'", now);
    return { archivedTasks, resetGates, resetProducts, cancelledLocal, clearedReviews };
  }

  // -- Productivity Manager (migration v18) --------------------------------
  // Assignments ----------------------------------------------------------
  insertAssignment(a: ProductivityAssignment): void {
    this.insert("productivity_assignments", a);
  }
  getAssignment(id: string): ProductivityAssignment | null {
    const rows = this.sql.all<Row>("SELECT * FROM productivity_assignments WHERE id = ?", id);
    return rows.length ? rowTo<ProductivityAssignment>(rows[0]) : null;
  }
  listAssignments(opts: { status?: string; limit?: number } = {}): ProductivityAssignment[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    if (opts.status) {
      return this.sql
        .all<Row>("SELECT * FROM productivity_assignments WHERE status = ? ORDER BY created_at DESC LIMIT ?", opts.status, limit)
        .map((r) => rowTo<ProductivityAssignment>(r));
    }
    return this.sql.all<Row>("SELECT * FROM productivity_assignments ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<ProductivityAssignment>(r));
  }
  updateAssignment(id: string, patch: Partial<ProductivityAssignment>): void {
    this.update("productivity_assignments", id, patch);
  }
  assignmentByTask(taskId: string): ProductivityAssignment | null {
    const rows = this.sql.all<Row>("SELECT * FROM productivity_assignments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", taskId);
    return rows.length ? rowTo<ProductivityAssignment>(rows[0]) : null;
  }
  /** Add token/cost usage to an assignment (task-scope actuals). */
  addAssignmentUsage(taskId: string, tokens: number, cost: number): void {
    this.sql.run(
      "UPDATE productivity_assignments SET tokens_used = tokens_used + ?, cost_actual = cost_actual + ?, updated_at = ? WHERE task_id = ?",
      tokens,
      cost,
      new Date().toISOString(),
      taskId,
    );
  }
  /** Count assignments stuck in ASSIGNED/IN_PROGRESS past the given age (ms). */
  countStaleAssignments(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.sql.all<Row>(
      "SELECT COUNT(*) AS c FROM productivity_assignments WHERE status IN ('ASSIGNED','IN_PROGRESS') AND (started_at IS NULL OR started_at < ?)",
      cutoff,
    );
    return Number(rows[0]?.c ?? 0);
  }
  /** Mark stale assignments STALLED (Doctor auto-fix). Returns ids touched. */
  reapStaleAssignments(olderThanMs: number): string[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.sql.all<Row>(
      "SELECT id FROM productivity_assignments WHERE status IN ('ASSIGNED','IN_PROGRESS') AND (started_at IS NULL OR started_at < ?)",
      cutoff,
    );
    const ids = rows.map((r) => String(r.id));
    for (const id of ids) {
      this.sql.run(
        "UPDATE productivity_assignments SET status = 'STALLED', note = COALESCE(note, '') || 'Auto-marked STALLED by System Doctor (no progress within window).', updated_at = ? WHERE id = ?",
        new Date().toISOString(),
        id,
      );
    }
    return ids;
  }

  // Role skills -----------------------------------------------------------
  upsertRoleSkill(roleId: string, skill: string, proficiency: number, source = "manager"): void {
    const rows = this.sql.all<Row>("SELECT id FROM role_skills WHERE role_id = ? AND skill = ?", roleId, skill);
    const now = new Date().toISOString();
    if (rows.length) {
      this.sql.run("UPDATE role_skills SET proficiency = ?, updated_at = ? WHERE id = ?", proficiency, now, String(rows[0]!.id));
    } else {
      this.insert("role_skills", { id: newId("sk"), role_id: roleId, skill, proficiency, source, updated_at: now });
    }
  }
  listRoleSkills(roleId?: string): RoleSkill[] {
    if (roleId) {
      return this.sql.all<Row>("SELECT * FROM role_skills WHERE role_id = ? ORDER BY proficiency DESC", roleId).map((r) => rowTo<RoleSkill>(r));
    }
    return this.sql.all<Row>("SELECT * FROM role_skills ORDER BY role_id, proficiency DESC").map((r) => rowTo<RoleSkill>(r));
  }
  removeRoleSkill(roleId: string, skill: string): void {
    this.sql.run("DELETE FROM role_skills WHERE role_id = ? AND skill = ?", roleId, skill);
  }

  // Task skills -----------------------------------------------------------
  setTaskSkills(taskId: string, skills: Array<{ skill: string; weight: number }>): void {
    this.sql.run("DELETE FROM task_skills WHERE task_id = ?", taskId);
    const now = new Date().toISOString();
    for (const s of skills) {
      this.insert("task_skills", { id: newId("tsk"), task_id: taskId, skill: s.skill, weight: s.weight, updated_at: now });
    }
  }
  listTaskSkills(taskId: string): TaskSkill[] {
    return this.sql.all<Row>("SELECT * FROM task_skills WHERE task_id = ? ORDER BY weight DESC", taskId).map((r) => rowTo<TaskSkill>(r));
  }

  // Token budgets ---------------------------------------------------------
  getTokenBudget(scope: string, scopeId?: string): TokenBudget | null {
    const rows = this.sql.all<Row>("SELECT * FROM token_budgets WHERE scope = ? AND scope_id IS ?", scope, scopeId ?? null);
    return rows.length ? rowTo<TokenBudget>(rows[0]) : null;
  }
  listTokenBudgets(): TokenBudget[] {
    return this.sql.all<Row>("SELECT * FROM token_budgets ORDER BY scope, scope_id").map((r) => rowTo<TokenBudget>(r));
  }
  upsertTokenBudget(b: { scope: string; scopeId?: string; dailyBudget?: number; monthlyBudget?: number; modelTier?: string }): void {
    const existing = this.getTokenBudget(b.scope, b.scopeId);
    const now = new Date().toISOString();
    if (existing) {
      this.sql.run(
        "UPDATE token_budgets SET daily_budget = ?, monthly_budget = ?, model_tier = COALESCE(?, model_tier), updated_at = ? WHERE id = ?",
        b.dailyBudget ?? existing.daily_budget ?? null,
        b.monthlyBudget ?? existing.monthly_budget ?? null,
        b.modelTier ?? null,
        now,
        existing.id,
      );
    } else {
      this.insert("token_budgets", {
        id: newId("tb"),
        scope: b.scope,
        scope_id: b.scopeId ?? null,
        daily_budget: b.dailyBudget ?? null,
        monthly_budget: b.monthlyBudget ?? null,
        tokens_used_today: 0,
        tokens_used_month: 0,
        cost_used_today: 0,
        cost_used_month: 0,
        model_tier: b.modelTier ?? null,
        updated_at: now,
      });
    }
  }
  /** Add token/cost usage to a scope budget (and matching task assignment). */
  addTokenUse(scope: string, scopeId: string | undefined, tokens: number, cost: number): void {
    let budget = this.getTokenBudget(scope, scopeId);
    if (!budget) {
      this.upsertTokenBudget({ scope, scopeId });
      budget = this.getTokenBudget(scope, scopeId);
    }
    if (!budget) return;
    this.sql.run(
      "UPDATE token_budgets SET tokens_used_today = tokens_used_today + ?, tokens_used_month = tokens_used_month + ?, cost_used_today = cost_used_today + ?, cost_used_month = cost_used_month + ?, updated_at = ? WHERE id = ?",
      tokens,
      tokens,
      cost,
      cost,
      new Date().toISOString(),
      budget.id,
    );
    if (scope === "task" && scopeId) this.addAssignmentUsage(scopeId, tokens, cost);
  }
  /** Recalibrate the global budget from env defaults (idempotent, safe). */
  recalibrateGlobalBudget(envDaily: number, envMonthly: number): void {
    const g = this.getTokenBudget("global");
    if (!g) {
      this.upsertTokenBudget({ scope: "global", dailyBudget: envDaily, monthlyBudget: envMonthly });
      return;
    }
    this.sql.run("UPDATE token_budgets SET daily_budget = ?, monthly_budget = ?, updated_at = ? WHERE id = ?", envDaily, envMonthly, new Date().toISOString(), g.id);
  }

  // Optimization events ---------------------------------------------------
  insertOptimizationEvent(e: Omit<OptimizationEvent, "id" | "created_at" | "updated_at"> & { scopeId?: string }): void {
    const { scopeId, ...rest } = e;
    this.insert("optimization_events", {
      ...rest,
      scope_id: rest.scope_id ?? scopeId ?? null,
      id: newId("opt"),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  listOptimizationEvents(limit = 50): OptimizationEvent[] {
    return this.sql.all<Row>("SELECT * FROM optimization_events ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<OptimizationEvent>(r));
  }

  // Contradictions --------------------------------------------------------
  /** Insert a contradiction; returns true if a new row was created (dedupes identical OPEN findings). */
  insertContradiction(c: Omit<Contradiction, "id" | "created_at" | "updated_at">): boolean {
    // Dedupe: skip if an identical OPEN contradiction already exists.
    const rows = this.sql.all<Row>(
      "SELECT id FROM contradictions WHERE kind = ? AND subject_a IS ? AND subject_b IS ? AND status = 'OPEN'",
      c.kind,
      c.subject_a ?? null,
      c.subject_b ?? null,
    );
    if (rows.length) return false;
    this.insert("contradictions", {
      ...c,
      id: newId("con"),
      status: c.status ?? "OPEN",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return true;
  }
  listContradictions(opts: { status?: string; limit?: number } = {}): Contradiction[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    if (opts.status) {
      return this.sql.all<Row>("SELECT * FROM contradictions WHERE status = ? ORDER BY created_at DESC LIMIT ?", opts.status, limit).map((r) => rowTo<Contradiction>(r));
    }
    return this.sql.all<Row>("SELECT * FROM contradictions ORDER BY created_at DESC LIMIT ?", limit).map((r) => rowTo<Contradiction>(r));
  }
  getContradiction(id: string): Contradiction | null {
    const rows = this.sql.all<Row>("SELECT * FROM contradictions WHERE id = ?", id);
    return rows.length ? rowTo<Contradiction>(rows[0]) : null;
  }
  countOpenContradictions(): number {
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM contradictions WHERE status = 'OPEN'");
    return Number(rows[0]?.c ?? 0);
  }
  resolveContradiction(id: string, status: ContradictionStatus, resolution: string, by: string): void {
    this.sql.run(
      "UPDATE contradictions SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
      status,
      resolution,
      by,
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    );
  }

  // Productivity metrics --------------------------------------------------
  getProductivityMetric(day: string): ProductivityMetric | null {
    const rows = this.sql.all<Row>("SELECT * FROM productivity_metrics WHERE day = ?", day);
    return rows.length ? rowTo<ProductivityMetric>(rows[0]) : null;
  }
  upsertProductivityMetric(day: string, m: { tasks_done: number; tokens_used: number; cost: number }): void {
    const existing = this.getProductivityMetric(day);
    const now = new Date().toISOString();
    const tasksPerDollar = m.cost > 0 ? Math.round((m.tasks_done / m.cost) * 100) / 100 : 0;
    const avgTokens = m.tasks_done > 0 ? Math.round(m.tokens_used / m.tasks_done) : 0;
    if (existing) {
      this.sql.run(
        "UPDATE productivity_metrics SET tasks_done = ?, tokens_used = ?, cost = ?, tasks_per_dollar = ?, avg_tokens_per_task = ?, updated_at = ? WHERE day = ?",
        m.tasks_done,
        m.tokens_used,
        m.cost,
        tasksPerDollar,
        avgTokens,
        now,
        day,
      );
    } else {
      this.insert("productivity_metrics", {
        id: newId("pm"),
        day,
        tasks_done: m.tasks_done,
        tokens_used: m.tokens_used,
        cost: m.cost,
        tasks_per_dollar: tasksPerDollar,
        avg_tokens_per_task: avgTokens,
        created_at: now,
        updated_at: now,
      });
    }
  }
  listProductivityMetrics(limit = 14): ProductivityMetric[] {
    return this.sql.all<Row>("SELECT * FROM productivity_metrics ORDER BY day DESC LIMIT ?", limit).map((r) => rowTo<ProductivityMetric>(r));
  }

  // -- System Doctor (migration v17) --------------------------------------
  /** Record a Doctor run into doctor_logs. */
  insertDoctorLog(log: DoctorLog): void {
    this.insert("doctor_logs", log);
  }
  listDoctorLogs(limit = 20): DoctorLog[] {
    return this.sql.all<Row>("SELECT * FROM doctor_logs ORDER BY run_at DESC LIMIT ?", limit).map((r) => rowTo<DoctorLog>(r));
  }
  latestDoctorLog(): DoctorLog | null {
    const rows = this.sql.all<Row>("SELECT * FROM doctor_logs ORDER BY run_at DESC LIMIT 1");
    return rows.length ? rowTo<DoctorLog>(rows[0]) : null;
  }
  /** Delete completed chat streams older than the given age (ms). Returns count pruned. */
  pruneCompletedChatStreams(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.sql.all<Row>("SELECT id FROM chat_streams WHERE complete = 1 AND updated_at < ?", cutoff);
    const ids = rows.map((r) => String(r.id));
    for (const id of ids) this.sql.run("DELETE FROM chat_streams WHERE id = ?", id);
    return ids.length;
  }
  /** Count completed chat streams older than the given age (ms) — read-only. */
  countCompletedChatStreams(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.sql.all<Row>("SELECT COUNT(*) AS c FROM chat_streams WHERE complete = 1 AND updated_at < ?", cutoff);
    return Number(rows[0]?.c ?? 0);
  }
  /** True if a table exists and can be queried. */
  probeTableExists(table: string): boolean {
    try {
      this.sql.all<Row>(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }
  /** Seed the headline product metrics (downloads / licensed) — idempotent. */
  ensureProductMetrics(): void {
    this.sql.run(PRODUCT_METRICS_SQL);
  }

  /**
   * Export a portable JSON snapshot of every business table — the "backup"
   * that lets the OS survive 6 months of operator absence. A fresh DO with the
   * same migrations can re-import this snapshot to fully reconstruct state.
   * (Auth sessions + credential hashes are included so the Founder can sign in
   * after a restore; uploads are included so files survive too.)
   *
   * MEMORY SAFETY: rows are capped per table (default 500) so the returned
   * object and its JSON serialization stay well inside the DO isolate's heap.
   * The full, uncapped backup is persisted per-table to KV by the production
   * reset flow (see exportTableRows), never shipped through an HTTP response.
   */
  exportSnapshot(opts: { maxRowsPerTable?: number } = {}): Record<string, unknown[]> {
    const cap = Math.max(1, opts.maxRowsPerTable ?? 500);
    const out: Record<string, unknown[]> = {};
    for (const table of SNAPSHOT_TABLES) {
      try {
        out[table] = this.sql.all<Row>(`SELECT * FROM ${table} LIMIT ${cap}`).map((r) => rowTo<unknown>(r));
      } catch {
        out[table] = []; // table may not exist on an old schema
      }
    }
    return out;
  }

  /**
   * Return ALL rows of a single table (bounded by an optional safety cap).
   * Used by the backup pipeline to persist one table at a time to KV, so peak
   * heap stays proportional to the largest table rather than the whole DB.
   */
  exportTableRows(table: string, maxRows?: number): Record<string, unknown>[] {
    const cap = maxRows && maxRows > 0 ? maxRows : 50000;
    try {
      return this.sql.all<Row>(`SELECT * FROM ${table} LIMIT ${cap}`).map((r) => rowTo<Record<string, unknown>>(r));
    } catch {
      return []; // table may not exist on an old schema
    }
  }

  /**
   * Import a snapshot produced by exportSnapshot() — overwrites each table
   * (DELETE then re-INSERT) so a restore fully reconstructs state. Idempotent:
   * running it twice yields the same result.
   */
  importSnapshot(snapshot: Record<string, unknown[]>): { tables: number; rows: number } {
    let rows = 0;
    const tables = Object.keys(snapshot);
    for (const table of tables) {
      const items = snapshot[table] ?? [];
      if (items.length === 0) continue;
      try {
        this.sql.run(`DELETE FROM ${table}`);
        for (const item of items) {
          this.insert(table, item as Row);
          rows += 1;
        }
      } catch {
        /* skip tables that don't exist / aren't writable */
      }
    }
    return { tables: tables.length, rows };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every business table, in export order (used by snapshot/backup flows). */
export const SNAPSHOT_TABLES = [
  "executive_state", "founder_profile", "organizations", "objectives", "projects",
  "tasks", "decisions", "approval_requests", "risks", "metrics", "financial_snapshots",
  "products", "product_status", "engineering_issues", "marketing_campaigns", "persons",
  "delegations", "memories", "doctrine_rules", "policies", "audit_events", "chat_messages",
  "tool_executions", "workstreams", "pipeline_gates", "model_costs", "founder_credentials",
  "auth_sessions", "uploaded_files", "local_tasks", "agent_jobs", "settings",
  "calendar_events", "notes", "reminders", "contacts",
  "perceptual_evaluators", "perceptual_tests", "perceptual_results",
  "perceptual_knowledge", "product_validations", "failure_analyses",
  "departments", "org_roles", "org_agents",
  "org_memory", "post_objective_records", "org_trust", "org_messages",
  "org_capability_grants", "org_plans", "org_plan_steps", "org_plan_deviations",
  "org_negotiations", "org_negotiation_rounds", "org_arbiters",
  "reasoning_traces",
  "org_analyst_reports", "org_chaos_tests",
  "org_incidents",
  "org_topology_proposals",
];

function rowTo<T>(row: Row | undefined): T {
  return row as unknown as T;
}

/** Normalize values for SQL binding: undefined → null, booleans → 0/1. */
function normalize(value: unknown): SqlParam {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value as SqlParam;
}
