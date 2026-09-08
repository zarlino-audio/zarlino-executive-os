/**
 * Domain types for the Executive OS (spec §4). Mirrors the normalized
 * relational schema in src/db/schema.ts — every row carries provenance,
 * timestamps, and where applicable confidence/status.
 */

export type OverallStatus = "GREEN" | "YELLOW" | "RED";
export type AutonomyMode = "CONTROLLED" | "DELEGATED" | "FULL";
export type Confidence = "FACT" | "ESTIMATE" | "ASSUMPTION" | "UNKNOWN";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type TaskStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";
export type DecisionStatus = "DRAFT" | "DECIDED" | "EXECUTING" | "DONE" | "ABANDONED";
export type DecisionOutcome = "PENDING" | "SUCCESS" | "PARTIAL" | "FAILED";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskStatus = "OPEN" | "MITIGATED" | "ACCEPTED" | "CLOSED";
export type MemoryLayer = "working" | "core" | "longterm" | "project";
export type PipelineGateStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "PASSED"
  | "FAILED"
  | "BLOCKED"
  | "SHIPPED";
export type AgentRunStatus = "RUNNING" | "DONE" | "FAILED" | "STOPPED" | "TIMEOUT";
export type LocalTaskStatus = "PENDING" | "CLAIMED" | "RUNNING" | "DONE" | "FAILED";
export type CalendarEventStatus = "SCHEDULED" | "CANCELLED" | "DONE";

export interface ExecutiveStateRow {
  id: string;
  overall_status: OverallStatus | string;
  current_objective_id?: string;
  top_priorities_json: string;
  paused: number;
  pause_reason?: string;
  autonomy_mode: AutonomyMode | string;
  spending_disabled: number;
  deployments_disabled: number;
  delegate_mode: number;
  full_access: number;
  updated_at: string;
}

export interface FounderProfile {
  id: string;
  name: string;
  email?: string;
  role: string;
  authority_level: string;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  mission?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Objective {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  source: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  objective_id?: string;
  status: string;
  priority: number;
  owner_person_id?: string;
  start_date?: string;
  target_date?: string;
  success_condition?: string;
  source: string;
  metadata_json?: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  project_id?: string;
  decision_id?: string;
  assignee_person_id?: string;
  status: TaskStatus | string;
  priority: Priority | string;
  due_date?: string;
  dependency_task_id?: string;
  success_condition?: string;
  source: string;
  metadata_json?: string;
  auto_run?: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  // Task contract (AOrgI migration v23): acceptance criteria, independent
  // verification owner, autonomy level (L0-L3), deadline, escalation path.
  acceptance_criteria?: string;
  verification_role_id?: string;
  autonomy_level?: string;
  deadline_at?: string;
  escalation_path?: string;
  // Hierarchical planning (AOrgI migration v25): the plan + step this task
  // executes (§19).
  plan_id?: string;
  plan_step_id?: string;
}

export interface Decision {
  id: string;
  title: string;
  problem: string;
  objective_id?: string;
  status: DecisionStatus | string;
  category: string;
  confidence?: number;
  known_facts_json?: string;
  unknowns_json?: string;
  constraints_json?: string;
  options_json?: string;
  ceo_assessment?: string;
  cfo_assessment?: string;
  cto_assessment?: string;
  risk_assessment?: string;
  risks_json?: string;
  recommended_action?: string;
  expected_outcome?: string;
  authority_required?: string;
  approval_required: number;
  execution_plan_json?: string;
  success_metric?: string;
  review_date?: string;
  outcome_status?: DecisionOutcome | string;
  outcome_actual?: string;
  outcome_variance?: string;
  lesson?: string;
  source: string;
  model_trace_json?: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequest {
  id: string;
  decision_id?: string;
  action_label: string;
  reason: string;
  expected_upside?: string;
  max_downside?: string;
  budget_available?: string;
  recommendation: string;
  status: ApprovalStatus | string;
  requested_by: string;
  decided_by?: string;
  decision_note?: string;
  source: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
}

/**
 * Review queue item — work product (sound A/B, UI screenshot/report, artifact,
 * document) submitted for a REMOTE operator to vet, listen to, or look at and
 * approve/reject. Payload carries uploaded_files ids (audioA/audioB/image/
 * artifact) plus optional meta so the console can play/view without a local
 * machine.
 */
export interface ReviewItem {
  id: string;
  kind: string; // 'sound' | 'ui' | 'document' | 'build'
  title: string;
  description?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "NEEDS_WORK" | string;
  payload_json?: string;
  note?: string;
  source?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: string;
}

export interface Risk {
  id: string;
  title: string;
  description?: string;
  level: RiskLevel | string;
  category: string;
  likelihood?: string;
  impact?: string;
  mitigation?: string;
  status: RiskStatus | string;
  owner_person_id?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Metric {
  id: string;
  name: string;
  value?: number;
  unit?: string;
  period?: string;
  source: string;
  confidence: string;
  recorded_at: string;
  created_at: string;
}

export interface FinancialSnapshot {
  id: string;
  period: string;
  cash?: number;
  revenue?: number;
  expenses?: number;
  runway_months?: number;
  gross_margin?: number;
  confidence: Confidence | string;
  notes?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  name: string;
  category?: string;
  status: string;
  version?: string;
  description?: string;
  priority: number;
  price?: number;
  source: string;
  metadata_json?: string;
  created_at: string;
  updated_at: string;
}

export interface ProductStatusRecord {
  id: string;
  product_id: string;
  status: string;
  gate?: string;
  note?: string;
  recorded_at: string;
  source: string;
  created_at: string;
}

export interface EngineeringIssue {
  id: string;
  title: string;
  description?: string;
  product_id?: string;
  severity: string;
  status: string;
  assignee_person_id?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MarketingCampaign {
  id: string;
  name: string;
  status: string;
  channel?: string;
  budget?: number;
  spent?: number;
  objective?: string;
  metrics_json?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Person {
  id: string;
  name: string;
  role?: string;
  email?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v23): organizational department (coordination silo). */
export interface Department {
  id: string;
  name: string;
  description?: string;
  purpose?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v23): machine-readable role manifest (§9 of the AOrgI instruction). */
export interface OrgRole {
  id: string;
  name: string;
  department_id: string;
  lineage_id: string;
  prompt_lineage_id?: string;
  model?: string;
  scope?: string;
  responsibilities_json: string;
  obligations_json: string;
  capabilities_json: string;
  default_autonomy?: string;
  critic_role_id?: string;
  escalation_threshold?: string;
  version: number;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v23): agent instance registry — instances are NOT roles (§7). */
export interface OrgAgent {
  id: string;
  role_id: string;
  kind?: string;
  model?: string;
  status: string;
  host?: string;
  version?: string;
  last_seen?: string;
  capabilities_json: string;
  autonomy_json: string;
  started_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v24): versioned organizational memory entry (§14). */
export interface OrgMemory {
  id: string;
  key: string;
  value_json: string;
  version: number;
  author?: string;
  task_id?: string;
  supersedes?: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v24): PostObjectiveRecord — organizational memory after a major objective (§38). */
export interface PostObjectiveRecord {
  id: string;
  objective_id: string;
  outcome?: string;
  expected_outcome?: string;
  actual_outcome?: string;
  successful_roles_json: string;
  failed_roles_json: string;
  bottlenecks_json: string;
  incidents_json: string;
  useful_workflows_json: string;
  unnecessary_work_json: string;
  decisions_json: string;
  deviations_json: string;
  trust_updates_json: string;
  lessons_json: string;
  topology_changes_json: string;
  policy_changes_json: string;
  recorded_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v24): trust per agent × capability, never global (§21). */
export interface OrgTrust {
  id: string;
  agent_id: string;
  capability: string;
  value: number;
  evidence_count: number;
  last_updated: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v24): structured inter-agent message (§16). */
export type OrgMessageType = "STATUS" | "REQUEST" | "RESULT" | "DEVIATION" | "ESCALATION";

export interface OrgMessage {
  id: string;
  from_role: string;
  to_role: string;
  type: OrgMessageType | string;
  task_id?: string;
  payload_json: string;
  created_at: string;
}

/** AOrgI (migration v25): CapabilityGrant — role × capability with autonomy (§10, §12). */
export interface OrgCapabilityGrant {
  id: string;
  role_id: string;
  capability: string;
  allowed_actions_json: string;
  autonomy_level: string;
  requires_review: number;
  rate_limit_per_hour?: number;
  data_scope?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v25): hierarchical plan with version + owner (§19). */
export interface OrgPlan {
  id: string;
  objective_id?: string;
  title: string;
  version: number;
  owner_role: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface OrgPlanStep {
  id: string;
  plan_id: string;
  seq: number;
  title: string;
  owner_role: string;
  dependencies_json: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** PlanDeviationEvent — no silent plan changes (§19). */
export interface OrgPlanDeviation {
  id: string;
  plan_id: string;
  kind: string;
  description: string;
  resolution?: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v25): bounded negotiation with hard round cap (§22). */
export interface OrgNegotiation {
  id: string;
  topic: string;
  task_id?: string;
  status: string;
  round: number;
  max_rounds: number;
  arbiter_role?: string;
  verdict?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface OrgNegotiationRound {
  id: string;
  negotiation_id: string;
  round: number;
  kind: string;
  role: string;
  content: string;
  created_at: string;
}

/** AOrgI (migration v25): explicit arbiter per disagreement class (§23). */
export interface OrgArbiter {
  id: string;
  disagreement_class: string;
  arbiter_role_id?: string;
  fallback_role_id?: string;
  arbiter_kind: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * AOrgI (migration v26): structured reasoning record (§13) — inspectable
 * decision evidence + rationale, never private chain-of-thought.
 */
export interface ReasoningTrace {
  id: string;
  agent_id: string;
  task_id?: string;
  mode: string;
  evidence_json: string;
  hypothesis?: string;
  confidence?: number;
  final_action?: string;
  trace_visibility: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v27): organizational analyst self-observation report (§36). */
export interface OrgAnalystReport {
  id: string;
  generated_at: string;
  trigger: string;
  metrics_json: string;
  observations_json: string;
  recommendations_json: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v27): robustness drill record (§35). */
export interface OrgChaosTest {
  id: string;
  kind: string;
  target: string;
  status: string;
  result_json: string;
  started_at: string;
  finished_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v28): incident record for the blackboard + response loop (§15, §31). */
export interface OrgIncident {
  id: string;
  title: string;
  severity: string;
  status: string;
  description?: string;
  resolution?: string;
  detected_at: string;
  contained_at?: string;
  resolved_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** AOrgI (migration v29): evidence-backed topology proposal (§33). */
export interface OrgTopologyProposal {
  id: string;
  kind: string;
  role_id?: string;
  rationale: string;
  evidence_json: string;
  status: string;
  decided_by?: string;
  decided_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Delegation {
  id: string;
  delegate_person_id?: string;
  role?: string;
  scope?: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ToolExecution {
  id: string;
  tool_name: string;
  input_json: string;
  output_json?: string;
  permission: string;
  verdict: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  cost_estimate?: number;
  reversible: number;
  run_id?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
  source: string;
  created_at: string;
}

export interface AgentRun {
  id: string;
  task_id?: string;
  prompt: string;
  status: AgentRunStatus | string;
  iterations: number;
  tools_called: number;
  started_at: string;
  finished_at?: string;
  result?: string;
  error?: string;
  source: string;
  created_at: string;
  updated_at: string;
  checkpoint_json?: string;
  last_heartbeat?: string;
}

export interface Memory {
  id: string;
  layer: MemoryLayer | string;
  kind: string;
  title: string;
  body: string;
  tags_json?: string;
  entity_id?: string;
  importance: number;
  confidence?: number;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

export interface DoctrineRule {
  id: string;
  code: string;
  principle: string;
  rationale?: string;
  category: string;
  status: string;
  version: number;
  proposed_by?: string;
  approved_by?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Policy {
  id: string;
  code: string;
  title: string;
  body: string;
  category: string;
  status: string;
  version: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  detail_json?: string;
  verdict?: string;
  ip?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  model?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ChatStream {
  id: string;
  session_id: string;
  chunks_json: string;
  complete: number;
  error?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Workstream {
  id: string;
  name: string;
  description?: string;
  kind: string;
  status: string;
  config_json?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface PipelineGate {
  id: string;
  workstream_id: string;
  plugin_id: string;
  gate_number: number;
  gate_name: string;
  status: PipelineGateStatus | string;
  owner_role?: string;
  fail_count: number;
  note?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface LocalTask {
  id: string;
  task_id?: string;
  prompt: string;
  status: LocalTaskStatus | string;
  claimed_by?: string;
  started_at?: string;
  finished_at?: string;
  result?: string;
  error?: string;
  source: string;
  created_at: string;
  updated_at: string;
  lease_expires_at?: string;
  meta_json?: string;
}

export interface UploadedFile {
  id: string;
  name: string;
  mime?: string;
  size_bytes?: number;
  data_base64?: string;
  kind: "image" | "text" | "audio" | "other";
  source: string;
  created_at: string;
  updated_at: string;
}

// -- migration v14 planner tables -------------------------------------------

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start_at: string;
  end_at?: string;
  all_day: number;
  location?: string;
  attendees_json: string;
  status: CalendarEventStatus | string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  title: string;
  body?: string;
  tags_json: string;
  pinned: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: string;
  title: string;
  due_at: string;
  done: number;
  done_at?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  name: string;
  role?: string;
  company?: string;
  email?: string;
  phone?: string;
  tags_json: string;
  notes?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

// -- System Doctor (migration v17) ------------------------------------------

export type DoctorSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DoctorStatus = "OK" | "WARN" | "FAIL";

export interface DoctorCheckResult {
  id: string;
  label: string;
  severity: DoctorSeverity;
  status: DoctorStatus;
  detail: string;
  fixed?: string;
  action?: string;
}

export interface DoctorRunSummary {
  total: number;
  ok: number;
  warn: number;
  fail: number;
  fixed: number;
}

export interface DoctorReport {
  generatedAt: string;
  trigger: string;
  autoFix: boolean;
  checks: DoctorCheckResult[];
  summary: DoctorRunSummary;
  healthy: boolean;
}

export interface DoctorLog {
  id: string;
  run_at: string;
  trigger: string;
  auto_fix: number;
  summary_json: string;
  checks_json: string;
  source: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Productivity Manager (migration v18) — token budgets, assignments, roles &
// skills, optimization events, contradiction resolution, daily metrics.
// ---------------------------------------------------------------------------

export type AssignmentStatus =
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "STALLED"
  | "DONE"
  | "FAILED"
  | "REASSIGNED"
  | "CANCELLED";

export interface ProductivityAssignment {
  id: string;
  task_id: string;
  role_id?: string;
  assignee?: string;
  status: AssignmentStatus | string;
  priority?: string;
  skill_matched: number;
  model_tier?: string;
  token_budget?: number;
  tokens_used: number;
  cost_estimate: number;
  cost_actual: number;
  started_at?: string;
  completed_at?: string;
  note?: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface RoleSkill {
  id: string;
  role_id: string;
  skill: string;
  proficiency: number;
  source: string;
  updated_at: string;
}

export interface TaskSkill {
  id: string;
  task_id: string;
  skill: string;
  weight: number;
  updated_at: string;
}

export interface TokenBudget {
  id: string;
  scope: string;
  scope_id?: string;
  daily_budget?: number;
  monthly_budget?: number;
  tokens_used_today: number;
  tokens_used_month: number;
  cost_used_today: number;
  cost_used_month: number;
  model_tier?: string;
  updated_at: string;
}

export type OptimizationKind =
  | "budget_reallocated"
  | "budget_release"
  | "model_tier_suggested"
  | "batch_suggested"
  | "skill_gap"
  | "stale_assignment_fixed"
  | "reassign_suggested"
  | "budget_recalibrated";

export interface OptimizationEvent {
  id: string;
  kind: OptimizationKind | string;
  scope: string;
  scope_id?: string;
  reason: string;
  impact_json?: string;
  applied: number;
  created_at: string;
  updated_at: string;
}

export type ContradictionStatus = "OPEN" | "RESOLVED" | "DISMISSED";

export interface Contradiction {
  id: string;
  kind: string;
  subject_a?: string;
  subject_b?: string;
  claim_a?: string;
  claim_b?: string;
  status: ContradictionStatus | string;
  resolution?: string;
  resolved_by?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ProductivityMetric {
  id: string;
  day: string;
  tasks_done: number;
  tokens_used: number;
  cost: number;
  tasks_per_dollar: number;
  avg_tokens_per_task: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Perceptual Intelligence (spec: zarlino-artificial-organization, migration v22)
// ---------------------------------------------------------------------------

/** Organizational actor type — internal agents, external human evaluators,
 *  and customers are DIFFERENT actors and must stay distinct (spec §5). */
export type PerceptualActorType = "external_human" | "internal_agent" | "customer";

/** A panel member of the human sensor network. Not an employee (spec §4-5). */
export interface PerceptualEvaluator {
  id: string;
  name: string;
  actor_type: PerceptualActorType | string;
  expertise: string; // e.g. "mixing_engineer, vocal_producer"
  genres_json: string; // JSON array
  experience_level: string;
  reliability_score: number; // 0..1, accumulated per domain (spec §11)
  calibration_score: number;
  reliability_by_domain_json: string; // { "vocal_processing": 0.93, ... } — never one universal score
  availability: string; // active | inactive | invite_sent
  compensation_profile: string; // never tied to favorable results (spec §30)
  conflicts_json: string; // disclosed conflicts of interest (spec §31)
  test_count: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export type PerceptualTestType =
  | "blind_preference" | "abx_identification" | "problem_solution" | "workflow" | "preference_reach";
export type PerceptualTestTier = "exploratory" | "validation" | "high_confidence" | "commercial";
export type PerceptualTestStatus =
  | "draft" | "designed" | "recruiting" | "in_progress" | "completed" | "analyzed" | "closed";

/** A controlled listening test in the registry (spec §6). Every significant
 *  perceptual decision must reference one of these records. */
export interface PerceptualTest {
  id: string;
  product_id: string;
  title: string;
  hypothesis: string;
  objective: string;
  test_type: PerceptualTestType | string;
  protocol: string;
  stimuli_json: string; // JSON array of stimulus descriptors / file ids
  conditions_json: string; // JSON array
  evaluator_requirements: string;
  sample_size_target: number;
  blinding: string; // blind | double_blind | unblinded (spec §10)
  randomization: string;
  metrics_json: string; // JSON array of metric names
  acceptance_threshold: string;
  tier: PerceptualTestTier | string; // sample-size class (spec §13)
  status: PerceptualTestStatus | string;
  source: string;
  created_at: string;
  updated_at: string;
}

/** One evaluator's response to one test. IMMUTABLE once recorded — engineering
 *  must not be able to rewrite human evidence (spec §9). */
export interface PerceptualResult {
  id: string;
  test_id: string;
  evaluator_id: string;
  responses_json: string; // structured answers
  completion_ms?: number;
  attention_checks_passed: number;
  attention_checks_total: number;
  self_confidence?: number; // 0..1
  status: "accepted" | "rejected" | string; // rejected = failed attention checks
  source: string;
  created_at: string;
}

/** Structured perceptual knowledge — organizational memory of DSP → perceptual
 *  consequence → musical context → producer preference (spec §27-29, §40). */
export interface PerceptualKnowledge {
  id: string;
  product_category: string;
  musical_context: string;
  desired_outcome: string;
  observation_json: string; // JSON array of validated observations
  confidence: number; // 0..1
  sample_size: number;
  test_protocol: string;
  source_test_id?: string;
  evidence_tier: string; // engineering | measurement | perceptual | workflow | market
  source: string;
  created_at: string;
  updated_at: string;
}

export type GateVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** The six-layer product validation gate (spec §14, §3). Technical completion
 *  is NOT product validation. */
export interface ProductValidation {
  product_id: string;
  stage: string; // prototype | validation | beta | ship
  engineering: GateVerdict | string;
  measurement: GateVerdict | string;
  perceptual: GateVerdict | string;
  workflow: GateVerdict | string;
  commercial: GateVerdict | string;
  governance: GateVerdict | string;
  /** Founder-recorded decision (authoritative override), e.g. SHIP/KILL. */
  decision: string;
  decision_by?: string;
  decision_note?: string;
  iteration: number; // bounded validation cycles (spec §18)
  notes_json: string;
  created_at: string;
  updated_at: string;
}

export type FailureClass =
  | "discovery" | "hypothesis" | "dsp" | "perceptual" | "workflow"
  | "positioning" | "market" | "execution";

/** Failure taxonomy record (spec §39) — feeds organizational memory. */
export interface FailureAnalysis {
  id: string;
  product_id: string;
  failure_class: FailureClass | string;
  title: string;
  description: string;
  evidence_json: string;
  lesson_json: string;
  created_at: string;
  updated_at: string;
}

