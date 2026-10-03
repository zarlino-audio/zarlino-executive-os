import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { canSendToday, outreachDailyCap, renderTemplate, OUTREACH_TEMPLATES } from "../src/core/outreach";
import { emailConfigured, sendEmail } from "../src/integrations/email";
import type { Prospect } from "../src/types-outreach";

describe("outreach pipeline store (migration v35)", () => {
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

  it("creates, dedupes by email, updates and counts prospects", () => {
    const at = new Date().toISOString();
    const p: Prospect = {
      id: "pr_test1",
      name: "Test Producer",
      platform: "youtube",
      handle: "@test",
      email: "Test@Example.com",
      url: null,
      status: "NEW",
      notes: null,
      source: "test",
      last_touch_at: null,
      created_at: at,
      updated_at: at,
    };
    store.createProspect(p);
    expect(store.findProspectByEmail("test@example.com")?.id).toBe("pr_test1");
    expect(store.findProspectByEmail("TEST@EXAMPLE.COM")?.id).toBe("pr_test1");
    const updated = store.updateProspect("pr_test1", { status: "CONTACTED" });
    expect(updated?.status).toBe("CONTACTED");
    expect(store.countProspectsByStatus()["CONTACTED"]).toBe(1);
    expect(store.listProspects({ status: "NEW" })).toHaveLength(0);
    expect(store.listProspects({ status: "CONTACTED" })).toHaveLength(1);
  });

  it("records touches and counts sends per day", () => {
    const at = new Date().toISOString();
    store.recordOutreachTouch({
      id: "ot_test1",
      prospect_id: "pr_test1",
      template: "affiliate_intro",
      channel: "email",
      status: "SENT",
      subject: "s",
      error: null,
      sent_at: at,
      created_at: at,
    });
    store.recordOutreachTouch({
      id: "ot_test2",
      prospect_id: "pr_test1",
      template: "affiliate_intro",
      channel: "email",
      status: "FAILED",
      subject: "s",
      error: "boom",
      sent_at: at,
      created_at: at,
    });
    expect(store.outreachSentCount(at.slice(0, 10))).toBe(1); // FAILED does not count
    expect(store.listOutreachTouches(10)).toHaveLength(2);
  });
});

describe("outreach helpers", () => {
  it("renders templates and leaves unknown placeholders visible", () => {
    expect(renderTemplate("Hi {name} on {platform}", { name: "Ama" })).toBe("Hi Ama on {platform}");
    expect(renderTemplate("Hi {name}", {})).toBe("Hi {name}");
  });

  it("enforces the daily cap with sane defaults and a hard ceiling", () => {
    expect(canSendToday(19, 20)).toBe(true);
    expect(canSendToday(20, 20)).toBe(false);
    expect(outreachDailyCap(undefined)).toBe(20);
    expect(outreachDailyCap("50")).toBe(50);
    expect(outreachDailyCap("9999")).toBe(200);
    expect(outreachDailyCap("banana")).toBe(20);
  });

  it("keeps every template compliant: honest opt-out + contact address", () => {
    for (const t of OUTREACH_TEMPLATES) {
      expect(t.body).toContain('reply "no"');
      expect(t.body).toContain("support@zarlinoaudio.com");
      expect(t.body.length).toBeLessThan(1400); // short is a feature
    }
  });

  it("refuses to send while unconfigured (never counted as a prospect failure)", async () => {
    expect(emailConfigured({})).toBe(false);
    const r = await sendEmail({}, { to: "x@y.zz", subject: "s", text: "t" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not configured");
  });
});
