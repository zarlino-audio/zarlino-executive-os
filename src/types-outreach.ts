/** Outreach pipeline types (migration v35, Phase 1 growth). */

export interface Prospect {
  id: string;
  name: string;
  platform: string;
  handle: string | null;
  email: string | null;
  url: string | null;
  status: string;
  notes: string | null;
  source: string;
  last_touch_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutreachTouch {
  id: string;
  prospect_id: string;
  template: string;
  channel: string;
  status: string;
  subject: string | null;
  error: string | null;
  sent_at: string;
  created_at: string;
}
