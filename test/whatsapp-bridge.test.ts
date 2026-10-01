import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createApprovalRequest } from "../src/core/approvals/queue";
import {
  handleInboundWhatsApp,
  isFounderNumber,
  normalizePhone,
  strangerReply,
  FOUNDER_WHATSAPP_DEFAULT,
} from "../src/core/org/founder-channel";
import {
  cooldown,
  composeFounderDigest,
  markFounderMessageSent,
  naturalDigestFallback,
} from "../src/core/org/voice";

describe("WhatsApp founder channel — FR-1 founder vs stranger", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });

  afterAll(() => {
    db.close();
  });

  it("normalizes phone formats and only accepts the founder's number", () => {
    expect(normalizePhone("+233 54 677 8438")).toBe("233546778438");
    expect(normalizePhone("whatsapp:+233546778438")).toBe("233546778438");

    // Every sensible spelling of the founder's number matches.
    expect(isFounderNumber({}, "+233546778438")).toBe(true);
    expect(isFounderNumber({}, "233546778438")).toBe(true);
    expect(isFounderNumber({}, "233546778438@s.whatsapp.net")).toBe(true);
    expect(isFounderNumber({}, "0546778438")).toBe(true); // national format (last 9)

    // Anyone else is NOT the founder — fail closed.
    expect(isFounderNumber({}, "+233500000000")).toBe(false);
    expect(isFounderNumber({}, "15551234567")).toBe(false);
    expect(isFounderNumber({}, "")).toBe(false);

    // Env override respected.
    expect(isFounderNumber({ WHATSAPP_FOUNDER_NUMBER: "+15550001111" }, "15550001111")).toBe(true);
    expect(FOUNDER_WHATSAPP_DEFAULT).toBe("+233546778438");
  });

  it("strangers get the canned reply and never founder context", async () => {
    // A pending approval exists that the founder would see — the stranger must NOT.
    store.insertApproval(
      createApprovalRequest({ action_label: "Secret internal approval", reason: "internal", requested_by: "executive" }),
    );

    const r = await handleInboundWhatsApp(store, {}, {
      from: "+15551234567",
      name: "Some Customer",
      text: "hi do you sell plugins?",
      messageId: "msg_stranger_1",
    });

    expect(r.role).toBe("STRANGER");
    expect(r.duplicate).toBe(false);
    expect(r.reply).toBe(strangerReply());
    expect(r.reply).not.toContain("Secret internal approval");
    expect(r.reply).toContain("zarlinoaudio.com");

    const rows = store.listWhatsAppMessages(10);
    expect(rows[0]!.role).toBe("STRANGER");
    expect(rows[0]!.wa_from).toBe("15551234567");
    expect(rows[0]!.status).toBe("REPLIED");
  });

  it("the founder's own number gets founder treatment with real state, no AI needed", async () => {
    const r = await handleInboundWhatsApp(store, {}, {
      from: "+233546778438",
      name: "Founder",
      text: "what needs me right now?",
      messageId: "msg_founder_1",
    });

    expect(r.role).toBe("FOUNDER");
    expect(r.duplicate).toBe(false);
    // Deterministic fallback (no Workers AI binding in tests) yet grounded in
    // the real store state — pending approvals are surfaced to the founder.
    expect(r.reply).toContain("Secret internal approval");
    // AND it must not read like a machine wrote it.
    expect(r.reply).not.toContain("[");
    expect(r.reply).not.toContain("decision(s)");
    expect(r.reply).not.toMatch(/\b(ai|bot|automated|automation|system|agent)\b/i);

    const rows = store.listWhatsAppMessages(10);
    expect(rows[0]!.role).toBe("FOUNDER");
    expect(rows[0]!.status).toBe("REPLIED");
  });

  it("dedupes provider redeliveries — no double reply", async () => {
    const again = await handleInboundWhatsApp(store, {}, {
      from: "+233546778438",
      text: "what needs me right now?",
      messageId: "msg_founder_1",
    });
    expect(again.duplicate).toBe(true);
    expect(again.reply).toBe("");

    // And strangers dedupe too.
    const s = await handleInboundWhatsApp(store, {}, {
      from: "+15551234567",
      text: "hi do you sell plugins?",
      messageId: "msg_stranger_1",
    });
    expect(s.duplicate).toBe(true);
    expect(s.reply).toBe("");
  });

  it("outbox drains QUEUED notifications and flips them to SENT exactly once", () => {
    store.insertNotification({
      id: "ntf_bridge_test",
      channel: "whatsapp",
      provider: "unconfigured",
      recipient: null,
      subject: "1 decision needs the founder",
      body: "Approve or reject in the console.",
      status: "QUEUED_UNCONFIGURED",
      error: null,
      source: "ceo",
      created_at: new Date().toISOString(),
    });

    const queued = store.listQueuedNotifications(20);
    expect(queued.map((q) => q.id)).toContain("ntf_bridge_test");

    store.updateNotification("ntf_bridge_test", { status: "SENT", error: null, provider: "bridge" });
    const after = store.listQueuedNotifications(20);
    expect(after.map((q) => q.id)).not.toContain("ntf_bridge_test");

    // The row still exists (delivery history) — only the queue moved on.
    const all = store.listNotifications(50);
    expect(all.find((n) => n.id === "ntf_bridge_test")?.status).toBe("SENT");
  });

  it("coalesces the whole backlog into ONE natural message — duplicates merged, no machine traces", async () => {
    const at = new Date().toISOString();
    const mk = (id: string, subject: string, body: string) =>
      store.insertNotification({
        id,
        channel: "whatsapp",
        provider: "unconfigured",
        recipient: null,
        subject,
        body,
        status: "QUEUED_UNCONFIGURED",
        error: null,
        source: "ceo",
        created_at: at,
      });
    mk("ntf_c1", "1 item awaiting the founder", "• Approve ZTame 1.2 release (approval appr_x)\n\nApprove or reject in the console.");
    mk("ntf_c2", "1 item awaiting the founder", "• Approve ZTame 1.2 release (approval appr_x)\n\nApprove or reject in the console.");
    mk("ntf_c3", "1 item awaiting the founder", "• Name 3 trusted producers (approval appr_y)\n\nApprove or reject in the console.");

    const rows = store.listQueuedNotifications(50);
    const digest = await composeFounderDigest(store, {}, rows);

    // ONE message covering three queued rows, duplicate item merged.
    expect(digest.ids.length).toBe(3);
    expect(digest.items.length).toBe(2);
    expect(digest.text).toContain("• Approve ZTame 1.2 release");
    expect(digest.text).toContain("• Name 3 trusted producers");
    expect(digest.text).not.toContain("[Zarlino OS");
    expect(digest.text).not.toContain("decision(s)");
    expect(digest.text).not.toMatch(/\b(ai|bot|automated|automation|agent)\b/i);
    expect(digest.model).toBeNull(); // deterministic voice without AI binding
  });

  it("keeps a quiet gap between founder messages (override-able)", () => {
    const now = Date.parse("2026-10-01T10:00:00.000Z");
    expect(cooldown(store, {}, now).held).toBe(false); // nothing sent yet

    markFounderMessageSent(store, new Date(now).toISOString());
    const held = cooldown(store, {}, now + 60_000);
    expect(held.held).toBe(true);
    expect(held.holdUntil).toBe(new Date(now + 240 * 60_000).toISOString());
    expect(cooldown(store, {}, now + 241 * 60_000).held).toBe(false);

    // env override lets the founder tighten or loosen the gap
    expect(cooldown(store, { WHATSAPP_MIN_GAP_MINUTES: "1" }, now + 30_000).held).toBe(true);
    expect(cooldown(store, { WHATSAPP_MIN_GAP_MINUTES: "1" }, now + 61_000).held).toBe(false);
  });

  it("the deterministic digest voice passes the no-machine-traces bar", () => {
    const t = naturalDigestFallback(["Approve ZTame 1.2 release"]);
    expect(t).toContain("• Approve ZTame 1.2 release");
    expect(t).not.toMatch(/\b(ai|bot|automated|automation|system|agent)\b/i);
    expect(t).not.toContain("decision");
  });

  it("a bare 'approve' reply decides the pending item from the last digest", async () => {
    const ap = createApprovalRequest({ action_label: "Approve nightly builds", reason: "ci", requested_by: "executive" });
    store.insertApproval(ap);
    store.setSetting(
      "whatsapp:pending_digest_approvals",
      JSON.stringify({ ids: [ap.id], at: new Date().toISOString() }),
    );
    const r = await handleInboundWhatsApp(store, {}, {
      from: "+233546778438",
      text: "Approve",
      messageId: "msg_decide_1",
    });
    expect(r.role).toBe("FOUNDER");
    expect(store.getApproval(ap.id)?.status).toBe("APPROVED");
    expect(store.getApproval(ap.id)?.decided_by).toBe("founder");
    expect(r.reply).toContain("approved");
    expect(r.reply).toContain("Approve nightly builds");
  });

  it("'no' rejects; plain chat decides nothing", async () => {
    const ap2 = createApprovalRequest({ action_label: "Enable telemetry trial", reason: "analytics", requested_by: "executive" });
    store.insertApproval(ap2);
    store.setSetting(
      "whatsapp:pending_digest_approvals",
      JSON.stringify({ ids: [ap2.id], at: new Date().toISOString() }),
    );

    const chat = await handleInboundWhatsApp(store, {}, {
      from: "+233546778438",
      text: "what needs me right now?",
      messageId: "msg_chat_x",
    });
    expect(store.getApproval(ap2.id)?.status).toBe("PENDING");
    expect(chat.reply).not.toContain("rejected");

    const r = await handleInboundWhatsApp(store, {}, {
      from: "+233546778438",
      text: "no",
      messageId: "msg_decide_2",
    });
    expect(store.getApproval(ap2.id)?.status).toBe("REJECTED");
    expect(store.getApproval(ap2.id)?.decided_by).toBe("founder");
    expect(r.reply).toContain("rejected");
    expect(r.reply).toContain("Enable telemetry trial");
  });

  it("intent against a stale digest acts on nothing (48h safety window)", async () => {
    const ap3 = createApprovalRequest({ action_label: "Old pending thing", reason: "x", requested_by: "executive" });
    store.insertApproval(ap3);
    store.setSetting(
      "whatsapp:pending_digest_approvals",
      JSON.stringify({ ids: [ap3.id], at: new Date(Date.now() - 72 * 3600_000).toISOString() }),
    );
    const r = await handleInboundWhatsApp(store, {}, {
      from: "+233546778438",
      text: "approve",
      messageId: "msg_decide_3",
    });
    expect(store.getApproval(ap3.id)?.status).toBe("PENDING");
    expect(r.reply).not.toContain("Done");
  });
});
