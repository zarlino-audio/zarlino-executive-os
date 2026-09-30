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
    expect(r.reply).toContain("pending approval");
    expect(r.reply).toContain("Secret internal approval");
    expect(r.reply).not.toContain("zarlinoaudio.com and the right person");

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
});
