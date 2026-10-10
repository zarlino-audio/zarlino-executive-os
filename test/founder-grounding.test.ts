/**
 * Founder-facing CEO grounding — regression suite (2026-10-12).
 *
 * Reproduces the real WhatsApp failure: ZTame questions must be answered from
 * ZTame-scoped OS records, never blended with Zarlino Source blockers or
 * invented from model inference; corrections must stick; pronouns must
 * preserve the corrected referent; no fake asynchronous claims.
 *
 * Tests A–J per the reliability spec.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";
import { createTask } from "../src/core/tasks/model";
import { createApprovalRequest } from "../src/core/approvals/queue";
import { handleInboundWhatsApp } from "../src/core/org/founder-channel";
import {
  findEntities,
  loadFounderState,
  resolveFounderEntity,
  groundedFounderReply,
} from "../src/core/org/grounding";
import { newId, nowIso } from "../src/ids";

const FOUNDER = "233546778438";

let db: DatabaseSync;
let store: ExecutiveStore;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  store = new ExecutiveStore(createNodeSql(db as never));
  store.migrate();
  // Isolation: the schema seed ships real ZTame/ZScorch board rows. Close
  // them so each test sees ONLY its own fixtures (the retrieval itself is
  // exercised against live-shaped data via the production validation).
  for (const t of store.listTasks({ limit: 500 })) {
    if (/ztame|zscorch/i.test(t.title) && t.status !== "DONE" && t.status !== "CANCELLED") {
      store.updateTask(t.id, { status: "CANCELLED" } as never);
    }
  }
});
afterEach(() => {
  db.close();
});

function seedTask(title: string, status: string, opts: { objectiveId?: string; closeReason?: string } = {}): string {
  const task = createTask({ title, source: "test", objective_id: opts.objectiveId });
  store.insertTask(task);
  const patch: Record<string, unknown> = { status };
  if (opts.closeReason) patch.close_reason = opts.closeReason;
  store.updateTask(task.id, patch as never);
  return task.id;
}

function seedObjective(title: string, criteria?: string): string {
  const id = newId("obj");
  const at = nowIso();
  store.insertObjective({
    id,
    title,
    status: "ACTIVE",
    priority: 2,
    source: "test",
    criteria_json: criteria,
    created_at: at,
    updated_at: at,
  });
  return id;
}

function seedRun(taskId: string, status: string, conclusion?: string, url?: string): string {
  const id = newId("rrun");
  const at = nowIso();
  store.createRemoteRun({
    id,
    task_id: taskId,
    repo: "zarlino-audio/Zarlino",
    workflow_file: "ztame-release-gate.yml",
    ref: "main",
    status,
    conclusion,
    run_url: url,
    dispatched_at: at,
    source: "test",
    created_at: at,
    updated_at: at,
  });
  return id;
}

async function ask(text: string, env: Record<string, unknown> = {}, messageId?: string): Promise<string> {
  const r = await handleInboundWhatsApp(store, env as never, {
    from: FOUNDER,
    name: "Founder",
    text,
    messageId: messageId ?? `wm_${Math.random().toString(36).slice(2, 12)}`,
  });
  return r.reply;
}

describe("entity resolution", () => {
  it("distinguishes ZTame from Zarlino Source (similarity is not identity)", () => {
    const ztame = findEntities(store, "what's the current engineering effort towards ZTame");
    expect(ztame.map((h) => h.def.label)).toEqual(["ZTame"]);
    const source = findEntities(store, "what's happening with Zarlino Source?");
    expect(source.map((h) => h.def.label)).toEqual(["Zarlino Source"]);
    const company = findEntities(store, "how is Zarlino Audio doing");
    expect(company.map((h) => h.def.label)).toEqual(["Zarlino Audio"]);
  });

  it("correction picks the entity after the marker; disowning clears the referent", () => {
    const state = { activeEntity: null, activeLabel: null, updatedAt: nowIso() };
    const corrected = resolveFounderEntity(store, "That's Source. I'm talking about ZTame.", state);
    expect(corrected.source).toBe("correction");
    expect(corrected.entity?.label).toBe("ZTame");

    const activeSource = { activeEntity: "ent_source", activeLabel: "Zarlino Source", updatedAt: nowIso() };
    const disowned = resolveFounderEntity(store, "Not Source.", activeSource);
    expect(disowned.source).toBe("correction");
    expect(disowned.entity).toBeNull();
  });
});

describe("founder channel grounding (tests A–J)", () => {
  it("A/F — ZTame question answers from ZTame records only; Source blocker never leaks", async () => {
    const ztameTask = seedTask("ZTame P8 suppression-quality verification", "IN_PROGRESS");
    seedTask("Zarlino Source separator weights — checkpoint decision", "BLOCKED", {
      closeReason: "blocked: model checkpoint licensing undecided",
    });
    store.insertApproval(
      createApprovalRequest({
        action_label: "Zarlino Source separator model weights — licence + artifact-store decision",
        reason: "rights + storage",
      }),
    );

    const reply = await ask("What's the current engineering effort towards ZTame?");
    expect(reply).toContain("ZTame");
    expect(reply).toContain(ztameTask);
    expect(reply).toMatch(/in_progress/i);
    // The SOURCE blocker (checkpoint/separator/weights) must never appear —
    // even though its approval label also says "licence", and even though
    // ZTame itself legitimately has a signing/licence task.
    expect(reply).not.toMatch(/checkpoint/i);
    expect(reply).not.toMatch(/separator/i);
    expect(reply).not.toMatch(/weights/i);
    expect(reply).not.toMatch(/zarlino source/i);

    // The mirrored control: the Source question may see its own blocker.
    const sourceReply = await ask("What's happening with Zarlino Source?");
    expect(sourceReply).toMatch(/checkpoint|blocked/i);
  });

  it("B/C — the correction sticks and the pronoun follows it", async () => {
    const ztameTask = seedTask("ZTame P8 suppression-quality verification", "IN_PROGRESS");
    seedTask("Zarlino Source separator weights — checkpoint decision", "BLOCKED", {
      closeReason: "blocked: model checkpoint licensing undecided",
    });

    await ask("What's happening with Zarlino Source?");
    await ask("That's Source. I'm talking about ZTame.");
    expect(loadFounderState(store).activeLabel).toBe("ZTame");

    const reply = await ask("What's the current engineering effort on it?");
    expect(reply).toContain(ztameTask);
    expect(reply).toMatch(/in_progress/i);
    expect(reply).not.toMatch(/checkpoint/i);
    expect(reply).not.toMatch(/separator/i);
  });

  it("D — no ZTame records produces an honest 'nothing active' answer, no invented blocker", async () => {
    const reply = await ask("What's happening with ZTame?");
    expect(reply).toMatch(/nothing active on ZTame/i);
    expect(reply).not.toMatch(/blocked/i);
    expect(reply).not.toMatch(/checkpoint/i);
  });

  it("E — a real recorded blocker is reported accurately", async () => {
    seedTask("ZTame P8 founder listening test", "BLOCKED", { closeReason: "waiting on the founder's A/B listen" });
    const reply = await ask("What's blocking ZTame?");
    expect(reply).toContain("ZTame P8 founder listening test");
    expect(reply).toMatch(/blocker/i);
  });

  it("G — no fake asynchronous 'checking' language survives", async () => {
    const aiStub = { AI: { run: async () => ({ choices: [{ message: { content: "Let me check and get back to you." } }] }) } };
    const reply = await ask("Tell me a fun fact about audio.", aiStub);
    expect(reply).not.toMatch(/check/i);
    expect(reply).not.toMatch(/get back/i);
    expect(reply.length).toBeGreaterThan(10);
  });

  it("H — an IN_PROGRESS remote run is reported as in progress, never done", async () => {
    const taskId = seedTask("ZTame v1.2.0 release gate", "IN_PROGRESS");
    seedRun(taskId, "IN_PROGRESS");
    const reply = await ask("Where are we on the ZTame release gate?");
    expect(reply).toMatch(/in_progress/i);
    expect(reply).not.toMatch(/completed/i);
    expect(reply).not.toMatch(/done/i);
  });

  it("I — a FAILED remote run is reported as a failure with its id; nothing is called achieved", async () => {
    const taskId = seedTask("ZTame v1.2.0 release gate", "IN_PROGRESS");
    seedRun(taskId, "FAILED", "failure", "https://github.com/zarlino-audio/Zarlino/actions/runs/1");
    const reply = await ask("What's the status of the ZTame release gate?");
    expect(reply).toMatch(/FAILED/);
    expect(reply).not.toMatch(/completed success/i);
    expect(reply).not.toMatch(/objective complete/i);
  });

  it("J — a completed workflow does not make the objective complete", async () => {
    const objectiveId = seedObjective("ZTame v1.2.0 release readiness", "gate passes + documentation updated");
    const taskId = seedTask("ZTame v1.2.0 release gate", "IN_PROGRESS", { objectiveId });
    seedHelperEvidence(taskId);
    seedRun(taskId, "COMPLETED", "success", "https://github.com/zarlino-audio/Zarlino/actions/runs/2");
    const reply = await ask("Is ZTame ready to release?");
    expect(reply).toMatch(/completed success/i);
    expect(reply).toMatch(/open item/i);
    expect(reply).not.toMatch(/release-ready|ready to ship|all done|objective complete/i);
  });

  it("grounded answers are audited with resolution source and counts", async () => {
    seedTask("ZTame P8 suppression-quality verification", "IN_PROGRESS");
    await ask("What's the current engineering effort towards ZTame?");
    const audits = store.listAudit(20).filter((a) => a.action === "whatsapp.grounded_answer");
    expect(audits.length).toBeGreaterThan(0);
    const detail = JSON.parse(String(audits[0]!.detail_json ?? "{}")) as { entity?: string; resolution_source?: string; grounded?: boolean };
    expect(detail.entity).toBe("ZTame");
    expect(detail.resolution_source).toBe("explicit");
    expect(detail.grounded).toBe(true);
  });
});

/** Evidence helper: a verified review item (passes the evidence validator). */
function seedHelperEvidence(taskId: string): void {
  store.addTaskEvidence(taskId, {
    kind: "review",
    locator: "review://ztame-gate",
    summary: "Gate review recorded for the grounding test",
    verification_output: "listening notes: pass across 3 blind passes",
    verified: true,
    source: "test",
  });
}

describe("groundedFounderReply direct API", () => {
  it("returns grounded=false for non-operational chat and keeps the referent", () => {
    seedTask("ZTame P8 suppression-quality verification", "IN_PROGRESS");
    const first = groundedFounderReply(store, "morning! how are you");
    expect(first.grounded).toBe(false);
    const second = groundedFounderReply(store, "cool. what's the latest on ZTame?");
    expect(second.grounded).toBe(true);
    expect(second.status?.entity).toBe("ZTame");
  });
});
