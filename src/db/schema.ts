/**
 * Database schema (spec §4, §31).
 *
 * Normalized relational structures with JSON only for flexible metadata.
 * Every important record carries provenance (source), timestamps, and where
 * applicable confidence and status.
 *
 * This DDL is used verbatim by:
 *   - migrations/0001_initial.sql (checked in, deployable),
 *   - the Executive Agent's onStart migration runner,
 *   - tests (node:sqlite).
 */

export const SCHEMA_VERSION = 32;

/**
 * System Doctor (migration v17): persistent log of every Doctor run — what
 * was checked, what was found, and what was auto-fixed. The Doctor runs on DO
 * wake, on a 6-hourly cron, and on demand (`/api/doctor/run`, `system.doctor`),
 * and each run records a row here so the Founder can audit self-healing.
 */
export const DOCTOR_LOG_SQL = `
CREATE TABLE IF NOT EXISTS doctor_logs (
  id TEXT PRIMARY KEY,
  run_at TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  auto_fix INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doctor_logs_run ON doctor_logs(run_at);
`;

/**
 * Productivity Manager (migration v18): the Executive's "do more with less"
 * layer. Tracks token budgets per scope, task→role/skill assignments with
 * cost efficiency, optimization events (every applied/recommended change),
 * and contradiction/misconception records with resolutions.
 *
 * Tables:
 *  - productivity_assignments: who is doing which task, with token/cost actuals
 *  - role_skills: skill inventory per role (proficiency 1-5)
 *  - task_skills: skills a task needs (weighted) for smart assignment
 *  - token_budgets: per-scope token/cost budgets + usage (global/role/task)
 *  - optimization_events: audit of every optimization applied/recommended
 *  - contradictions: detected contradictions/misconceptions + resolutions
 *  - productivity_metrics: daily rollups (tasks done, tokens, cost, efficiency)
 */
export const PRODUCTIVITY_SQL = `
CREATE TABLE IF NOT EXISTS productivity_assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role_id TEXT,
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'ASSIGNED',
  priority TEXT,
  skill_matched INTEGER NOT NULL DEFAULT 0,
  model_tier TEXT,
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL NOT NULL DEFAULT 0,
  cost_actual REAL NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_task ON productivity_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_pa_status ON productivity_assignments(status);

CREATE TABLE IF NOT EXISTS role_skills (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  proficiency INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'seed',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rs_role ON role_skills(role_id);
CREATE INDEX IF NOT EXISTS idx_rs_skill ON role_skills(skill);

CREATE TABLE IF NOT EXISTS task_skills (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts_task ON task_skills(task_id);

CREATE TABLE IF NOT EXISTS token_budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  daily_budget INTEGER,
  monthly_budget INTEGER,
  tokens_used_today INTEGER NOT NULL DEFAULT 0,
  tokens_used_month INTEGER NOT NULL DEFAULT 0,
  cost_used_today REAL NOT NULL DEFAULT 0,
  cost_used_month REAL NOT NULL DEFAULT 0,
  model_tier TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_scope ON token_budgets(scope, scope_id);

CREATE TABLE IF NOT EXISTS optimization_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  reason TEXT,
  impact_json TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oe_kind ON optimization_events(kind);

CREATE TABLE IF NOT EXISTS contradictions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_a TEXT,
  subject_b TEXT,
  claim_a TEXT,
  claim_b TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cont_status ON contradictions(status);

CREATE TABLE IF NOT EXISTS productivity_metrics (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  tasks_done INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tasks_per_dollar REAL NOT NULL DEFAULT 0,
  avg_tokens_per_task REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_day ON productivity_metrics(day);

-- Seed the role skill inventory from the seeded technical roles (v4).
-- INSERT OR IGNORE keeps Founder edits intact across redeploys.
INSERT OR IGNORE INTO role_skills (id, role_id, skill, proficiency, source, updated_at) VALUES
 ('sk_pm_market', 'person_role_product_manager', 'market_analysis', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_pm_spec', 'person_role_product_manager', 'spec_authoring', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_pm_research', 'person_role_product_manager', 'competitive_research', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_arch_dsp', 'person_role_architect', 'dsp_design', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_arch_chain', 'person_role_architect', 'signal_chain', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_arch_alg', 'person_role_architect', 'algorithm_selection', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_dsp_cpp', 'person_role_dsp_engineer', 'cpp', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_dsp_juce', 'person_role_dsp_engineer', 'juce', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_dsp_impl', 'person_role_dsp_engineer', 'dsp_implementation', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_ui_cpp', 'person_role_ui_engineer', 'cpp', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_ui_laf', 'person_role_ui_engineer', 'look_and_feel', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_ui_gfx', 'person_role_ui_engineer', 'graphics', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_param_apvts', 'person_role_parameter_engineer', 'apvts', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_param_presets', 'person_role_parameter_engineer', 'presets', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_param_state', 'person_role_parameter_engineer', 'state_management', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_review_code', 'person_role_code_reviewer', 'code_review', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_review_thread', 'person_role_code_reviewer', 'thread_safety', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_review_mem', 'person_role_code_reviewer', 'memory_safety', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_qa_test', 'person_role_qa_engineer', 'testing', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_qa_fuzz', 'person_role_qa_engineer', 'fuzzing', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_qa_golden', 'person_role_qa_engineer', 'golden_references', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_perf_profile', 'person_role_performance_engineer', 'profiling', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_perf_cpu', 'person_role_performance_engineer', 'cpu_optimization', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_perf_latency', 'person_role_performance_engineer', 'latency', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_sec_lic', 'person_role_security_licensing_engineer', 'licensing', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_sec_sign', 'person_role_security_licensing_engineer', 'signing', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_sec_sec', 'person_role_security_licensing_engineer', 'security', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_doc_doc', 'person_role_documentation_writer', 'documentation', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_doc_manual', 'person_role_documentation_writer', 'manuals', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_rel_cmake', 'person_role_release_engineer', 'cmake', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_rel_ci', 'person_role_release_engineer', 'ci', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_rel_pack', 'person_role_release_engineer', 'packaging', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_res_web', 'person_role_research_engineer', 'web_research', 5, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('sk_res_comp', 'person_role_research_engineer', 'competitive_analysis', 4, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Baseline global token budget: derived from the AI budgets in wrangler vars
-- (seeded conservatively; the Productivity Manager recalibrates it daily).
INSERT OR IGNORE INTO token_budgets (id, scope, scope_id, daily_budget, monthly_budget, updated_at)
VALUES ('tb_global', 'global', NULL, 30000000, 900000000, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * Auto-run (migration v15): marks whether a task may be executed AUTONOMOUSLY
 * (no Founder "Run" click). Default 1 = eligible; 0 = needs a human/manual.
 * The Executive sweeps eligible OPEN tasks on wake / task-creation and starts
 * a bounded long-horizon run for each, auto-marking DONE when it completes.
 * Skipped when the task's decision has a pending approval (needs Founder).
 */
export const AUTO_RUN_SQL = `
ALTER TABLE tasks ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_tasks_auto_run ON tasks(auto_run, status);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_task ON agent_jobs(task_id);
-- Tasks that exist ONLY for a Founder decision never auto-run (a human must
-- pick: release, A/B listening verdict, approval). Everything else is free.
UPDATE tasks SET auto_run = 0
 WHERE id IN ('tsk_zscorch_gate10', 'tsk_ztame_p8')
    OR title LIKE '%founder%decision%'
    OR title LIKE '%A/B listening%';
`;

/**
 * Product metrics (migration v16): adds the missing updated_at column to the
 * metrics table and seeds the two headline product counters the Founder
 * tracks — Downloads and Licensed seats. INSERT OR IGNORE by deterministic id
 * so Founder/Executive updates are never overwritten on redeploy.
 */
export const PRODUCT_METRICS_SQL = `
ALTER TABLE metrics ADD COLUMN updated_at TEXT;
INSERT OR IGNORE INTO metrics (id, name, value, unit, period, source, confidence, recorded_at, created_at)
VALUES
 ('metric_downloads', 'downloads', 238, 'downloads', strftime('%Y-%m','now'), 'founder', 'FACT', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('metric_licensed', 'licensed', 83, 'licenses', strftime('%Y-%m','now'), 'founder', 'FACT', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * Day-to-day operating tables (migration v14): calendar, notes, reminders and
 * external contacts — the "CEO day" tools the agent needs to run the business
 * (schedule, capture decisions/notes, follow up, and track partners/vendors).
 */
export const PLANNER_SQL = `
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_status ON calendar_events(status);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_done ON reminders(done);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Settings table (migration v13): founder-editable key/value overrides that
 * persist across deploys — AI budget overrides (so the Founder can extend the
 * daily/monthly AI budget from the UI without redeploying) and the cached
 * AI-provider balance (so we don't hammer the provider's balance endpoint on
 * every overview render).
 */
export const SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * Resiliency columns (migration v12): checkpoint/heartbeat/lease fields that
 * let the system survive machine restarts and DO wakes:
 *   - agent_jobs.checkpoint_json — durable tool-loop transcript snapshot, so a
 *     long-horizon run can resume from where it stopped after a DO restart.
 *   - agent_jobs.last_heartbeat — liveness; stale RUNNING jobs get reaped.
 *   - local_tasks.lease_expires_at — claim lease; a machine that goes offline
 *     mid-task releases its lease so another daemon can re-claim.
 *   - local_tasks.meta_json — structured brief (goal/context/acceptance).
 */
export const RESILIENCY_SQL = `
ALTER TABLE agent_jobs ADD COLUMN checkpoint_json TEXT;
ALTER TABLE agent_jobs ADD COLUMN last_heartbeat TEXT;
ALTER TABLE local_tasks ADD COLUMN lease_expires_at TEXT;
ALTER TABLE local_tasks ADD COLUMN meta_json TEXT;
`;

/**
 * Uploaded files (migration v11): files the Founder uploads from the web
 * console (screenshots, specs, audio, documents) that the Executive can
 * inspect — images via vision, text via direct reading, others by metadata.
 * Data is stored base64 in `data_base64` (bounded to a few MB per file).
 */
export const UPLOADED_FILES_SQL = `
CREATE TABLE IF NOT EXISTS uploaded_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER,
  data_base64 TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_created ON uploaded_files(created_at);
`;

/**
 * Local machine tasks (migration v10): a bridge between the live Executive
 * (Cloudflare) and the local machine. The agent (or Founder via the web
 * console) queues a task; a local daemon on the machine claims it, works on
 * it with local tools (read/write repo files, run commands, inspect plugin
 * UI source), and posts the result back. Status: PENDING → CLAIMED →
 * RUNNING → DONE/FAILED.
 */
export const LOCAL_TASKS_SQL = `
CREATE TABLE IF NOT EXISTS local_tasks (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  claimed_by TEXT,
  started_at TEXT,
  finished_at TEXT,
  result TEXT,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_tasks_status ON local_tasks(status);
CREATE INDEX IF NOT EXISTS idx_local_tasks_created ON local_tasks(created_at);
`;

/**
 * Auth tables (migration v2): founder username/password credentials and
 * bearer session tokens.
 */
export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS founder_credentials (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);
`;

/**
 * Founder credentials seed (migration v19): switches the Founder to
 * username/password auth (username: Khritical, temporary password). The
 * hash below is PBKDF2-SHA256(100k) of the temporary password with a fixed
 * salt, in the same `salt:hex` format hashPassword produces. The Founder
 * MUST change this temporary password via POST /api/auth/change-password
 * (console → Settings → Change password). INSERT OR IGNORE keeps any
 * later credential change intact across redeploys.
 */
export const FOUNDER_CREDENTIALS_SEED_SQL = `
INSERT OR REPLACE INTO founder_credentials
 (id, username, password_hash, failed_attempts, locked_until, created_at, updated_at)
VALUES
 ('founder', 'Khritical',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90:426c60969956df34000c635e89e6cf312bc87cd6247ac0c35a8b73a065caca32',
  0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * Local agent health beacon (migration v20): the local daemon
 * (scripts/local-daemon.ts) pings POST /api/local-agent/heartbeat every ~30s
 * and records last_seen/host/version here, so the System Doctor can tell when
 * the on-machine agent is offline (previously a blind spot: expired-lease
 * checks only saw tasks that HAD been claimed, never PENDING tasks with no
 * daemon to claim them).
 */
export const LOCAL_AGENT_STATUS_SQL = `
CREATE TABLE IF NOT EXISTS local_agent_status (
  id TEXT PRIMARY KEY,
  host TEXT,
  version TEXT,
  pid TEXT,
  last_seen TEXT,
  last_claim_at TEXT,
  started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Review queue (migration v21): lets a REMOTE operator vet and approve
 * produced work — not just text decisions. When the agent renders a sound
 * A/B comparison, produces a UI screenshot/report, or builds an artifact, it
 * files a review item; the operator listens / looks and approves, rejects, or
 * asks for work — all from the web console, with no local machine required.
 * Payload holds fileIds (audioA/audioB/image/artifact) resolved against the
 * uploaded_files table so the console can play/view them.
 */
export const REVIEW_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  payload_json TEXT,
  note TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(status);
`;

/**
 * Pipeline-state data migration (v3): sync the Executive OS with the real
 * 10-gate pipeline state for ZScorch and ZTame, verified from
 * pipeline/ZScorch/STATUS.md and pipeline/ZTame/STATUS.md (2026-08-24).
 *
 * Updates existing seeded gates (1-9 PASSED, 10 IN_PROGRESS) and inserts the
 * open tasks, risks, and the pending Gate 10 approval using deterministic
 * IDs (INSERT OR IGNORE keeps it idempotent). Fresh databases run this after
 * the seed's gate insert loop; already-seeded databases (the deployed DO)
 * get the UPDATEs applied to their existing rows.
 */
export const PIPELINE_STATE_SQL = `
-- ZScorch: gates 1-9 passed; gate 10 in progress (ready_for_release, awaiting Founder).
UPDATE pipeline_gates SET status = 'PASSED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE plugin_id = 'ZScorch' AND gate_number BETWEEN 1 AND 9;
UPDATE pipeline_gates SET status = 'IN_PROGRESS',
       note = 'ready_for_release — awaiting Khritical approval (Gate 10)',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE plugin_id = 'ZScorch' AND gate_number = 10;

-- ZTame: gates 1-9 passed; gate 10 in progress (rework_complete, P8 open).
UPDATE pipeline_gates SET status = 'PASSED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE plugin_id = 'ZTame' AND gate_number BETWEEN 1 AND 9;
UPDATE pipeline_gates SET status = 'IN_PROGRESS',
       note = 'rework_complete — P1-P7 verified; P8 suppression-quality audit awaiting Khritical re-review',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE plugin_id = 'ZTame' AND gate_number = 10;

-- Open tasks (deterministic ids).
INSERT OR IGNORE INTO tasks
 (id, title, description, status, priority, assignee_person_id, source, created_at, updated_at) VALUES
 ('tsk_ztame_p8',
  'ZTame P8 suppression-quality A/B listening test',
  'Run the documented A/B protocol (pipeline/ZTame/STATUS.md): sustained tone + resonant ringing, piano/plucked string, drums + pad; A/B vs bypass at 100% wet, sensitivity 50→90, range -12 dB. Report which symptom matches: (a) pumping/warbling on transients → add detection-path smoothing/peak-hold; (b) Selectivity knob inaudible → widen selectivity range or re-map the threshold formula.',
  'BLOCKED', 'P0', 'founder', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('tsk_ztame_signing',
  'ZTame production license key + code signing',
  'Replace the development license public-key placeholder in ZLicenseManager.h with the production key and configure code signing before public commercial distribution.',
  'OPEN', 'P1', NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('tsk_zscorch_gate10',
  'ZScorch Gate 10 — founder release decision',
  'Approve or reject ZScorch v1.0.0 release. Gates 1-9 all passed; release build + VST3/Standalone/Installer packages verified; production license key verified 2026-08-23.',
  'OPEN', 'P1', 'founder', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('tsk_zscorch_signing',
  'ZScorch code signing',
  'Configure code signing for the release build (deferred at Gate 7/9).',
  'OPEN', 'P2', NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Open risks.
INSERT OR IGNORE INTO risks
 (id, title, description, level, category, likelihood, impact, mitigation, status, owner_person_id, source, created_at, updated_at) VALUES
 ('risk_ztame_p8',
  'ZTame suppression quality (P8) unresolved',
  'Engineering audit (2026-08-15) found no DSP math bugs, but two candidates remain: (a) no temporal smoothing/peak-hold on the detection spectrum → pumping/warbling on transients; (b) Sensitivity/Selectivity overlap (Selectivity moves threshold only ±5.25 dB vs Sensitivity 12 dB).',
  'HIGH', 'QUALITY', 'MEDIUM', 'HIGH', 'Founder A/B listening test → rework identified stage (detection smoothing or sensitivity/selectivity remap).', 'OPEN', 'founder', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('risk_ztame_signing',
  'ZTame ships unsigned with dev license key',
  'ZLicenseManager.h still embeds the development public-key placeholder; release build is unsigned.',
  'HIGH', 'SECURITY', 'HIGH', 'HIGH', 'Embed production key and sign before commercial release; or ship as explicitly-disclosed trial/unsigned build.', 'OPEN', NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('risk_zscorch_signing',
  'ZScorch release build unsigned',
  'Code signing deferred at Gate 7/9; public distribution should be signed.',
  'MEDIUM', 'SECURITY', 'MEDIUM', 'MEDIUM', 'Configure signing certificate + CI signing before public distribution.', 'OPEN', NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('risk_golden_refs',
  'Golden-reference audio files missing',
  'Gate 5 golden-reference files not yet supplied for ZScorch or ZTame (non-blocking for initial release).',
  'LOW', 'QUALITY', 'LOW', 'LOW', 'Add golden-reference captures to the QA suite post-release.', 'OPEN', NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Pending approval: ZScorch Gate 10 release.
INSERT OR IGNORE INTO approval_requests
 (id, action_label, reason, expected_upside, max_downside, budget_available, recommendation, status, requested_by, source, created_at, updated_at) VALUES
 ('appr_zscorch_gate10',
  'Approve ZScorch v1.0.0 release (Gate 10)',
  'All gates 1-9 passed; release build + VST3/Standalone/Installer packages verified; production license key verified. Awaiting founder decision to ship.',
  'First commercial product shipped; revenue per unit (target unit economics).',
  'Shipping before full DAW host matrix testing; unsigned build.',
  'No budget required', 'APPROVE', 'PENDING', 'executive', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * Technical-roles data migration (v4): onboard the orchestrator's role roster
 * into the persons table on already-seeded databases. Fresh databases get the
 * same rows from the seed; INSERT OR IGNORE keeps it idempotent either way.
 */
export const PERSON_ROLES_SQL = `
INSERT OR IGNORE INTO persons (id, name, role, source, created_at, updated_at) VALUES
 ('person_role_product_manager', 'Product Manager', 'Gate 1 — market analysis, spec authoring', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_architect', 'Architect', 'Gate 2 — signal chain design, algorithm selection', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_dsp_engineer', 'DSP Engineer', 'Gate 3 — C++/JUCE DSP implementation', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_ui_engineer', 'UI Engineer', 'Gate 3 — editor UI, Look & Feel', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_parameter_engineer', 'Parameter Engineer', 'Gate 3 — APVTS, presets, state', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_code_reviewer', 'Code Reviewer', 'Gate 4 — bug discovery, thread/memory safety', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_qa_engineer', 'QA Engineer', 'Gate 5 — tests, fuzz, golden references', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_performance_engineer', 'Performance Engineer', 'Gate 6 — CPU/memory/latency budgets', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_security_licensing_engineer', 'Security & Licensing Engineer', 'Gate 7 — license compliance, signing', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_documentation_writer', 'Documentation Writer', 'Gate 8 — manuals, parameter reference', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_release_engineer', 'Release Engineer', 'Gate 9 — CMake, CI, packaging', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('person_role_research_engineer', 'Research Engineer', 'Web research, competitive analysis', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * Delegate-mode migration (v5): adds the Founder-granted delegate flag to the
 * executive state row (0 = off, 1 = on). New column defaults to 0 so existing
 * rows stay conservative until the Founder explicitly enables it.
 */
/**
 * Ship-state reconciliation (migration v7): ZScorch and ZTame are already
 * LIVE on zarlinoaudio.com (v1.0.0), so the pipeline previously under-reported
 * them (Gate 10 stuck at IN_PROGRESS while the site shipped). This marks both
 * products SHIPPED, sets their Gate 10 to SHIPPED, and records the shipment
 * history (guarded so fresh DBs stay clean — the seed records the same).
 */
/**
 * Full-access migration (v8): adds the Founder-granted full-access flag to
 * the executive state row (0 = off, 1 = on). When ON, the Executive runs
 * virtually everything autonomously (deploy, HIGH-reversible, spend) while
 * hard gates (delete/transfer/doctrine/CRITICAL/irreversible/emergency) hold.
 */
/**
 * Long-horizon agent runs (migration v9): persistent records of the Executive
 * working on a task across many tool calls. Lets the agent embark on long,
 * multi-step work and be resumed safely (status: RUNNING/DONE/FAILED/STOPPED/
 * TIMEOUT), with iteration + tool counters and a final result.
 */
export const AGENT_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  iterations INTEGER NOT NULL DEFAULT 0,
  tools_called INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_created ON agent_jobs(created_at);
`;

export const FULL_ACCESS_SQL = `
ALTER TABLE executive_state ADD COLUMN full_access INTEGER NOT NULL DEFAULT 0;
`;

export const SHIP_STATE_SQL = `
-- product_status lacked updated_at (the Ship action records history) — add it.
ALTER TABLE product_status ADD COLUMN updated_at TEXT;
UPDATE products SET status = 'SHIPPED', version = '1.0.0', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE name IN ('ZScorch', 'ZTame');
UPDATE pipeline_gates SET status = 'SHIPPED',
       note = 'Shipped — live on zarlinoaudio.com (v1.0.0)',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE plugin_id IN ('ZScorch', 'ZTame') AND gate_number = 10;
INSERT OR IGNORE INTO product_status (id, product_id, status, gate, note, recorded_at, source, created_at)
SELECT 'ps_ship_zscorch', id, 'SHIPPED', 'Gate 10', 'Shipped — live on zarlinoaudio.com (v1.0.0)', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM products WHERE name = 'ZScorch' AND NOT EXISTS (SELECT 1 FROM product_status WHERE id = 'ps_ship_zscorch');
INSERT OR IGNORE INTO product_status (id, product_id, status, gate, note, recorded_at, source, created_at)
SELECT 'ps_ship_ztame', id, 'SHIPPED', 'Gate 10', 'Shipped — live on zarlinoaudio.com (v1.0.0)', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM products WHERE name = 'ZTame' AND NOT EXISTS (SELECT 1 FROM product_status WHERE id = 'ps_ship_ztame');
`;

export const DELEGATE_MODE_SQL = `
ALTER TABLE executive_state ADD COLUMN delegate_mode INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Chat-stream migration (v6): buffers streamed chat reply chunks so the
 * Worker can poll them over DO RPC (async generators do not survive RPC).
 * chunks_json is a JSON array of text deltas appended by the agent's
 * background stream task and read incrementally by the SSE endpoint.
 */
export const CHAT_STREAM_SQL = `
CREATE TABLE IF NOT EXISTS chat_streams (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  chunks_json TEXT NOT NULL DEFAULT '[]',
  complete INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS executive_state (
  id TEXT PRIMARY KEY,
  overall_status TEXT NOT NULL DEFAULT 'GREEN',
  current_objective_id TEXT,
  top_priorities_json TEXT NOT NULL DEFAULT '[]',
  paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  autonomy_mode TEXT NOT NULL DEFAULT 'CONTROLLED',
  spending_disabled INTEGER NOT NULL DEFAULT 0,
  deployments_disabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS founder_profile (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  role TEXT,
  authority_level TEXT NOT NULL DEFAULT 'FOUNDER',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mission TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  priority INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  objective_id TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  priority INTEGER NOT NULL DEFAULT 0,
  owner_person_id TEXT,
  start_date TEXT,
  target_date TEXT,
  success_condition TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  project_id TEXT,
  decision_id TEXT,
  assignee_person_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'P2',
  due_date TEXT,
  dependency_task_id TEXT,
  success_condition TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  objective_id TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  category TEXT NOT NULL DEFAULT 'OPERATIONAL',
  confidence REAL,
  known_facts_json TEXT,
  unknowns_json TEXT,
  constraints_json TEXT,
  options_json TEXT,
  ceo_assessment TEXT,
  cfo_assessment TEXT,
  cto_assessment TEXT,
  risk_assessment TEXT,
  risks_json TEXT,
  recommended_action TEXT,
  expected_outcome TEXT,
  authority_required TEXT,
  approval_required INTEGER NOT NULL DEFAULT 0,
  execution_plan_json TEXT,
  success_metric TEXT,
  review_date TEXT,
  outcome_status TEXT,
  outcome_actual TEXT,
  outcome_variance TEXT,
  lesson TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  model_trace_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  decision_id TEXT,
  action_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  expected_upside TEXT,
  max_downside TEXT,
  budget_available TEXT,
  recommendation TEXT NOT NULL DEFAULT 'APPROVE',
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_by TEXT NOT NULL DEFAULT 'executive',
  decided_by TEXT,
  decision_note TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  level TEXT NOT NULL DEFAULT 'MEDIUM',
  category TEXT NOT NULL DEFAULT 'OPERATIONAL',
  likelihood TEXT,
  impact TEXT,
  mitigation TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  owner_person_id TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  value REAL,
  unit TEXT,
  period TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence TEXT NOT NULL DEFAULT 'ESTIMATE',
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_snapshots (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  cash REAL,
  revenue REAL,
  expenses REAL,
  runway_months REAL,
  gross_margin REAL,
  confidence TEXT NOT NULL DEFAULT 'ESTIMATE',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  version TEXT,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  price REAL,
  source TEXT NOT NULL DEFAULT 'founder',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_status (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  gate TEXT,
  note TEXT,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engineering_issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  product_id TEXT,
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  status TEXT NOT NULL DEFAULT 'OPEN',
  assignee_person_id TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  channel TEXT,
  budget REAL,
  spent REAL,
  objective TEXT,
  metrics_json TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  delegate_person_id TEXT,
  role TEXT,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  permission TEXT NOT NULL,
  verdict TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  cost_estimate REAL,
  reversible INTEGER NOT NULL DEFAULT 1,
  run_id TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  model TEXT,
  model_version TEXT,
  prompt_version TEXT,
  tools_called_json TEXT,
  tokens_json TEXT,
  latency_ms INTEGER,
  cost REAL,
  decision_id TEXT,
  approval_id TEXT,
  error TEXT,
  outcome TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT,
  entity_id TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL,
  source TEXT NOT NULL DEFAULT 'executive',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS doctrine_rules (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  principle TEXT NOT NULL,
  rationale TEXT,
  category TEXT NOT NULL DEFAULT 'GENERAL',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  version INTEGER NOT NULL DEFAULT 1,
  proposed_by TEXT,
  approved_by TEXT,
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'GENERAL',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail_json TEXT,
  verdict TEXT,
  ip TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_costs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  session_id TEXT,
  run_id TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workstreams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'PLUGIN_PIPELINE',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  config_json TEXT,
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_gates (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  gate_number INTEGER NOT NULL,
  gate_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  owner_role TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_risks_level ON risks(level);
CREATE INDEX IF NOT EXISTS idx_costs_created ON model_costs(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_gates_plugin ON pipeline_gates(plugin_id);
`;

/**
 * Perceptual Intelligence layer (migration v22).
 *
 * Implements the "Zarlino Artificial Organization" spec
 * (specs/zarlino-artificial-organization.md): an external human ear network as
 * a first-class organizational capability. Five evidence layers (spec §3) —
 * engineering, measurement, perceptual, workflow, market — each independently
 * tracked; the product validation gate (spec §14), the kill system (spec §15),
 * the test registry (spec §6), evaluator calibration (spec §11), failure
 * taxonomy (spec §39) and the perceptual knowledge base (spec §27-29, §40).
 *
 * Integrity rules enforced in code, not just schema:
 *   - perceptual_results are append-only (spec §9: engineering must not edit
 *     human evidence);
 *   - evaluators are always one of external_human | internal_agent | customer
 *     (spec §5: these are different organizational actors);
 *   - evaluator reliability is stored per-domain, never one universal
 *     "good ear" score (spec §11).
 */
export const PERCEPTUAL_SQL = `
CREATE TABLE IF NOT EXISTS perceptual_evaluators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'external_human',
  expertise TEXT NOT NULL DEFAULT '',
  genres_json TEXT NOT NULL DEFAULT '[]',
  experience_level TEXT NOT NULL DEFAULT '',
  reliability_score REAL NOT NULL DEFAULT 0,
  calibration_score REAL NOT NULL DEFAULT 0,
  reliability_by_domain_json TEXT NOT NULL DEFAULT '{}',
  availability TEXT NOT NULL DEFAULT 'active',
  compensation_profile TEXT NOT NULL DEFAULT '',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  test_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perceptual_evaluators_type ON perceptual_evaluators(actor_type);

CREATE TABLE IF NOT EXISTS perceptual_tests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  test_type TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT '',
  stimuli_json TEXT NOT NULL DEFAULT '[]',
  conditions_json TEXT NOT NULL DEFAULT '[]',
  evaluator_requirements TEXT NOT NULL DEFAULT '',
  sample_size_target INTEGER NOT NULL DEFAULT 0,
  blinding TEXT NOT NULL DEFAULT 'blind',
  randomization TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '[]',
  acceptance_threshold TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'exploratory',
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perceptual_tests_product ON perceptual_tests(product_id);
CREATE INDEX IF NOT EXISTS idx_perceptual_tests_status ON perceptual_tests(status);

CREATE TABLE IF NOT EXISTS perceptual_results (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  responses_json TEXT NOT NULL DEFAULT '{}',
  completion_ms INTEGER,
  attention_checks_passed INTEGER NOT NULL DEFAULT 0,
  attention_checks_total INTEGER NOT NULL DEFAULT 0,
  self_confidence REAL,
  status TEXT NOT NULL DEFAULT 'accepted',
  source TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perceptual_results_test ON perceptual_results(test_id);

CREATE TABLE IF NOT EXISTS perceptual_knowledge (
  id TEXT PRIMARY KEY,
  product_category TEXT NOT NULL,
  musical_context TEXT NOT NULL DEFAULT '',
  desired_outcome TEXT NOT NULL DEFAULT '',
  observation_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  sample_size INTEGER NOT NULL DEFAULT 0,
  test_protocol TEXT NOT NULL DEFAULT '',
  source_test_id TEXT,
  evidence_tier TEXT NOT NULL DEFAULT 'perceptual',
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perceptual_knowledge_cat ON perceptual_knowledge(product_category);

CREATE TABLE IF NOT EXISTS product_validations (
  product_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'prototype',
  engineering TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
  measurement TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
  perceptual TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
  workflow TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
  commercial TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
  governance TEXT NOT NULL DEFAULT 'PASS',
  decision TEXT NOT NULL DEFAULT 'NONE',
  decision_by TEXT,
  decision_note TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  notes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failure_analyses (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  lesson_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failure_analyses_product ON failure_analyses(product_id);

-- Honest baseline for the two shipped products: engineering/measurement and
-- governance are satisfied, but perceptual evidence is NOT yet collected
-- (ZTame P8 A/B listening test is still open). INCONCLUSIVE is recorded as-is
-- rather than pretended PASS — evidence conflicts must stay visible (spec §24).
INSERT OR IGNORE INTO product_validations
 (product_id, stage, engineering, measurement, perceptual, workflow, commercial,
  governance, decision, decision_by, decision_note, iteration, notes_json, created_at, updated_at)
VALUES
 ('prod_zscorch', 'ship', 'PASS', 'PASS', 'INCONCLUSIVE', 'INCONCLUSIVE', 'PASS', 'PASS',
  'SHIP', 'founder', 'Shipped 1.0.0 on founder authority; blind perceptual validation outstanding.',
  1, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('prod_ztame', 'ship', 'PASS', 'PASS', 'INCONCLUSIVE', 'INCONCLUSIVE', 'PASS', 'PASS',
  'SHIP', 'founder', 'Shipped 1.0.0; P8 suppression-quality A/B listening test still BLOCKED.',
  1, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * AOrgI organizational manifests (migration v23) — the artificial organization
 * registry behind the Executive OS (AOrgI master instruction §5, §9, §24).
 *
 * Three layers, matching the instruction's ROLE ≠ INSTANCE ≠ HUMAN rule:
 *  - departments: coordination silos (EXECUTIVE/PRODUCT/ENGINEERING/
 *    VERIFICATION/COMMERCIAL/CONTROL). QA sits in its own VERIFICATION
 *    department (not under ENGINEERING) per §24 — independence required.
 *  - org_roles: machine-readable role MANIFESTS (§9) — id, department,
 *    lineage_id, model, scope, responsibilities, obligations, capabilities,
 *    default autonomy (L0-L3), critic_role_id for independent verification.
 *  - org_agents: agent INSTANCE registry — real runtimes register themselves
 *    with heartbeats; no instance row exists until a runtime actually runs
 *    (§42: no theater). The cloud DO registers executive_do_01 on wake;
 *    the local daemon's existing /api/local-agent/heartbeat upserts
 *    local_daemon_01.
 *
 * Also adds the task-contract columns to `tasks` (§18): acceptance criteria,
 * independent verification owner, autonomy level, deadline, escalation path —
 * and writes the first real contract (tsk_ztame_p8, the blocking ZTame A/B
 * listening test) through the new mechanism.
 */
export const ORG_MANIFESTS_SQL = `
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  responsibilities_json TEXT NOT NULL DEFAULT '[]',
  obligations_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  default_autonomy TEXT NOT NULL DEFAULT 'L1',
  critic_role_id TEXT,
  escalation_threshold TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_roles_dept ON org_roles(department_id);

CREATE TABLE IF NOT EXISTS org_agents (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cloud',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'REGISTERED',
  host TEXT,
  version TEXT,
  last_seen TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  autonomy_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_agents_role ON org_agents(role_id);
CREATE INDEX IF NOT EXISTS idx_org_agents_seen ON org_agents(last_seen);

-- Task contract (AOrgI §18): every substantial task gets acceptance criteria,
-- an independent verification owner, an autonomy level, a deadline and an
-- escalation path instead of living as informal conversation.
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;
ALTER TABLE tasks ADD COLUMN verification_role_id TEXT;
ALTER TABLE tasks ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'L2';
ALTER TABLE tasks ADD COLUMN deadline_at TEXT;
ALTER TABLE tasks ADD COLUMN escalation_path TEXT;

-- Departments (5 initial per §24 + VERIFICATION as the independent QA silo).
INSERT OR IGNORE INTO departments (id, name, description, purpose, source, created_at, updated_at) VALUES
 ('dept_executive', 'Executive', 'Objective decomposition, planning, coordination, strategy, CEO reporting.', 'Convert CEO objectives into coordinated organizational action.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dept_product', 'Product', 'Product architecture, planning, and user experience.', 'Turn objectives into product plans and specifications.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dept_engineering', 'Engineering', 'DSP, application code, and build/release tooling.', 'Implement product specifications as shipped software.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dept_verification', 'Verification', 'Independent QA and adversarial testing.', 'Verify engineering work independently of engineering incentives.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dept_commercial', 'Commercial', 'Growth, sales, partnerships, and customer intelligence.', 'Convert shipped products into revenue and retention.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dept_control', 'Control', 'Finance, governance, audit, and policy enforcement.', 'Constrain organizational action to authorized and audited bounds.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 12 role manifests (AOrgI §6). Responsibilities/obligations are JSON arrays;
-- capabilities are descriptive for Phase 1 (enforcement lands with Phase 3
-- CapabilityGrants over the authority engine). critic_role_id encodes the
-- independent-verification relationship where it is materially valuable.
INSERT OR IGNORE INTO org_roles
 (id, name, department_id, lineage_id, model, scope, responsibilities_json, obligations_json,
  capabilities_json, default_autonomy, critic_role_id, escalation_threshold, version, status,
  source, created_at, updated_at) VALUES
 ('role_coa', 'Chief Operating Agent', 'dept_executive', 'lineage_coa', 'deepseek-v4',
  'Organizational orchestration: decompose objectives, plan, assign, monitor, escalate, report to the human CEO.',
  '["Receive organizational objectives","Decompose objectives into plans and tasks","Assign work to role instances","Monitor execution and detect bottlenecks","Manage escalation","Synthesize organizational state","Report compressed executive state to the CEO"]',
  '["Emit ESCALATION when a hard constraint is violated","Report status after every major objective phase"]',
  '["planning","task_assignment","bottleneck_detection","executive_reporting"]',
  'L2', 'role_finance_governance', 'Hard-constraint violation or 3 failed arbitration rounds', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_strategy_intelligence', 'Strategy & Intelligence Agent', 'dept_executive', 'lineage_strategy', 'deepseek-v4',
  'Market research, competitive intelligence, opportunity discovery, strategic risk detection.',
  '["Market research","Competitive intelligence","Opportunity discovery","Strategic analysis","External information gathering","Strategic risk detection"]',
  '["Emit RESULT after every research request","Flag strategic risks explicitly"]',
  '["web_research","competitive_analysis","opportunity_evaluation"]',
  'L2', NULL, 'Materially new strategic risk', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_product_architect', 'Product Architect', 'dept_product', 'lineage_product_architect', 'deepseek-v4',
  'Product architecture, specifications, trade-offs, differentiation, acceptance criteria. Challenges weak concepts.',
  '["Product architecture","Product specifications","Technical/product trade-offs","Product differentiation","Acceptance criteria"]',
  '["Challenge weak product concepts","Emit RESULT for every product decision reviewed"]',
  '["product_specification","tradeoff_analysis","differentiation_analysis"]',
  'L2', 'role_product_manager', 'Product concept with no measurable differentiator', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_product_manager', 'Product Manager', 'dept_product', 'lineage_product_manager', 'deepseek-v4',
  'Convert objectives into executable product plans; prioritize, manage scope, prevent scope explosion.',
  '["Convert objectives into executable product plans","Prioritize work","Manage scope","Coordinate product work","Maintain product plans","Prevent scope explosion"]',
  '["Emit DEVIATION when scope changes materially","Maintain plan versions"]',
  '["roadmapping","prioritization","scope_control","plan_maintenance"]',
  'L2', 'role_strategy_intelligence', 'Scope expansion beyond agreed acceptance criteria', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_design_ux', 'Design / UX Agent', 'dept_product', 'lineage_design_ux', 'deepseek-v4',
  'UI/UX, product interaction, visual system, user workflow, design specifications.',
  '["UI/UX design","Product interaction","Visual system","User workflow","Design specifications"]',
  '["Emit RESULT for every design review","Validate workflows against real user tasks"]',
  '["ui_design","ux_review","workflow_design","visual_system"]',
  'L2', 'role_qa_verification', 'Design change that breaks a shipped workflow', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_dsp_engineering', 'DSP / Core Engineering Agent', 'dept_engineering', 'lineage_dsp_engineering', 'deepseek-v4',
  'DSP algorithms, signal processing, sonic architecture, core plugin technology, performance.',
  '["DSP implementation","Audio algorithms","Signal processing","Sonic architecture","Performance engineering"]',
  '["Emit RESULT after every implementation pass","Emit ESCALATION for real-time-safety violations"]',
  '["dsp_design","cpp_implementation","rt_safety_audit","performance_profiling"]',
  'L2', 'role_qa_verification', 'Denormals/NaN in the audio path or a failed null test', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_software_engineering', 'Software Engineering Agent', 'dept_engineering', 'lineage_software_engineering', 'deepseek-v4',
  'Application code, plugin infrastructure, backend, integrations, APIs, automation, tooling.',
  '["Application code","Plugin infrastructure","Backend","Integrations","APIs","Automation","Tooling"]',
  '["Emit RESULT after every implementation pass","Emit ESCALATION for production-facing changes needing approval"]',
  '["backend","api_design","automation","tooling","integration"]',
  'L2', 'role_qa_verification', 'Production-affecting change without approval path', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_qa_verification', 'QA / Verification Agent', 'dept_verification', 'lineage_qa_verification', 'deepseek-v4',
  'Automated tests, regression, functional verification, build verification, release gating. Independent of engineering.',
  '["Automated tests","Regression testing","Functional verification","Acceptance-criteria verification","Build verification","Release gating"]',
  '["Emit RESULT after every review","Emit ESCALATION for blocking defects","Never let engineering self-approve gated work"]',
  '["test_design","regression","build_verification","release_gating","adversarial_review"]',
  'L2', NULL, 'Blocking defect at release gate', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_growth_intelligence', 'Growth Intelligence Agent', 'dept_commercial', 'lineage_growth_intelligence', 'deepseek-v4',
  'Market positioning, SEO, content, advertising, acquisition, campaign analysis, conversion optimization.',
  '["Market positioning","SEO","Content","Advertising","Acquisition","Campaign analysis","Conversion optimization"]',
  '["Emit RESULT with measured campaign data","Emit DEVIATION when spend exceeds approved budget"]',
  '["seo","content","campaign_analysis","conversion_optimization"]',
  'L1', NULL, 'Campaign spend approaching approved budget', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_sales_partnerships', 'Sales / Partnerships Agent', 'dept_commercial', 'lineage_sales_partnerships', 'deepseek-v4',
  'Affiliates, partnerships, distribution, commercial opportunities, outreach, sales operations.',
  '["Affiliates","Partnerships","Distribution","Commercial opportunities","Outreach","Sales operations"]',
  '["Emit RESULT for every outreach batch","Emit ESCALATION before any binding external commitment"]',
  '["affiliate_management","partnership_outreach","distribution"]',
  'L1', NULL, 'Binding external commitment without founder approval', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_customer_intelligence', 'Customer Intelligence Agent', 'dept_commercial', 'lineage_customer_intelligence', 'deepseek-v4',
  'Customer feedback, support intelligence, user behavior, reviews, retention, complaints, product feedback loops.',
  '["Customer feedback","Support intelligence","User behavior","Reviews","Retention","Complaints","Product feedback loops"]',
  '["Emit RESULT for every feedback synthesis","Emit ESCALATION for recurring complaints affecting retention"]',
  '["feedback_analysis","support_intelligence","retention_analysis"]',
  'L2', NULL, 'Recurring complaint class affecting retention', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

 ('role_finance_governance', 'Finance / Governance Agent', 'dept_control', 'lineage_finance_governance', 'deepseek-v4',
  'Budget monitoring, financial analysis, governance, authorization, audit, licensing/compliance, risk, policy enforcement. Not subordinate to engineering or commercial incentives.',
  '["Budget monitoring","Financial analysis","Governance","Authorization","Audit","Licensing/compliance operations","Risk","Policy enforcement"]',
  '["BLOCK + LOG + ESCALATE on hard-constraint violations (never WARN + CONTINUE)","Emit RESULT for every audit"]',
  '["budget_monitoring","audit","policy_enforcement","risk_assessment","compliance"]',
  'L1', NULL, 'Any hard-constraint violation', 1, 'ACTIVE',
  'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- First real task contract through the registry (AOrgI §18, §45 STEP 14): the
-- blocking ZTame P8 A/B listening test gets acceptance criteria, an independent
-- QA verification owner, and a founder escalation path.
UPDATE tasks SET
  acceptance_criteria = 'A/B listening protocol from pipeline/ZTame/STATUS.md executed (sustained tone + resonant ringing, piano/plucked string, drums + pad; 100% wet, sensitivity 50 to 90, range -12 dB). Outcome is one documented symptom: (a) pumping/warbling on transients or (b) Selectivity inaudible — with the corresponding rework stage identified.',
  verification_role_id = 'role_qa_verification',
  autonomy_level = 'L2',
  escalation_path = 'founder (Khritical) via review_items',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = 'tsk_ztame_p8';
`;

/**
 * AOrgI Phase 2 (migration v24) — organizational memory, post-objective
 * records, trust evidence, and the inter-agent message protocol.
 *
 *  - org_memory: versioned organizational knowledge (§14). Writes carry
 *    author/timestamp/task_id; updates require the read version and CONFLICT
 *    instead of silently overwriting; supersedes links version history.
 *  - post_objective_records: episodic PostObjectiveRecord after every major
 *    objective (§38) — what worked, what failed, bottlenecks, lessons,
 *    recommended topology/policy changes.
 *  - org_trust: trust per agent × capability (§21), evidence-counted, decays
 *    over time (math lives in src/core/org/trust.ts).
 *  - org_messages: structured inter-agent messages (§16) — STATUS / REQUEST /
 *    RESULT / DEVIATION / ESCALATION, tied to task_id, never free-form chat.
 */
export const ORG_PHASE2_SQL = `
CREATE TABLE IF NOT EXISTS org_memory (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  author TEXT NOT NULL DEFAULT 'executive',
  task_id TEXT,
  supersedes TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_memory_key ON org_memory(key);
CREATE INDEX IF NOT EXISTS idx_org_memory_status ON org_memory(status);

CREATE TABLE IF NOT EXISTS post_objective_records (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  expected_outcome TEXT NOT NULL DEFAULT '',
  actual_outcome TEXT NOT NULL DEFAULT '',
  successful_roles_json TEXT NOT NULL DEFAULT '[]',
  failed_roles_json TEXT NOT NULL DEFAULT '[]',
  bottlenecks_json TEXT NOT NULL DEFAULT '[]',
  incidents_json TEXT NOT NULL DEFAULT '[]',
  useful_workflows_json TEXT NOT NULL DEFAULT '[]',
  unnecessary_work_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  deviations_json TEXT NOT NULL DEFAULT '[]',
  trust_updates_json TEXT NOT NULL DEFAULT '[]',
  lessons_json TEXT NOT NULL DEFAULT '[]',
  topology_changes_json TEXT NOT NULL DEFAULT '[]',
  policy_changes_json TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_por_objective ON post_objective_records(objective_id);

CREATE TABLE IF NOT EXISTS org_trust (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_trust_agent_cap ON org_trust(agent_id, capability);

CREATE TABLE IF NOT EXISTS org_messages (
  id TEXT PRIMARY KEY,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  type TEXT NOT NULL,
  task_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_messages_created ON org_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_org_messages_task ON org_messages(task_id);
`;

/**
 * AOrgI Phase 3 (migration v25) — capability governance, hierarchical plans
 * with deviation events, and negotiation/arbitration.
 *
 *  - org_capability_grants: CapabilityGrant rows (§10) — role × capability,
 *    allowed actions, autonomy L0–L3 (§12), requires_review, rate limit, data
 *    scope. A `*` capability row is that role's fallback grant. NO grant and
 *    no wildcard = DENY (an agent never inherits unrestricted tool access).
 *  - org_plans / org_plan_steps / org_plan_deviations: hierarchical planning
 *    (§19) — plans have version + owner; tasks link to plan steps; every plan
 *    change creates a PlanDeviationEvent (no silent plan changes).
 *  - org_negotiations / org_negotiation_rounds / org_arbiters: bounded debate
 *    (§22) — hard max rounds (default 3), then ARBITRATE by the explicit
 *    arbiter for the disagreement class (§23); strategic disagreements belong
 *    to the human CEO.
 *
 * Also links tasks into plans (plan_id / plan_step_id).
 */
export const ORG_PHASE3_SQL = `
CREATE TABLE IF NOT EXISTS org_capability_grants (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL DEFAULT '["*"]',
  autonomy_level TEXT NOT NULL DEFAULT 'L1',
  requires_review INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_hour INTEGER,
  data_scope TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_cap_grants_role ON org_capability_grants(role_id);
CREATE INDEX IF NOT EXISTS idx_org_cap_grants_cap ON org_capability_grants(capability);

CREATE TABLE IF NOT EXISTS org_plans (
  id TEXT PRIMARY KEY,
  objective_id TEXT,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  owner_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_plans_objective ON org_plans(objective_id);

CREATE TABLE IF NOT EXISTS org_plan_steps (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'PENDING',
  started_at TEXT,
  completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_plan_steps_plan ON org_plan_steps(plan_id);

CREATE TABLE IF NOT EXISTS org_plan_deviations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_plan_dev_plan ON org_plan_deviations(plan_id);

CREATE TABLE IF NOT EXISTS org_negotiations (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  arbiter_role TEXT,
  verdict TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_neg_status ON org_negotiations(status);

CREATE TABLE IF NOT EXISTS org_negotiation_rounds (
  id TEXT PRIMARY KEY,
  negotiation_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_neg_rounds_neg ON org_negotiation_rounds(negotiation_id);

CREATE TABLE IF NOT EXISTS org_arbiters (
  id TEXT PRIMARY KEY,
  disagreement_class TEXT NOT NULL UNIQUE,
  arbiter_role_id TEXT,
  fallback_role_id TEXT,
  arbiter_kind TEXT NOT NULL DEFAULT 'role',
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN plan_id TEXT;
ALTER TABLE tasks ADD COLUMN plan_step_id TEXT;

-- Capability grants (AOrgI §10, §12). Every role gets a wildcard fallback at
-- its default autonomy; spend and deploy are hard-restricted across the org
-- (L0 = suggest only / founder-gated), and external communication starts at
-- L1 (reviewed). Fail-closed: no grant + no wildcard = DENY.
INSERT OR IGNORE INTO org_capability_grants
 (id, role_id, capability, allowed_actions_json, autonomy_level, requires_review,
  rate_limit_per_hour, data_scope, source, created_at, updated_at) VALUES
 ('gr_coa_wild', 'role_coa', '*', '["*"]', 'L2', 0, NULL, 'all', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_coa_spend', 'role_coa', 'spend', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_coa_deploy', 'role_coa', 'deploy', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_coa_external', 'role_coa', 'external', '["*"]', 'L1', 0, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_sw_wild', 'role_software_engineering', '*', '["*"]', 'L2', 0, NULL, 'local execution', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_sw_spend', 'role_software_engineering', 'spend', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_sw_deploy', 'role_software_engineering', 'deploy', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_sw_external', 'role_software_engineering', 'external', '["*"]', 'L1', 0, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_qa_wild', 'role_qa_verification', '*', '["*"]', 'L2', 0, NULL, 'verification', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_qa_spend', 'role_qa_verification', 'spend', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_qa_deploy', 'role_qa_verification', 'deploy', '["*"]', 'L1', 0, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_dsp_wild', 'role_dsp_engineering', '*', '["*"]', 'L2', 0, NULL, 'code', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_dsp_spend', 'role_dsp_engineering', 'spend', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_dsp_deploy', 'role_dsp_engineering', 'deploy', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_strat_wild', 'role_strategy_intelligence', '*', '["*"]', 'L2', 0, NULL, 'research', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_strat_external', 'role_strategy_intelligence', 'external', '["*"]', 'L1', 0, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_pa_wild', 'role_product_architect', '*', '["*"]', 'L2', 0, NULL, 'product', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_pm_wild', 'role_product_manager', '*', '["*"]', 'L2', 0, NULL, 'product', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_ux_wild', 'role_design_ux', '*', '["*"]', 'L2', 0, NULL, 'design', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_growth_wild', 'role_growth_intelligence', '*', '["*"]', 'L1', 0, NULL, 'commercial', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_growth_spend', 'role_growth_intelligence', 'spend', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_sales_wild', 'role_sales_partnerships', '*', '["*"]', 'L1', 0, NULL, 'commercial', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_sales_external', 'role_sales_partnerships', 'external', '["*"]', 'L1', 0, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_cust_wild', 'role_customer_intelligence', '*', '["*"]', 'L2', 0, NULL, 'commercial', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_fin_wild', 'role_finance_governance', '*', '["*"]', 'L1', 0, NULL, 'control', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_fin_deploy', 'role_finance_governance', 'deploy', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Explicit arbiters (AOrgI §23). Strategic disagreements stay with the human
-- CEO; everything else has a named organizational arbiter.
INSERT OR IGNORE INTO org_arbiters
 (id, disagreement_class, arbiter_role_id, fallback_role_id, arbiter_kind, source, created_at, updated_at) VALUES
 ('arb_technical', 'technical', 'role_product_architect', 'role_dsp_engineering', 'role', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('arb_product', 'product', 'role_product_manager', 'role_strategy_intelligence', 'role', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('arb_quality', 'quality', 'role_qa_verification', NULL, 'role', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('arb_governance', 'governance', 'role_finance_governance', NULL, 'role', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('arb_cross_functional', 'cross_functional', 'role_coa', NULL, 'role', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('arb_strategic', 'strategic', NULL, NULL, 'human_ceo', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * AOrgI Phases 1–3 audit fixes (migration v26).
 *
 *  - reasoning_traces: structured decision records (§13) — agent, task, mode,
 *    evidence, hypothesis, confidence, final action, visibility. Private
 *    chain-of-thought is never stored; only inspectable evidence + rationale.
 *  - org_roles.prompt_lineage_id: the manifest field §9 requires alongside
 *    lineage_id (§20 tracks both for critic independence).
 */
export const ORG_AUDIT_FIXES_SQL = `
CREATE TABLE IF NOT EXISTS reasoning_traces (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  mode TEXT NOT NULL DEFAULT 'decision',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  hypothesis TEXT NOT NULL DEFAULT '',
  confidence REAL,
  final_action TEXT NOT NULL DEFAULT '',
  trace_visibility TEXT NOT NULL DEFAULT 'internal',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasoning_agent ON reasoning_traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_reasoning_task ON reasoning_traces(task_id);

ALTER TABLE org_roles ADD COLUMN prompt_lineage_id TEXT;
UPDATE org_roles SET prompt_lineage_id = lineage_id WHERE prompt_lineage_id IS NULL;
`;

/**
 * AOrgI Phase 4 (migration v27) — collective intelligence measurement and the
 * organizational analyst (§35, §36).
 *
 *  - org_analyst_reports: periodic self-observation runs — metrics over the
 *    five system-level properties (emergence, convergence, robustness,
 *    scalability, objective achievement) + observations + recommendations.
 *  - org_chaos_tests: robustness drills (§35) — simulated agent kills and
 *    grant degradations. Production instances are NEVER targeted; probes are
 *    marked source='chaos' and cleaned up after each drill.
 */
export const ORG_PHASE4_SQL = `
CREATE TABLE IF NOT EXISTS org_analyst_reports (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  observations_json TEXT NOT NULL DEFAULT '[]',
  recommendations_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_analyst_generated ON org_analyst_reports(generated_at);

CREATE TABLE IF NOT EXISTS org_chaos_tests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_chaos_kind ON org_chaos_tests(kind);
`;

/**
 * AOrgI Phases 1–4 audit (round 2) fixes (migration v28).
 *
 *  - org_incidents: the blackboard's `incidents` field (§15) and the incident
 *    response record (§31: detect→classify→contain→…→restore→document). Seeded
 *    with the two REAL open failures so the record matches reality.
 *  - definition_of_done: the explicit organizational DefinitionOfDone (§30),
 *    stored as versioned org_memory — a policy artifact, not a code constant.
 */
export const ORG_PHASE_GAPS_SQL = `
CREATE TABLE IF NOT EXISTS org_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  status TEXT NOT NULL DEFAULT 'OPEN',
  description TEXT NOT NULL DEFAULT '',
  resolution TEXT,
  detected_at TEXT NOT NULL,
  contained_at TEXT,
  resolved_at TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_incidents_status ON org_incidents(status);

-- Real, currently-open failures — recorded as incidents, not invented (§42).
INSERT OR IGNORE INTO org_incidents
 (id, title, severity, status, description, detected_at, source, created_at, updated_at) VALUES
 ('inc_provider_balance', 'DeepSeek provider balance exhausted (HTTP 402)', 'HIGH', 'OPEN',
  'Model calls fail with Insufficient-Balance; surfaced by doctor check provider.balance. Owner action: top up the DeepSeek account.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'doctor', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('inc_interrupted_runs', 'Interrupted long-horizon agent runs (restart orphans)', 'HIGH', 'OPEN',
  'RUNNING agent jobs reaped as restart orphans accumulate; the maintenance sweep auto-resumes them, but the pile keeps recurring. Surfaced by doctor check jobs.interrupted_runs.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'doctor', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Explicit DefinitionOfDone (§30): functional requirements, acceptance tests,
-- regression, zero critical/blocking defects, governance, verified deployment,
-- complete documentation, commercial requirements.
INSERT OR IGNORE INTO org_memory
 (id, key, value_json, version, author, task_id, supersedes, status, source, created_at, updated_at)
VALUES ('orgm_dod_seed_v1', 'definition_of_done',
 '{"functional_requirements":"pass","acceptance_tests":"pass","regression":"pass","critical_defects":0,"blocking_defects":0,"governance":"pass","deployment":"verified","documentation":"complete","commercial_requirements":"complete","rule":"Do not extend work merely because something could theoretically be improved; remaining non-material issues are recorded for a future version."}',
 1, 'migration', NULL, NULL, 'ACTIVE', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * AOrgI Phase 5 (migration v29) — autonomous topology optimization (§33).
 *
 * org_topology_proposals: evidence-backed topology changes proposed by the
 * organizational analyst — instantiate / replicate / merge. Proposals are
 * DECISIONS FOR THE FOUNDER: the system proposes with evidence, a human
 * approves/rejects, and APPLIED is only recorded when reality confirms it
 * (a real runtime registers for the role). Never a silent headcount change.
 */
export const ORG_PHASE5_SQL = `
CREATE TABLE IF NOT EXISTS org_topology_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  role_id TEXT,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  decided_by TEXT,
  decided_at TEXT,
  source TEXT NOT NULL DEFAULT 'analyst',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_topology_status ON org_topology_proposals(status);
CREATE INDEX IF NOT EXISTS idx_org_topology_role ON org_topology_proposals(role_id);
`;

/**
 * Chat enhancements (migration v30): founder feedback on assistant messages
 * and durable, editable conversation titles.
 *
 * - `chat_messages.rating` — +1 / -1 thumbs feedback (NULL = unrated). This is
 *   the quality signal the audit's gap 12 called out as missing; it is
 *   additive so every existing row stays valid.
 * - `chat_session_titles` — a human (or auto-generated) title per session,
 *   overriding the derived "first message" text. Rename is gap 16, LLM
 *   auto-title is gap 26; both write here.
 */
export const CHAT_ENHANCE_SQL = `
ALTER TABLE chat_messages ADD COLUMN rating INTEGER;

CREATE TABLE IF NOT EXISTS chat_session_titles (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'founder',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_titles_updated ON chat_session_titles(updated_at);
`;

export { TASK_EVIDENCE_SQL } from "./task-evidence-schema";
export { METER_USAGE_SQL } from "./meter-usage-schema";
