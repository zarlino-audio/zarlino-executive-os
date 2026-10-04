/**
 * Founder directive intake.
 *
 * The founder's instructions arrive over WhatsApp. They must land on the task
 * board with an owner - and they must never be invented by a model: role ids
 * are validated against the org registry, and anything malformed means "not an
 * instruction", so the founder gets a normal answer instead of a fake task.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import {
  looksLikeDirective,
  classifyDirective,
  createIntakeTask,
  intakeConfirmation,
  intakeFounderDirective,
} from "../src/core/org/intake";
import { handleInboundWhatsApp } from "../src/core/org/founder-channel";

const FOUNDER = "+233546778438";

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

/** AI stub that returns a fixed classification payload. */
function aiSaying(content: string): { run: () => Promise<unknown> } {
  return { run: async () => ({ choices: [{ message: { content } }] }) };
}

describe("looksLikeDirective (the cheap gate)", () => {
  it("accepts instructions", () => {
    expect(looksLikeDirective("add a wet/dry blend to Ztame Pro")).toBe(true);
    expect(looksLikeDirective("please finish the songwriting platform this week")).toBe(true);
    expect(looksLikeDirective("make ZScorch free")).toBe(true);
  });
  it("rejects questions and chatter", () => {
    expect(looksLikeDirective("what is on the board?")).toBe(false);
    expect(looksLikeDirective("how is it going")).toBe(false);
    expect(looksLikeDirective("hey")).toBe(false);
    expect(looksLikeDirective("thanks!")).toBe(false);
  });
});

describe("classifyDirective", () => {
  const roles = ["role_coa", "role_product_manager", "role_dsp_engineering"];

  it("returns a task shape for an instruction", async () => {
    const cls = await classifyDirective(
      store,
      { AI: aiSaying('{"directive": true, "title": "Add wet/dry blend to Ztame Pro", "acceptance": "Blend control audibly mixes clean and processed signal", "role_id": "role_dsp_engineering"}') },
      "add a wet/dry blend to Ztame Pro",
      roles,
    );
    expect(cls?.title).toBe("Add wet/dry blend to Ztame Pro");
    expect(cls?.role_id).toBe("role_dsp_engineering");
  });

  it("never invents a role: unknown ids fall back to the orchestrator", async () => {
    const cls = await classifyDirective(
      store,
      { AI: aiSaying('{"directive": true, "title": "Do a thing", "acceptance": "done", "role_id": "role_ceo_of_everything"}') },
      "please do a thing now",
      roles,
    );
    expect(cls?.role_id).toBe("role_coa");
  });

  it("ignores a model answer that is not a directive", async () => {
    const cls = await classifyDirective(
      store,
      { AI: aiSaying('{"directive": false, "title": "", "acceptance": "", "role_id": "role_coa"}') },
      "how are things",
      roles,
    );
    expect(cls).toBeNull();
  });

  it("survives fenced or chatty JSON, and garbage", async () => {
    const fenced = await classifyDirective(
      store,
      { AI: aiSaying('Sure! ```json\n{"directive": true, "title": "Cut ZScorch to three knobs", "acceptance": "UI shows three controls", "role_id": "role_product_manager"}\n```') },
      "cut ZScorch to three knobs",
      roles,
    );
    expect(fenced?.title).toBe("Cut ZScorch to three knobs");
    const garbage = await classifyDirective(store, { AI: aiSaying("I cannot help with that") }, "add something", roles);
    expect(garbage).toBeNull();
  });

  it("returns null when no binding is present", async () => {
    expect(await classifyDirective(store, {}, "add a thing", roles)).toBeNull();
  });
});

describe("createIntakeTask", () => {
  it("puts the task on the board, assigns an owner and audits it", () => {
    const result = createIntakeTask(store, {
      title: "Ship the ZScorch free tier",
      acceptance: "Download works without a licence key",
      roleId: "role_product_manager",
      from: FOUNDER,
    });
    expect(result?.taskId).toMatch(/^tsk_/);
    const task = store.getTask(result!.taskId);
    expect(task?.title).toBe("Ship the ZScorch free tier");
    expect(task?.success_condition).toBe("Download works without a licence key");
    expect(task?.source).toBe("founder_whatsapp");
    expect(result?.assignmentId).toBeTruthy();
    const audit = store.auditForEntity("tasks", result!.taskId, 10);
    expect(audit.some((a) => a.action === "cao.directive_intake")).toBe(true);
  });

  it("writes the confirmation in plain words", () => {
    const text = intakeConfirmation(
      { taskId: "tsk_x", title: "Fix the installer", acceptance: "It runs on a clean VM", roleId: "role_dsp_engineering", assignmentId: null },
      "DSP Engineering",
    );
    expect(text).toContain("Fix the installer");
    expect(text).toContain("DSP Engineering");
    expect(text).toContain("It runs on a clean VM");
  });
});

describe("intakeFounderDirective", () => {
  it("does nothing for a question", async () => {
    const before = store.listTasks({ limit: 100 }).length;
    const out = await intakeFounderDirective(store, { AI: aiSaying('{"directive": true, "title": "x", "acceptance": "", "role_id": "role_coa"}') }, "what's blocked?", FOUNDER);
    expect(out).toBeNull();
    expect(store.listTasks({ limit: 100 }).length).toBe(before);
  });

  it("does not guess when the model refuses", async () => {
    const before = store.listTasks({ limit: 100 }).length;
    const out = await intakeFounderDirective(store, {}, "add a second compressor plugin", FOUNDER);
    expect(out).toBeNull();
    expect(store.listTasks({ limit: 100 }).length).toBe(before);
  });
});

describe("founder inbound path", () => {
  it("turns an instruction into a task and answers with the confirmation", async () => {
    const before = store.listTasks({ limit: 200 }).length;
    const env = {
      WHATSAPP_FOUNDER_NUMBER: FOUNDER,
      AI: aiSaying('{"directive": true, "title": "Publish the songwriting platform", "acceptance": "It is live on zarlinoaudio.com", "role_id": "role_product_manager"}'),
    };
    const r = await handleInboundWhatsApp(store, env, { from: FOUNDER, name: "Founder", text: "please publish the songwriting platform this week", messageId: `m-${Date.now()}` });
    expect(r.role).toBe("FOUNDER");
    expect(r.reply).toContain("Publish the songwriting platform");
    expect(store.listTasks({ limit: 200 }).length).toBe(before + 1);
  });

  it("still answers questions normally", async () => {
    const env = { WHATSAPP_FOUNDER_NUMBER: FOUNDER };
    const r = await handleInboundWhatsApp(store, env, { from: FOUNDER, name: "Founder", text: "how many tasks are open?", messageId: `q-${Date.now()}` });
    expect(r.role).toBe("FOUNDER");
    expect(r.reply.length).toBeGreaterThan(0);
    expect(r.duplicate).toBe(false);
  });

  it("keeps strangers out of everything", async () => {
    const before = store.listTasks({ limit: 200 }).length;
    const env = {
      WHATSAPP_FOUNDER_NUMBER: FOUNDER,
      AI: aiSaying('{"directive": true, "title": "Wire me money", "acceptance": "", "role_id": "role_coa"}'),
    };
    const r = await handleInboundWhatsApp(store, env, { from: "+15550001111", name: "Nobody", text: "please add a task to send me money", messageId: `s-${Date.now()}` });
    expect(r.role).toBe("STRANGER");
    expect(store.listTasks({ limit: 200 }).length).toBe(before);
  });
});
