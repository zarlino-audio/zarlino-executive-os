/**
 * Patch: task-level governance fields + TaskEvidence type re-export.
 *
 *   - Task.close_reason: the founder's written reason when a task was closed
 *     through the explicit override instead of on verified evidence.
 *   - TaskEvidence is re-exported from core/tasks/evidence so consumers have a
 *     single import site for "what a task is allowed to claim".
 */
import fs from "node:fs";

const FILE = "src/types.ts";
const EOL = "\r\n";
let s = fs.readFileSync(FILE, "utf8");

if (s.includes("close_reason")) {
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

// 1. close_reason on Task, next to completed_at.
s = mustReplace(
  s,
  ["  completed_at?: string;", "  // Task contract (AOrgI migration v23)"].join(EOL),
  [
    "  completed_at?: string;",
    "  // Closed-loop governance (migration v31): only set when the task was",
    "  // closed via the explicit founder override rather than verified evidence.",
    "  close_reason?: string;",
    "  // Task contract (AOrgI migration v23)",
  ].join(EOL),
  "Task.completed_at",
);

// 2. Re-export the evidence model at the type surface.
s = mustReplace(
  s,
  'export type TaskStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";',
  [
    'export type TaskStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";',
    "",
    "// Closed-loop governance: the evidence model a task's DONE state depends on.",
    'export type { TaskEvidence, EvidenceKind, VerificationMode } from "./core/tasks/evidence";',
  ].join(EOL),
  "TaskStatus union",
);

fs.writeFileSync(FILE, s);
const out = fs.readFileSync(FILE, "utf8");
const checks = {
  "close_reason on Task": out.includes("close_reason?: string;"),
  "TaskEvidence re-exported": out.includes("TaskEvidence"),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
