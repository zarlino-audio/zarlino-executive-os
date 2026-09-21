/**
 * One-shot patcher: wires the closed-loop evidence gate into ExecutiveStore.
 *
 *   - imports the gate from src/core/tasks/evidence
 *   - inserts the evidence CRUD + setTaskStatus() backstop after updateTask()
 *   - adds task_evidence to SNAPSHOT_TABLES (evidence survives backup/restore)
 *   - adds the taskEvidenceRow() SQL -> boolean mapper
 *
 * store.ts is CRLF; anchors are written with \r\n and the script FAILS LOUDLY
 * (non-zero exit, no write) if any anchor is missing, so it can never
 * half-patch the file. Idempotent on re-run.
 */
import fs from "node:fs";

const FILE = "src/db/store.ts";
const EOL = "\r\n";
let s = fs.readFileSync(FILE, "utf8");

if (s.includes("setTaskStatus(")) {
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

// 1. imports
s = mustReplace(
  s,
  'import { migrate } from "./migrations";',
  [
    'import { migrate } from "./migrations";',
    "import {",
    "  assertCanTransitionTask,",
    "  GovernanceError,",
    "  isTerminalTaskStatus,",
    "  validateEvidence,",
    "  type EvidenceInput,",
    "  type TaskEvidence,",
    "  type VerificationMode,",
    '} from "../core/tasks/evidence";',
  ].join(EOL),
  "import block",
);

// 2. the evidence section, inserted right after updateTask()
const anchor = [
  "  updateTask(id: string, patch: Partial<Task>): void {",
  '    this.update("tasks", id, patch as Row);',
  "  }",
  "",
].join(EOL);
const snip = fs.readFileSync("scripts/_gov_snip_store.txt", "utf8").replace(/\r?\n/g, EOL);
s = mustReplace(s, anchor, anchor + snip, "updateTask block");

// 3. snapshots must carry the evidence
const snapAnchor =
  '  "tasks", "decisions", "approval_requests", "risks", "metrics", "financial_snapshots",';
s = mustReplace(s, snapAnchor, snapAnchor + EOL + '  "task_evidence",', "SNAPSHOT_TABLES");

// 4. SQLite has no booleans: `verified` must come back as a real boolean or the
//    gate would treat the string "0" as truthy and let anything through.
const rowAnchor = "function rowTo<T>(row: Row | undefined): T {";
s = mustReplace(
  s,
  rowAnchor,
  [
    "/** Map a task_evidence row: `verified` is stored as 0/1 in SQLite. */",
    "function taskEvidenceRow(row: Row): TaskEvidence {",
    "  const rec = rowTo<TaskEvidence>(row) as TaskEvidence & { verified: unknown };",
    "  return { ...rec, verified: Number(rec.verified ?? 0) === 1 };",
    "}",
    "",
    rowAnchor,
  ].join(EOL),
  "rowTo() location",
);

fs.writeFileSync(FILE, s);
const out = fs.readFileSync(FILE, "utf8");
const checks = {
  "setTaskStatus present": out.includes("setTaskStatus("),
  "addTaskEvidence present": out.includes("addTaskEvidence("),
  "taskEvidenceRow present": out.includes("function taskEvidenceRow("),
  "task_evidence in SNAPSHOT_TABLES": /"task_evidence",/.test(out),
  "gate imported": out.includes("assertCanTransitionTask"),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
