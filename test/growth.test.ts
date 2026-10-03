import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { checkReplyPolicy } from "../src/integrations/growth-ai";
import { maybeAutoReply, runFollowUps, type OutreachEnv } from "../src/core/outreach";
import type { Prospect } from "../src/types-outreach";
import type { sendEmail } from "../src/integrations/email";

const GOOD_DRAFT =
  "Hi — happy to send the free license over. Just reply with the best address.\n\n- Zarlino Audio\nsupport@zarlinoaudio.com";

function fakeSender() {
  const calls: Array<{ to: string; subject: string; text: string }> = [];
  const send = (async (_env: unknown, msg: { to: string; subject: string; text: string }) => {
    calls.push(msg);
    return { ok: true, provider: "test" };
  }) as unknown as typeof sendEmail;
  return { calls, send };
}

describe("growth agent", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;
  const env = {
    OUTREACH_DAILY_CAP: "20",
    GROWTH_REPLY_DAILY_CAP: "10",
    EMAIL_FROM: "support@zarlinoaudio.com",
  } as unknown as OutreachEnv;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });
  afterAll(() => {
    db.close();
  });

  const mk = (id: string, email: string, status = "CONTACTED", lastTouch: string | null = null) => {
    const at = new Date().toISOString();
    const p: Prospect = {
      id,
      name: `Prospect ${id}`,
      platform: "youtube",
      handle: null,
      email,
      url: null,
      status,
      notes: null,
      source: "test",
      last_touch_at: lastTouch,
      created_at: at,
      updated_at: at,
    };
    store.createProspect(p);
  };

  describe("checkReplyPolicy", () => {
    it("accepts an honest draft and rejects risky ones", () => {
      expect(checkReplyPolicy(GOOD_DRAFT).ok).toBe(true);
      expect(checkReplyPolicy("We guarantee free forever deals for everyone at Zarlino").ok).toBe(false);
      expect(checkReplyPolicy("Hi {name} from Zarlino Audio support@zarlinoaudio.com").ok).toBe(false);
      expect(checkReplyPolicy("short").ok).toBe(false);
    });
  });

  describe("maybeAutoReply", () => {
    it("skips opt-outs, self mail and auto-responders", async () => {
      mk("pr_a", "a@example.com");
      mk("pr_self", "support@zarlinoaudio.com");
      const { calls, send } = fakeSender();
      const generate = vi.fn(async () => GOOD_DRAFT);

      const optOut = await maybeAutoReply(
        store,
        env,
        { from: "a@example.com", body: "no thanks", intent: "OPT_OUT", prospectId: "pr_a" },
        { generate, send },
      );
      expect(optOut.sent).toBe(false);

      const self = await maybeAutoReply(
        store,
        env,
        { from: "support@zarlinoaudio.com", body: "hello", intent: "OTHER", prospectId: "pr_self" },
        { generate, send },
      );
      expect(self.reason).toBe("self");

      const ooo = await maybeAutoReply(
        store,
        env,
        {
          from: "a@example.com",
          subject: "Automatic reply: Out of office",
          body: "I am away",
          intent: "OTHER",
          prospectId: "pr_a",
        },
        { generate, send },
      );
      expect(ooo.reason).toBe("auto-responder");
      expect(calls).toHaveLength(0);
    });

    it("drafts, policy-checks and sends exactly one reply per thread", async () => {
      mk("pr_ok", "ok@example.com");
      const { calls, send } = fakeSender();
      const generate = vi.fn(async () => GOOD_DRAFT);
      const r1 = await maybeAutoReply(
        store,
        env,
        {
          from: "ok@example.com",
          subject: "Re: Free ZTame license + 25% for your audience",
          body: "yes send it over",
          intent: "INTERESTED",
          prospectId: "pr_ok",
        },
        { generate, send },
      );
      expect(r1.sent).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.to).toBe("ok@example.com");
      expect(calls[0]?.subject).toMatch(/^Re:/);
      expect(store.countTouchesByTemplate("pr_ok", "auto_reply")).toBe(1);

      const r2 = await maybeAutoReply(
        store,
        env,
        { from: "ok@example.com", body: "and one more thing?", intent: "QUESTION", prospectId: "pr_ok" },
        { generate, send },
      );
      expect(r2.sent).toBe(false);
      expect(String(r2.reason)).toContain("already replied");
    });

    it("escalates instead of sending when the draft violates policy", async () => {
      mk("pr_bad", "bad@example.com");
      const { calls, send } = fakeSender();
      const generate = vi.fn(async () => "We guarantee it — unlimited free forever. - Zarlino Audio");
      const r = await maybeAutoReply(
        store,
        env,
        { from: "bad@example.com", body: "tell me more", intent: "INTERESTED", prospectId: "pr_bad" },
        { generate, send },
      );
      expect(r.sent).toBe(false);
      expect(String(r.reason)).toContain("policy");
      expect(calls).toHaveLength(0);
    });
  });

  describe("runFollowUps", () => {
    it("sends exactly one nudge to stale contacted prospects only", async () => {
      const old = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
      mk("pr_old", "old@example.com", "CONTACTED", old);
      mk("pr_new", "new@example.com", "CONTACTED", new Date().toISOString());
      mk("pr_replied", "replied@example.com", "REPLIED", old);
      store.setSetting("outreach_enabled", "1");

      const bindingCalls: unknown[] = [];
      const binding = {
        async send(msg: unknown) {
          bindingCalls.push(msg);
          return { messageId: "m1" };
        },
      };
      const env2 = {
        OUTREACH_DAILY_CAP: "20",
        FOLLOWUP_AFTER_DAYS: "5",
        EMAIL_PROVIDER: "cloudflare",
        EMAIL_FROM: "support@zarlinoaudio.com",
        EMAIL_FROM_NAME: "Zarlino Audio",
        SEND_EMAIL: binding,
      } as unknown as OutreachEnv;

      const r1 = await runFollowUps(store, env2);
      expect(r1.sent).toBe(1);
      expect(bindingCalls).toHaveLength(1);
      expect(store.countTouchesByTemplate("pr_old", "follow_up")).toBe(1);

      const r2 = await runFollowUps(store, env2);
      expect(r2.sent).toBe(0);
      expect(store.countTouchesByTemplate("pr_new", "follow_up")).toBe(0);
      expect(store.countTouchesByTemplate("pr_replied", "follow_up")).toBe(0);
    });
  });
});
