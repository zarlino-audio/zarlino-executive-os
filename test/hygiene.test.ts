/**
 * Organisation hygiene tests (2026-10-04 five-group audit):
 *   - the funnel report never inflates itself from our own test sends;
 *   - chat sessions can actually be deleted (no stale debug context);
 *   - org tasks have a governed cancel path (closes the recorded
 *     "no local-task/task retire tool" capability gap);
 *   - the two commercial roles found missing by the audit exist after v37;
 *   - Marketing can see real waitlist numbers instead of guessing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
import { buildToolRegistry } from "../src/agent/tools";

describe("Organisation hygiene", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;
  let tools: ReturnType<typeof buildToolRegistry>;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
    tools = buildToolRegistry({ env: {}, sink: { recordExecution: () => {} } });
  });

  afterAll(() => {
    db.close();
  });

  const prospect = (id: string, email: string, source: string) => ({
    id,
    name: "Someone",
    platform: "email",
    handle: null,
    email,
    url: null,
    status: "CONTACTED" as const,
    notes: null,
    source,
    last_touch_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  it("excludes self-test prospects from the business funnel (and can still show them)", () => {
    store.createProspect(prospect("pr_real_1", "real1@example.com", "youtube"));
    store.createProspect(prospect("pr_real_2", "real2@example.com", "founder"));
    store.createProspect(prospect("pr_test_1", "founder-self-test@example.com", "self-test"));
    store.createProspect(prospect("pr_test_2", "smoke@example.com", "smoke-test"));

    const funnel = store.countProspectsByStatus();
    const all = store.countProspectsByStatus(true);
    expect(funnel.CONTACTED).toBe(2);
    expect(all.CONTACTED).toBe(4);
    expect(store.countTestProspects()).toBe(2);
  });

  it("deletes a chat session completely (messages, title, streams)", () => {
    const now = new Date().toISOString();
    store.insertChatMessage({
      id: "msg_h1",
      session_id: "chat_junk",
      role: "user",
      content: "deploy smoke test OK",
      created_at: now,
      updated_at: now,
      source: "founder",
    } as never);
    store.setChatSessionTitle("chat_junk", "Deploy verification", "founder");
    store.openChatStream("cs_h1", "chat_junk", now);

    expect(store.countChatSessions()).toBeGreaterThan(0);

    store.deleteChatSession("chat_junk");
    expect(store.listChatMessagesPage("chat_junk", { limit: 10 }).messages.length).toBe(0);
    expect(store.getChatSessionTitle("chat_junk")).toBeNull();
  });

  it("cancels a stale blocked task through the governed tool and disarms auto-run", async () => {
    const task = createTask({ title: "Stale blocker from a resolved incident", priority: "MEDIUM", source: "test" });
    task.status = "BLOCKED";
    task.auto_run = 1;
    store.insertTask(task);

    const tool = tools.getTool("executive.cancel_task");
    expect(tool).toBeTruthy();
    const out = (await tool!.run(
      { store, env: {}, audit: () => {} } as never,
      { taskId: task.id, reason: "Incident resolved 2026-10-03; the task no longer serves the business." },
    )) as { ok: boolean; status: string };

    expect(out.ok).toBe(true);
    expect(out.status).toBe("CANCELLED");
    const after = store.getTask(task.id)!;
    expect(after.status).toBe("CANCELLED");
    expect(after.auto_run).toBe(0);
  });

  it("refuses to cancel without an explicit reason", async () => {
    const tool = tools.getTool("executive.cancel_task")!;
    // Schema level: a missing or hand-wavy reason never reaches the store.
    expect(tool.inputSchema.safeParse({ taskId: "tsk_x" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ taskId: "tsk_x", reason: "too short" }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ taskId: "tsk_x", reason: "Incident resolved; the task no longer serves the business." }).success,
    ).toBe(true);
    // Runtime level: an unknown task is refused, never silently ignored.
    await expect(
      tool.run(
        { store, env: {}, audit: () => {} } as never,
        { taskId: "tsk_whatever", reason: "Incident resolved 2026-10-03; obsolete." } as never,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("seeded the two commercial roles the audit found missing", () => {
    const roles = store.listOrgRoles({});
    const ids = roles.map((r) => r.id);
    expect(ids).toContain("role_marketing_content");
    expect(ids).toContain("role_support_operations");
    const marketing = roles.find((r) => r.id === "role_marketing_content")!;
    expect(marketing.department_id).toBe("dept_commercial");
    expect(marketing.capabilities_json).toContain("email_campaigns");
  });

  it("prunes stale untitled sessions but keeps titled, recent and default ones", () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const msg = (id: string, session: string, at: string) => ({
      id,
      session_id: session,
      role: "user" as const,
      content: "x",
      created_at: at,
      updated_at: at,
      source: "founder",
    });
    store.insertChatMessage(msg("m_old_untitled", "chat_junk_old", old) as never);
    store.insertChatMessage(msg("m_old_titled", "chat_titled_old", old) as never);
    store.setChatSessionTitle("chat_titled_old", "Real incident review", "founder");
    store.insertChatMessage(msg("m_recent_untitled", "chat_recent_junk", recent) as never);
    store.insertChatMessage(msg("m_default", "default", old) as never);

    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const stale = store.listChatSessionsToPrune(cutoff, true);
    expect(stale).toContain("chat_junk_old");
    expect(stale).not.toContain("chat_titled_old"); // the founder named it — keep
    expect(stale).not.toContain("chat_recent_junk"); // too recent
    expect(stale).not.toContain("default"); // the founder's main thread

    // With onlyUntitled=false the named old session becomes eligible too.
    const allOld = store.listChatSessionsToPrune(cutoff, false);
    expect(allOld).toContain("chat_titled_old");
    expect(allOld).not.toContain("default");
  });

  it("marketing.waitlist_stats counts the real waitlist from the KV binding", async () => {
    const kv = {
      list: async ({ prefix }: { prefix?: string }) => ({
        keys: [
          { name: "waitlist:ztame:a@example.com" },
          { name: "waitlist:ztame:b@example.com" },
          { name: "waitlist:zscorch:c@example.com" },
          { name: "waitlist:zscorch:d@example.com" },
          { name: "waitlist:zscorch:e@example.com" },
        ].filter((k) => !prefix || k.name.startsWith(prefix)),
        list_complete: true,
      }),
    };
    const tool = tools.getTool("marketing.waitlist_stats")!;
    const out = (await tool.run({ store, env: { ZARLINO_KV: kv }, audit: () => {} } as never, {})) as {
      configured: boolean;
      total: number;
      byTopic: Record<string, number>;
    };
    expect(out.configured).toBe(true);
    expect(out.total).toBe(5);
    expect(out.byTopic.ztame).toBe(2);
    expect(out.byTopic.zscorch).toBe(3);
  });
});
