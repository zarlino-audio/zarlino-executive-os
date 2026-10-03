/**
 * Outreach pipeline schema (migration v35, Phase 1 growth).
 *
 * The "marketing team" store: a prospect queue plus every touch we make.
 * Purely additive, so existing databases stay valid.
 */
export const OUTREACH_SQL = `
CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'other',
  handle TEXT,
  email TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'founder',
  last_touch_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email);

CREATE TABLE IF NOT EXISTS outreach_touches (
  id TEXT PRIMARY KEY,
  prospect_id TEXT NOT NULL,
  template TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL,
  subject TEXT,
  error TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_touches_prospect ON outreach_touches(prospect_id);
CREATE INDEX IF NOT EXISTS idx_touches_sent ON outreach_touches(sent_at);
`;
