/**
 * Founder directive intake — the half of the CAO job that is not talking.
 *
 * The founder sends WhatsApp messages all day: some are questions, some are
 * decisions, and some are instructions ("Ztame Pro needs a wet/dry blend",
 * "get the site updated"). Questions get answered; instructions must land on
 * the task board with an owner, or they evaporate into chat history.
 *
 * Design rules (deliberately conservative):
 *   1. The CAO model only CLASSIFIES and drafts wording. It may not invent a
 *      role: every role id it proposes is validated against the org registry,
 *      and an unknown id falls back to the orchestrator (role_coa).
 *   2. A message must look imperative before we even ask the model, so ordinary
 *      chatting never spends a token on intake.
 *   3. If anything fails (model down, malformed JSON, store error) the caller
 *      still replies to the founder - intake is best-effort, never blocking.
 *   4. Every intake is audited with the founder's own words.
 */
import type { ExecutiveStore } from "../../db/store";
import { createTask } from "../tasks/model";
import { assignTask } from "../productivity/manager";
import { newId, nowIso } from "../../ids";

export interface IntakeEnv {
  AI?: unknown;
  CAO_AI_MODEL?: string;
}

export interface IntakeResult {
  taskId: string;
  title: string;
  acceptance: string;
  roleId: string;
  assignmentId: string | null;
}

/** Words that make a message an instruction rather than a conversation. */
const IMPERATIVE_HINTS = [
  "add ",
  "make ",
  "get ",
  "build ",
  "fix ",
  "ship ",
  "log ",
  "assign ",
  "prepare ",
  "draft ",
  "finish ",
  "start ",
  "update ",
  "write ",
  "check ",
  "review ",
  "schedule ",
  "need ",
  "should ",
  "must ",
  "please ",
  "task:",
  "todo",
];

/** Cheap gate: does this even look like an instruction? */
export function looksLikeDirective(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 12 || t.length > 1200) return false;
  // A question is never intake (the founder is asking, not instructing).
  if (t.endsWith("?")) return false;
  return IMPERATIVE_HINTS.some((h) => t.startsWith(h) || t.includes(` ${h}`));
}

const CAO_ROLE_ID = "role_coa";

interface Classification {
  directive: boolean;
  title: string;
  acceptance: string;
  role_id: string;
}

/**
 * Ask the CAO model to turn a founder message into a task shape. Returns null
 * when the model is unavailable, refuses, or answers with nonsense.
 */
export async function classifyDirective(
  store: ExecutiveStore,
  env: IntakeEnv,
  text: string,
  validRoleIds: string[],
): Promise<Classification | null> {
  const ai = (env as { AI?: { run: (m: string, i: unknown) => Promise<unknown> } }).AI;
  if (!ai) return null;
  const model = env.CAO_AI_MODEL ?? "@cf/deepseek-ai/deepseek-v4-pro-0813";
  const system =
    "You triage messages sent to the founder's chief of staff. Decide whether the message is an " +
    "INSTRUCTION to do work, or merely talk/a question. Reply with ONE JSON object, no prose, no fences:\n" +
    '{"directive": true|false, "title": "<= 120 chars, imperative", "acceptance": "<= 200 chars, how we know it is done", "role_id": "one of the allowed ids"}\n' +
    "Allowed role_id values: " +
    validRoleIds.join(", ") +
    `. If nothing fits, use ${CAO_ROLE_ID}. Never invent a role id. If it is not an instruction, directive=false and leave the other fields empty.`;
  try {
    const out = (await ai.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: text.slice(0, 1200) },
      ],
      reasoning_effort: "none",
      max_completion_tokens: 400,
      temperature: 0,
    })) as {
      response?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = out?.choices?.[0]?.message?.content ?? out?.response ?? "";
    const json = extractJson(typeof raw === "string" ? raw : "");
    if (!json) return null;
    const directive = json.directive === true;
    const title = typeof json.title === "string" ? json.title.trim().slice(0, 140) : "";
    const acceptance = typeof json.acceptance === "string" ? json.acceptance.trim().slice(0, 240) : "";
    const proposed = typeof json.role_id === "string" ? json.role_id.trim() : "";
    const roleId = validRoleIds.includes(proposed) ? proposed : CAO_ROLE_ID;
    if (!directive || !title) return null;
    return { directive, title, acceptance, role_id: roleId };
  } catch {
    return null;
  }
}

/** Pull the first JSON object out of a model answer, tolerating fences. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Put a founder directive on the board: create the task, attach the acceptance
 * criterion as its success condition, and assign it to the owning role.
 */
export function createIntakeTask(
  store: ExecutiveStore,
  input: { title: string; acceptance: string; roleId: string; from: string },
): IntakeResult | null {
  try {
    const task = createTask({
      title: input.title,
      description: input.acceptance || undefined,
      success_condition: input.acceptance || undefined,
      source: "founder_whatsapp",
    });
    store.insertTask(task);
    let assignmentId: string | null = null;
    try {
      assignmentId = assignTask(store, task.id, {
        roleId: input.roleId,
        note: `From the founder on WhatsApp: "${input.title}"`,
      });
    } catch {
      // Assignment is best effort: the task is still on the board.
      assignmentId = null;
    }
    store.insertAudit({
      id: newId("aud"),
      actor: "cao_agent_01",
      action: "cao.directive_intake",
      entity_type: "tasks",
      entity_id: task.id,
      detail_json: JSON.stringify({
        from: input.from,
        title: input.title,
        acceptance: input.acceptance,
        role_id: input.roleId,
        assignment: assignmentId,
      }),
      source: "runtime",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    return { taskId: task.id, title: task.title, acceptance: input.acceptance, roleId: input.roleId, assignmentId };
  } catch {
    return null;
  }
}

/** The confirmation the founder gets, in the CAO voice. */
export function intakeConfirmation(result: IntakeResult, roleName?: string): string {
  const owner = roleName ? roleName : result.roleId.replace(/^role_/, "").replace(/_/g, " ");
  const bits = [`On the board: ${result.title} - owned by ${owner}.`];
  if (result.acceptance) bits.push(`I'll call it done when: ${result.acceptance}`);
  return bits.join(" ");
}

/**
 * Full intake path for one founder message. Returns null when the message is
 * not an instruction (or intake failed) - the caller then answers normally.
 */
export async function intakeFounderDirective(
  store: ExecutiveStore,
  env: IntakeEnv,
  text: string,
  from: string,
): Promise<{ result: IntakeResult; reply: string } | null> {
  if (!looksLikeDirective(text)) return null;
  const roles = store.listOrgRoles();
  const validRoleIds = roles.map((r) => r.id);
  if (validRoleIds.length === 0) return null;
  const cls = await classifyDirective(store, env, text, validRoleIds);
  if (!cls) return null;
  const result = createIntakeTask(store, {
    title: cls.title,
    acceptance: cls.acceptance,
    roleId: cls.role_id,
    from,
  });
  if (!result) return null;
  const roleName = roles.find((r) => r.id === result.roleId)?.name;
  return { result, reply: intakeConfirmation(result, roleName) };
}
