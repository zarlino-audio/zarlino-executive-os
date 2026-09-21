/**
 * Closed-loop governance (migration v31): the evidence attached to a task, plus
 * the reason a task was closed without any.
 *
 * This is the durable half of the evidence gate in
 * `src/core/tasks/evidence.ts`. Without a table the gate would be advisory — the
 * order of (1) store evidence, (2) transition status is what makes "DONE"
 * mean something.
 *
 * - `task_evidence` — one row per evidence item: kind, locator, summary and the
 *   raw `verification_command` / `verification_output` pair that closes the loop.
 * - `tasks.close_reason` — set only when a task is closed through the explicit
 *   founder override, so an override is visible on the task itself instead of
 *   being indistinguishable from real, verified completion.
 */
export const TASK_EVIDENCE_SQL = `
ALTER TABLE tasks ADD COLUMN close_reason TEXT;

CREATE TABLE IF NOT EXISTS task_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  verification_command TEXT,
  verification_output TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'executive',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_evidence_task ON task_evidence(task_id);
CREATE INDEX IF NOT EXISTS idx_task_evidence_verified ON task_evidence(task_id, verified);
`;
