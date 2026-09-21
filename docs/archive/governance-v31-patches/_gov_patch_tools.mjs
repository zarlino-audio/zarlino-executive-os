/**
 * Patch: closed-loop governance in the tool registry.
 *
 *   - projects.update_task   -> terminal statuses go through setTaskStatus()
 *   - projects.complete_task -> DONE goes through setTaskStatus()
 *   - projects.add_task_evidence + projects.list_task_evidence (new tools)
 *
 * The registry is what the cloud agent calls, so this is where "mark it done"
 * stops being a one-word assertion. CRLF file, strict anchors, idempotent.
 */
import fs from "node:fs";

const FILE = "src/agent/tools.ts";
const EOL = "\r\n";
let s = fs.readFileSync(FILE, "utf8");

if (s.includes("projects.add_task_evidence")) {
  console.log("already patched - no change");
  process.exit(0);
}

function mustReplace(haystack, needle, replacement, label) {
  if (!haystack.includes(needle)) {
    console.error(`ANCHOR NOT FOUND: ${label}`);
    process.exit(1);
  }
  return haystack.replace(needle, replacement);
}

// 1. import the gate
s = mustReplace(
  s,
  'import { createTask } from "../core/tasks/model";',
  [
    'import { createTask } from "../core/tasks/model";',
    "import {",
    "  EVIDENCE_KINDS,",
    "  isTerminalTaskStatus,",
    '} from "../core/tasks/evidence";',
  ].join(EOL),
  "createTask import",
);

// 2. schema for the evidence tool
s = mustReplace(
  s,
  "const taskIdSchema = z.object({ taskId: z.string().min(1) });",
  [
    "const taskIdSchema = z.object({ taskId: z.string().min(1) });",
    "const taskEvidenceSchema = z.object({",
    "  taskId: z.string().min(1),",
    "  kind: z.enum(EVIDENCE_KINDS),",
    '  locator: z.string().min(1).max(1000).describe("path, commit sha, review id, artifact id or url"),',
    '  summary: z.string().min(1).max(2000).describe("what this shows and how it was produced"),',
    "  verificationCommand: z.string().max(2000).optional(),",
    '  verificationOutput: z.string().max(20000).optional().describe("the RAW output - a claim without output is not evidence"),',
    "  verified: z.boolean().optional(),",
    "});",
  ].join(EOL),
  "taskIdSchema",
);

// 3. update_task: gate the terminal statuses
s = mustReplace(
  s,
  [
    "        const patch: Record<string, string> = {};",
    "        if (input.status) patch.status = input.status;",
    "        if (input.priority) patch.priority = input.priority;",
    "        if (input.dueDate) patch.due_date = input.dueDate;",
    "        store.updateTask(input.taskId, patch as never);",
    "        return { id: input.taskId, updated: true };",
  ].join(EOL),
  [
    "        // Closed-loop governance: a terminal status goes through the gate,",
    "        // which refuses DONE/CANCELLED without verifiable evidence.",
    "        if (input.status && isTerminalTaskStatus(input.status)) {",
    "          store.setTaskStatus(input.taskId, input.status, {",
    '            mode: input.overrideReason ? "founder_override" : undefined,',
    "            overrideReason: input.overrideReason,",
    "          });",
    "        }",
    "        const patch: Record<string, string> = {};",
    "        if (input.status && !isTerminalTaskStatus(input.status)) patch.status = input.status;",
    "        if (input.priority) patch.priority = input.priority;",
    "        if (input.dueDate) patch.due_date = input.dueDate;",
    "        store.updateTask(input.taskId, patch as never);",
    "        const evidence = store.listTaskEvidence(input.taskId);",
    "        return {",
    "          id: input.taskId,",
    "          updated: true,",
    "          status: store.getTask(input.taskId)?.status,",
    "          evidenceCount: evidence.length,",
    "        };",
  ].join(EOL),
  "projects.update_task body",
);

// 4. complete_task: gate DONE
s = mustReplace(
  s,
  [
    '        store.updateTask(input.taskId, { status: "DONE", completed_at: nowIso() } as never);',
    '        return { id: input.taskId, status: "DONE" };',
  ].join(EOL),
  [
    "        // The gate refuses DONE when the task carries no verifiable evidence",
    "        // (EVIDENCE_REQUIRED) - the exact failure mode this layer exists to",
    "        // make impossible.",
    '        const task = store.setTaskStatus(input.taskId, "DONE");',
    "        return { id: task.id, status: task.status, evidenceCount: store.listTaskEvidence(task.id).length };",
  ].join(EOL),
  "projects.complete_task body",
);

// 5. the two new tools, right after complete_task
const afterCompleteAnchor = [
  "        return { id: task.id, status: task.status, evidenceCount: store.listTaskEvidence(task.id).length };",
  "      },",
  "    },",
].join(EOL);

const snip = fs.readFileSync("scripts/_gov_snip_tools.txt", "utf8").replace(/\r?\n/g, EOL);
s = mustReplace(s, afterCompleteAnchor, afterCompleteAnchor + EOL + snip, "complete_task tail");

fs.writeFileSync(FILE, s);
const out = fs.readFileSync(FILE, "utf8");
const checks = {
  "add_task_evidence tool": out.includes('name: "projects.add_task_evidence"'),
  "list_task_evidence tool": out.includes('name: "projects.list_task_evidence"'),
  "update_task gated": out.includes("store.setTaskStatus(input.taskId, input.status, {"),
  "complete_task gated": out.includes('store.setTaskStatus(input.taskId, "DONE")'),
  "gate imported": out.includes("isTerminalTaskStatus"),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
