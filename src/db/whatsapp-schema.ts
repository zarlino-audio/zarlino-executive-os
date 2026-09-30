/**
 * WhatsApp channel tables (migration v34).
 *
 * The founder channel runs through a LINKED-DEVICE bridge: a small Node
 * service (`tools/whatsapp-bridge`) logs into the business WhatsApp account
 * exactly like WhatsApp Web does, receives incoming messages, asks the OS
 * what to do with each one, and sends replies + queued founder escalations.
 *
 * Two directions, two tables:
 *  - `whatsapp_messages` — the conversation log. Every inbound message is
 *    classified: messages from the founder's own number are the FOUNDER
 *    channel; every other number is a STRANGER and gets a polite canned
 *    reply (never founder treatment). Message ids are deduped so provider
 *    redeliveries can never double-reply.
 *  - outbound escalations continue to live in `notifications`; the bridge
 *    drains rows with status QUEUED* and flips them to SENT/FAILED via
 *    `/api/whatsapp/outbox/:id/ack` — delivery state is never faked.
 */
export const WHATSAPP_BRIDGE_SQL = `
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,                      -- IN | OUT
  wa_from TEXT NOT NULL,
  wa_to TEXT,
  wa_name TEXT,
  role TEXT NOT NULL DEFAULT 'STRANGER',        -- FOUNDER | STRANGER | SYSTEM
  body TEXT NOT NULL,
  reply TEXT,
  message_id TEXT,                              -- provider message id (dedupe)
  status TEXT NOT NULL DEFAULT 'RECEIVED',      -- RECEIVED | REPLIED | FAILED
  source TEXT NOT NULL DEFAULT 'bridge',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created ON whatsapp_messages(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_mid ON whatsapp_messages(message_id) WHERE message_id IS NOT NULL;
`;
