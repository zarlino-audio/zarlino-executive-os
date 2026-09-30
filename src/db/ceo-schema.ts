/**
 * CEO agent + founder-notification tables (migration v33).
 *
 * - `notifications` — every message the OS sends the founder (WhatsApp) and
 *   its honest delivery state. When no provider is configured the message is
 *   recorded as QUEUED_UNCONFIGURED — never silently dropped, never claimed
 *   as "sent".
 * - `ceo_reports` — one row per CEO decision cycle: what was decided, what
 *   was escalated, and the compressed summary (with model + neurons used).
 * - `role_ceo` — the 13th org role: the autonomous Chief Executive Agent.
 *   It owns priorities, approves reversible decisions within policy and
 *   reaches the founder ONLY via WhatsApp escalation when policy is exceeded.
 */
export const CEO_WHATSAPP_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  provider TEXT,
  recipient TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED_UNCONFIGURED',
  error TEXT,
  source TEXT NOT NULL DEFAULT 'ceo',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS ceo_reports (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL DEFAULT 'manual',
  decided_json TEXT NOT NULL DEFAULT '[]',
  escalated_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  summary_model TEXT,
  neurons_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ceo_reports_created ON ceo_reports(created_at);

INSERT OR IGNORE INTO org_roles
 (id, name, department_id, lineage_id, model, scope, responsibilities_json, obligations_json,
  capabilities_json, default_autonomy, critic_role_id, escalation_threshold, version, status,
  source, created_at, updated_at) VALUES
 ('role_ceo', 'Chief Executive Agent', 'dept_executive', 'lineage_ceo', 'workers-ai-exec',
  'Acts as the CEO: owns priorities, approves reversible decisions within policy, and reaches the founder ONLY via WhatsApp escalation when policy is exceeded.',
  '["Own organizational priorities","Decide approvals within policy","Escalate policy-exceeding items to the founder","Report compressed executive state"]',
  '["Never exceed configured spend/irreversibility policy","Escalate rather than guess","Never disguise an escalation as autonomous action"]',
  '["decide_approvals","prioritize","executive_reporting","escalation"]', 'L3', 'role_coa',
  'Spend above policy cap, irreversible change, legal/safety/credential topic, or repeated failures',
  1, 'ACTIVE', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Prompt lineage mirrors lineage (v26 pattern) — the new role is no exception.
UPDATE org_roles SET prompt_lineage_id = lineage_id WHERE id = 'role_ceo' AND prompt_lineage_id IS NULL;

-- Fail-closed capability grants: same shape as the COA — wildcard working
-- scope at L2, but spend/deploy are L0 (approval-required) and external is L1.
INSERT OR IGNORE INTO org_capability_grants
 (id, role_id, capability, allowed_actions_json, autonomy_level, requires_review,
  rate_limit_per_hour, data_scope, source, created_at, updated_at) VALUES
 ('gr_ceo_wild', 'role_ceo', '*', '["*"]', 'L2', 0, NULL, 'all', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_ceo_spend', 'role_ceo', 'spend', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_ceo_deploy', 'role_ceo', 'deploy', '["*"]', 'L0', 1, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('gr_ceo_external', 'role_ceo', 'external', '["*"]', 'L1', 0, NULL, '', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;
