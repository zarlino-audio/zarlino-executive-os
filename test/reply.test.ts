import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { classifyReply, recordProspectReply, sendOutreachNow } from "../src/core/outreach";
import type { Prospect } from "../src/types-outreach";

describe("reply autonomy", () => {
  describe("classifyReply", () => {
    it("detects opt-outs and lets them win over everything else", () => {
      expect(classifyReply("No thanks")).toBe("OPT_OUT");
      expect(classifyReply("no")).toBe("OPT_OUT");
      expect(classifyReply("Please remove me from this list.")).toBe("OPT_OUT");
      expect(classifyReply("Not interested — thanks. Can you also send pricing?")).toBe("OPT_OUT");
    });
    it("detects interest", () => {
      expect(classifyReply("Yes please!")).toBe("INTERESTED");
      expect(classifyReply("Sounds good, send me the license")).toBe("INTERESTED");
      expect(classifyReply("I'd love to try it")).toBe("INTERESTED");
    });
    it("detects questions and everything else", () => {
      expect(classifyReply("What does it run on?")).toBe("QUESTION");
      expect(classifyReply("Out of office until Monday")).toBe("OTHER");
      expect(classifyReply("")).toBe("OTHER");
    });
    it("does not confuse words that merely contain 'no'", () => {
      expect(classifyReply("Runs fine on windows")).toBe("OTHER");
    });
  });

  describe("recordProspectReply (store)", () => {
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

    const mk = (id: string, email: string, status = "CONTACTED") => {
      const at = new Date().toISOString();
      const p: Prospect = {
        id,
        name: `Test ${id}`,
        platform: "youtube",
        handle: null,
        email,
        url: null,
        status,
        notes: null,
        source: "test",
        last_touch_at: null,
        created_at: at,
        updated_at: at,
      };
      store.createProspect(p);
    };

    it("marks opt-outs UNSUBSCRIBED and records the reply row", async () => {
      mk("pr_ro", "optout@example.com");
      const r = await recordProspectReply(store, {} as never, {
        from: "OptOut@Example.com",
        subject: "Re: hi",
        body: "No thanks, not interested.",
      });
      expect(r.intent).toBe("OPT_OUT");
      expect(r.matched).toBe(true);
      expect(r.status).toBe("UNSUBSCRIBED");
      expect(store.getProspect("pr_ro")?.status).toBe("UNSUBSCRIBED");
      expect(store.listProspectReplies(5)[0]?.intent).toBe("OPT_OUT");
      expect(store.listProspectReplies(5)[0]?.prospect_id).toBe("pr_ro");
    });

    it("marks interest REPLIED and still records unknown senders", async () => {
      mk("pr_in", "interested@example.com");
      const r = await recordProspectReply(store, {} as never, {
        from: "interested@example.com",
        body: "yes send it over",
      });
      expect(r.status).toBe("REPLIED");
      const u = await recordProspectReply(store, {} as never, {
        from: "stranger@example.com",
        body: "hello there",
      });
      expect(u.matched).toBe(false);
      expect(u.intent).toBe("OTHER");
    });

    it("never contacts an unsubscribed prospect again", async () => {
      mk("pr_un", "unsub2@example.com", "UNSUBSCRIBED");
      const r = await sendOutreachNow(store, {} as never, "pr_un");
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("unsubscribed");
    });
  });
});
