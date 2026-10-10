/**
 * Remote execution schema (migration v39) — the execution-boundary fix.
 *
 * The VM is the CEO's communication and intelligence environment, NOT the
 * company's engineering execution environment. Engineering work is dispatched
 * to GitHub Actions; `remote_runs` is the persistent record of every dispatch
 * so execution status, artifacts and evidence survive any model session.
 *
 * Also in this migration:
 *   - `tasks.objective_id` — tasks belong to persistent objectives.
 *   - `objectives.criteria_json/verified_at/source_ref/evidence_json` —
 *     measurable completion criteria + verification provenance.
 *   - `local_tasks.execution_target` — a machine daemon may only claim rows
 *     explicitly marked `machine_maintenance`; engineering rows exist nowhere
 *     in the local queue (refused at creation).
 */
export const REMOTE_EXECUTION_SQL = `
ALTER TABLE tasks ADD COLUMN objective_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objective_id);

ALTER TABLE objectives ADD COLUMN criteria_json TEXT;
ALTER TABLE objectives ADD COLUMN verified_at TEXT;
ALTER TABLE objectives ADD COLUMN source_ref TEXT;
ALTER TABLE objectives ADD COLUMN evidence_json TEXT;

ALTER TABLE local_tasks ADD COLUMN execution_target TEXT;
CREATE INDEX IF NOT EXISTS idx_local_tasks_target ON local_tasks(execution_target);

CREATE TABLE IF NOT EXISTS remote_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  objective_id TEXT,
  repo TEXT NOT NULL,
  workflow_file TEXT NOT NULL,
  ref TEXT NOT NULL,
  inputs_json TEXT,
  status TEXT NOT NULL DEFAULT 'DISPATCHED',
  conclusion TEXT,
  github_run_id TEXT,
  run_url TEXT,
  artifacts_json TEXT,
  evidence_id TEXT,
  dispatched_at TEXT NOT NULL,
  last_synced_at TEXT,
  finished_at TEXT,
  cancel_requested_at TEXT,
  error TEXT,
  detail_json TEXT,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remote_runs_status ON remote_runs(status);
CREATE INDEX IF NOT EXISTS idx_remote_runs_task ON remote_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_remote_runs_objective ON remote_runs(objective_id);
`;
