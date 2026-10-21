/**
 * Factory build records (migration v40).
 *
 * Every build the Zarlino Plugin Factory dispatches gets ONE immutable build id
 * and one durable record that outlives the GitHub run, the model session and the
 * deploy. The record is the company's answer to "what did we ship, from what
 * specification, with what evidence, and what did it cost".
 *
 * Lifecycle:
 *   QUEUED -> ASSEMBLING -> BUILDING -> TESTING -> PACKAGING -> READY
 *                                                           \-> FAILED
 *
 * A build may only move forward along that chain (`factory_build_events` records
 * every transition), and only a build whose quality gate actually passed may
 * reach READY. The artifact and its integrity hash are attached at completion,
 * after the upload tool has re-downloaded and verified every object.
 *
 * Cost telemetry lives on the same row because a build's cost is a property of
 * the build, not of a separate ledger: compile/test/package wall time comes from
 * the workflow, artifact size from the package, and the AI + estimated variable
 * cost from the orchestrator, so a build's marginal cost is visible without
 * joining tables.
 */
export const FACTORY_BUILD_SQL = `
CREATE TABLE IF NOT EXISTS factory_builds (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  account_id TEXT,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_version TEXT NOT NULL,
  ui_template TEXT NOT NULL,
  status TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_sha256 TEXT NOT NULL,
  spec_fingerprint TEXT NOT NULL,
  ui_plan_fingerprint TEXT,
  catalog_fingerprint TEXT,
  provenance_json TEXT,
  modules_json TEXT,
  source_commit TEXT,
  target_platform TEXT NOT NULL,
  github_run_id TEXT,
  github_run_url TEXT,
  artifact_key TEXT,
  artifact_name TEXT,
  artifact_bytes INTEGER,
  artifact_sha256 TEXT,
  qa_report_key TEXT,
  qa_passed INTEGER,
  qa_summary_json TEXT,
  ai_cost_usd REAL NOT NULL DEFAULT 0,
  compile_seconds REAL NOT NULL DEFAULT 0,
  test_seconds REAL NOT NULL DEFAULT 0,
  package_seconds REAL NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  estimated_variable_cost_usd REAL NOT NULL DEFAULT 0,
  failure_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_factory_builds_status ON factory_builds(status, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_builds_product ON factory_builds(product_id, created_at);

CREATE TABLE IF NOT EXISTS factory_build_events (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  state TEXT NOT NULL,
  detail_json TEXT,
  actor TEXT NOT NULL DEFAULT 'orchestrator',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factory_build_events_build ON factory_build_events(build_id, created_at);
`;
