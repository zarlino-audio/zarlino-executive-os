/**
 * Patch: task HTTP routes for the closed-loop evidence gate.
 *   GET    /api/tasks                 -> each task carries evidence {total,verified}
 *   GET    /api/tasks/:id             -> task + evidence + close_reason
 *   PATCH  /api/tasks/:id             -> terminal status via setTaskStatus()
 *   GET    /api/tasks/:id/evidence    -> the evidence a task rests on
 *   POST   /api/tasks/:id/evidence    -> attach evidence (validated)
 *   DELETE /api/tasks/evidence/:id    -> remove a wrong item
 * CRLF file, strict anchors, idempotent.
 */
import fs from "node:fs";

const FILE = "src/index.ts";
const EOL = "\r\n";
let s = fs.readFileSync(FILE, "utf8");

if (s.includes("/evidence") && s.includes("taskEvidenceRoute")) {
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

// 1. GET /api/tasks carries the evidence count (list rendering).
s = mustReplace(
  s,
  [
    '    if (path === "/api/tasks" && method === "GET") {',
    "      return json({ tasks: this.store.listTasks({ limit: 100 }).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, project_id: t.project_id, created_at: t.created_at })) });",
    "    }",
  ].join(EOL),
  [
    '    if (path === "/api/tasks" && method === "GET") {',
    "      const counts = this.store.countTaskEvidence();",
    "      return json({",
    "        tasks: this.store.listTasks({ limit: 100 }).map((t) => ({",
    "          id: t.id,",
    "          title: t.title,",
    "          status: t.status,",
    "          priority: t.priority,",
    "          project_id: t.project_id,",
    "          close_reason: t.close_reason ?? null,",
    "          evidence: counts[t.id] ?? { total: 0, verified: 0 },",
    "          created_at: t.created_at,",
    "        })),",
    "      });",
    "    }",
  ].join(EOL),
  "GET /api/tasks",
);

// 2. replace the old PATCH-only task block with the gated block + evidence routes.
const oldBlock = [
  "    const taskPatch = /^\\/api\\/tasks\\/([^/]+)$/.exec(path);",
  '    if (taskPatch && method === "PATCH") {',
  "      const id = decodeURIComponent(taskPatch[1]!);",
  "      const task = this.store.getTask(id);",
  '      if (!task) return json({ error: "Task not found" }, 404);',
  "      const body = (await readBody<{ status?: string; priority?: string }>(request).catch(() => ({}))) as { status?: string; priority?: string };",
  "      const patch: Partial<Task> = {};",
  "      if (body.status) {",
  '        if (!["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"].includes(body.status)) return json({ error: "Invalid status" }, 400);',
  "        patch.status = body.status as never;",
  '        if (body.status === "DONE") patch.completed_at = nowIso();',
  "      }",
  '      if (body.priority && ["P0", "P1", "P2", "P3"].includes(body.priority)) patch.priority = body.priority as never;',
  "      this.store.updateTask(id, patch);",
  "      return json({ ok: true });",
  "    }",
].join(EOL);

const snip = fs.readFileSync("scripts/_gov_snip_index.txt", "utf8").replace(/\r?\n/g, EOL);
s = mustReplace(s, oldBlock, snip, "task PATCH block");

// 3. import the gate predicate.
s = mustReplace(
  s,
  'import { newId, nowIso } from "./core/ids";',
  [
    'import { newId, nowIso } from "./core/ids";',
    'import { isTerminalTaskStatus, GovernanceError } from "./core/tasks/evidence";',
  ].join(EOL),
  "ids import",
);

// 4. internal auto-run DONE transition (line ~672) must obey the same gate.
s = mustReplace(
  s,
  '    if (run.task_id) store.updateTask(run.task_id, { status: "DONE", completed_at: nowIso() } as never);',
  [
    "    if (run.task_id) {",
    "      // Closed-loop governance: the autonomous sweep obeys the same gate as",
    "      // every other caller. If the run produced no evidence, the task stays",
    "      // open (and the run note says so) instead of silently claiming DONE.",
    "      try {",
    '        store.setTaskStatus(run.task_id, "DONE");',
    "      } catch (gateErr) {",
    "        const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);",
    "        store.finishAgentRun(run.id, \"DONE\", result.text, `Task left OPEN by the evidence gate: ${msg}`);",
    "      }",
    "    }",
  ].join(EOL),
  "auto-run DONE transition",
);

fs.writeFileSync(FILE, s);
const out = fs.readFileSync(FILE, "utf8");
const checks = {
  "GET /api/tasks evidence counts": out.includes("countTaskEvidence()"),
  "GET task with evidence": out.includes("getTaskWithEvidence(id)"),
  "PATCH gated": out.includes("this.store.setTaskStatus(id, body.status, {"),
  "evidence POST route": out.includes("taskEvidenceRoute"),
  "evidence DELETE route": out.includes("taskEvidenceDelete"),
  "auto-run gated": out.includes('store.setTaskStatus(run.task_id, "DONE")'),
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
