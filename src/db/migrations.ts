/**
 * Migration runner for the Executive OS (spec §4, §31).
 *
 * Applies the ordered migration list from src/db/schema.ts, records applied
 * versions in `schema_migrations`, and seeds the deterministic baseline state
 * (products, pipeline gates, roles, doctrine, objectives, financial baseline)
 * so a fresh database is fully usable and a re-deploy is idempotent.
 *
 * Runs verbatim on:
 *   - the Durable Object's embedded SQLite (production, on start/wake),
 *   - node:sqlite (tests / local tooling).
 */

import {
  SCHEMA_VERSION,
  INITIAL_SCHEMA_SQL,
  AUTH_SCHEMA_SQL,
  PIPELINE_STATE_SQL,
  PERSON_ROLES_SQL,
  DELEGATE_MODE_SQL,
  CHAT_STREAM_SQL,
  SHIP_STATE_SQL,
  FULL_ACCESS_SQL,
  AGENT_RUNS_SQL,
  LOCAL_TASKS_SQL,
  UPLOADED_FILES_SQL,
  RESILIENCY_SQL,
  SETTINGS_SQL,
  PLANNER_SQL,
  AUTO_RUN_SQL,
  PRODUCT_METRICS_SQL,
  DOCTOR_LOG_SQL,
  PRODUCTIVITY_SQL,
  FOUNDER_CREDENTIALS_SEED_SQL,
  LOCAL_AGENT_STATUS_SQL,
  REVIEW_ITEMS_SQL,
  PERCEPTUAL_SQL,
  ORG_MANIFESTS_SQL,
  ORG_PHASE2_SQL,
  ORG_PHASE3_SQL,
  ORG_AUDIT_FIXES_SQL,
  ORG_PHASE4_SQL,
  ORG_PHASE_GAPS_SQL,
  ORG_PHASE5_SQL,
} from "./schema";
import type { Sql } from "./sql";

export interface Migration {
  version: number;
  name: string;
  sql: string[];
}

/**
 * Deterministic baseline seed (part of migration v1). INSERT OR IGNORE keeps
 * it idempotent across redeploys; later data migrations (v3 pipeline state,
 * v7 ship state, v16 product metrics) build on top of these rows.
 */
const SEED_SQL = `
INSERT OR IGNORE INTO executive_state
 (id, overall_status, current_objective_id, top_priorities_json, paused, autonomy_mode,
  spending_disabled, deployments_disabled, updated_at)
VALUES ('zarlino', 'GREEN', 'obj_01', '["Ship ZScorch","Ship ZTame"]', 0, 'CONTROLLED',
  0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO objectives
 (id, title, description, status, priority, source, created_at, updated_at)
VALUES ('obj_01', 'Ship Zarlino plugins commercially',
  'Get ZTame and ZScorch to paying customers with a quality bar that protects the brand.',
  'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO workstreams
 (id, name, description, kind, status, source, created_at, updated_at)
VALUES ('ws_plugin_pipeline', 'Plugin Pipeline',
  '10-gate pipeline from concept to shipped plugin.',
  'PLUGIN_PIPELINE', 'ACTIVE', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO products
 (id, name, category, status, version, description, priority, price, source, created_at, updated_at)
VALUES
 ('prod_zscorch', 'ZScorch', 'Distortion / Saturation', 'SHIPPED', '1.0.0', 'Spectral saturation + multiband tilt.', 1, 79, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('prod_ztame', 'ZTame', 'Noise Reduction', 'SHIPPED', '1.0.0', 'Spectral noise suppressor.', 2, 49, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 10-gate pipeline for each plugin (plugin_id = product NAME, e.g. 'ZScorch').
INSERT OR IGNORE INTO pipeline_gates
 (id, workstream_id, plugin_id, gate_number, gate_name, status, owner_role, fail_count, source, created_at, updated_at)
SELECT 'gate_' || lower(replace(p.plugin, ' ', '_')) || '_' || g.n, 'ws_plugin_pipeline', p.plugin, g.n, g.name, 'NOT_STARTED', g.owner, 0, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM (SELECT 'ZScorch' AS plugin UNION ALL SELECT 'ZTame') AS p
JOIN (
  SELECT 1 AS n, 'Gate 1 — Market & Spec' AS name, 'Product Manager' AS owner
  UNION ALL SELECT 2, 'Gate 2 — Architecture & DSP Design', 'Architect'
  UNION ALL SELECT 3, 'Gate 3 — Implementation', 'DSP/UI/Parameter Engineer'
  UNION ALL SELECT 4, 'Gate 4 — Code Review & Correctness', 'Code Reviewer'
  UNION ALL SELECT 5, 'Gate 5 — Tests, Fuzz & Golden Refs', 'QA Engineer'
  UNION ALL SELECT 6, 'Gate 6 — Performance & Latency', 'Performance Engineer'
  UNION ALL SELECT 7, 'Gate 7 — Licensing & Security', 'Security & Licensing Engineer'
  UNION ALL SELECT 8, 'Gate 8 — Documentation', 'Documentation Writer'
  UNION ALL SELECT 9, 'Gate 9 — Release Build & CI', 'Release Engineer'
  UNION ALL SELECT 10, 'Gate 10 — Founder Release Decision', 'Founder'
) AS g ON 1=1;

-- Financial baseline.
INSERT OR IGNORE INTO financial_snapshots
 (id, period, cash, revenue, expenses, runway_months, gross_margin, confidence, notes, source, created_at, updated_at)
VALUES ('fin_seed', strftime('%Y-%m','now'), 0, 0, 0, NULL, NULL, 'ESTIMATE', 'Baseline seeded by the Executive OS. The Executive reconciles real figures via Paystack sync.', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Doctrine + policies.
INSERT OR IGNORE INTO doctrine_rules
 (id, code, principle, rationale, category, status, version, source, created_at, updated_at)
VALUES
 ('dr_01', 'AUTH_BEFORE_SPEND', 'Never move money without Founder approval.', 'Paystack transfers are HIGH risk and irreversible.', 'FINANCIAL', 'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dr_02', 'AUTH_BEFORE_DEPLOY', 'Never deploy to production without Founder approval.', 'Deploys are HIGH risk and user-visible.', 'OPERATIONAL', 'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dr_03', 'HONEST_NUMBERS', 'Never fabricate financial or product figures; report UNKNOWN instead.', 'Trust is the core asset; the Executive must say "I do not know".', 'GENERAL', 'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dr_04', 'AUDIT_EVERY_ACTION', 'Every consequential action is audited.', 'Accountability for autonomous work.', 'GENERAL', 'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO policies
 (id, code, title, body, category, status, version, source, created_at, updated_at)
VALUES
 ('pol_01', 'SPEND_POLICY', 'Spending policy', 'Spending requires an approved budget line and Founder approval before any money leaves the account.', 'FINANCIAL', 'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('pol_02', 'RELEASE_POLICY', 'Release policy', 'A plugin ships only after Gate 10 (Founder release decision) passes.', 'OPERATIONAL', 'ACTIVE', 1, 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial_schema", sql: [INITIAL_SCHEMA_SQL, SEED_SQL] },
  { version: 2, name: "auth", sql: [AUTH_SCHEMA_SQL] },
  { version: 3, name: "pipeline_state", sql: [PIPELINE_STATE_SQL] },
  { version: 4, name: "person_roles", sql: [PERSON_ROLES_SQL] },
  { version: 5, name: "delegate_mode", sql: [DELEGATE_MODE_SQL] },
  { version: 6, name: "chat_streams", sql: [CHAT_STREAM_SQL] },
  { version: 7, name: "ship_state", sql: [SHIP_STATE_SQL] },
  { version: 8, name: "full_access", sql: [FULL_ACCESS_SQL] },
  { version: 9, name: "agent_runs", sql: [AGENT_RUNS_SQL] },
  { version: 10, name: "local_tasks", sql: [LOCAL_TASKS_SQL] },
  { version: 11, name: "uploaded_files", sql: [UPLOADED_FILES_SQL] },
  { version: 12, name: "resiliency", sql: [RESILIENCY_SQL] },
  { version: 13, name: "settings", sql: [SETTINGS_SQL] },
  { version: 14, name: "planner", sql: [PLANNER_SQL] },
  { version: 15, name: "auto_run", sql: [AUTO_RUN_SQL] },
  { version: 16, name: "product_metrics", sql: [PRODUCT_METRICS_SQL] },
  { version: 17, name: "system_doctor", sql: [DOCTOR_LOG_SQL] },
  { version: 18, name: "productivity_manager", sql: [PRODUCTIVITY_SQL] },
  { version: 19, name: "founder_credentials_seed", sql: [FOUNDER_CREDENTIALS_SEED_SQL] },
  { version: 20, name: "local_agent_status", sql: [LOCAL_AGENT_STATUS_SQL] },
  { version: 21, name: "review_queue", sql: [REVIEW_ITEMS_SQL] },
  { version: 22, name: "perceptual_intelligence", sql: [PERCEPTUAL_SQL] },
  { version: 23, name: "org_manifests", sql: [ORG_MANIFESTS_SQL] },
  { version: 24, name: "org_phase2", sql: [ORG_PHASE2_SQL] },
  { version: 25, name: "org_phase3", sql: [ORG_PHASE3_SQL] },
  { version: 26, name: "org_audit_fixes", sql: [ORG_AUDIT_FIXES_SQL] },
  { version: 27, name: "org_phase4", sql: [ORG_PHASE4_SQL] },
  { version: 28, name: "org_phase_gaps", sql: [ORG_PHASE_GAPS_SQL] },
  { version: 29, name: "org_phase5", sql: [ORG_PHASE5_SQL] },
];

/** Latest schema version this code knows how to migrate to. */
export const LATEST_VERSION = SCHEMA_VERSION;

/**
 * Apply any pending migrations. Returns the list of migrations that were
 * actually applied (empty when the schema is already current).
 */
export function migrate(sql: Sql): Migration[] {
  sql.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  // The production store's schema_migrations predates the `name`/`applied_at`
  // columns (older shape: version + applied_at only). The CREATE above no-ops
  // on an existing table, so adapt it in place with ALTER TABLE ADD COLUMN
  // before inserting rows — otherwise every INSERT fails with
  // "table schema_migrations has no column named name".
  const existingCols = new Set(
    (sql.all<{ name: string }>("PRAGMA table_info(schema_migrations)") ?? []).map((r) => String(r.name)),
  );
  if (!existingCols.has("name")) {
    try {
      sql.run("ALTER TABLE schema_migrations ADD COLUMN name TEXT");
    } catch {
      /* another DO instance may have raced us — re-checked below */
    }
  }
  if (!existingCols.has("applied_at")) {
    try {
      sql.run("ALTER TABLE schema_migrations ADD COLUMN applied_at TEXT");
    } catch {
      /* raced */
    }
  }
  const appliedRows = sql.all<{ version: number }>("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => Number(r.version)));
  const ran: Migration[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    for (const stmt of m.sql) {
      try {
        sql.run(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Idempotency guard: an ALTER that already ran (e.g. after a partial
        // apply or a fresh deploy against a pre-seeded store) is treated as
        // already-applied rather than fatal.
        if (/duplicate column name|already exists|duplicate column/i.test(msg)) continue;
        throw err;
      }
    }
    sql.run(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      m.version,
      m.name,
      new Date().toISOString(),
    );
    ran.push(m);
  }
  return ran;
}
