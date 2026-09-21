/**
 * Patch: taskUpdateSchema gains the explicit override reason.
 *
 * Without it there is no way to close a task that genuinely cannot produce
 * evidence (e.g. "cancelled - superseded"), and people would just stop using
 * the gate. The reason is validated (min length) inside the gate itself and
 * persisted on the task as close_reason.
 */
import fs from "node:fs";

const FILE = "src/agent/tools.ts";
const EOL = "\r\n";
let s = fs.readFileSync(FILE, "utf8");

if (s.includes("overrideReason")) {
  console.log("already patched - no change");
  process.exit(0);
}

const anchor = [
  "const taskUpdateSchema = z.object({",
  '  taskId: z.string().min(1),',
  '  status: z.enum(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]).optional(),',
  "  priority: z.enum([\"P0\", \"P1\", \"P2\", \"P3\"]).optional(),",
  "  dueDate: z.string().optional(),",
  "});",
].join(EOL);

if (!s.includes(anchor)) {
  console.error("ANCHOR NOT FOUND: taskUpdateSchema");
  process.exit(1);
}

const replacement = [
  "const taskUpdateSchema = z.object({",
  '  taskId: z.string().min(1),',
  '  status: z.enum(["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"]).optional(),',
  '  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),',
  "  dueDate: z.string().optional(),",
  "  // Closed-loop governance: the ONLY way to reach DONE/CANCELLED without",
  "  // evidence. Requires a written reason (>= 10 chars), stored as the task's",
  "  // close_reason so an override is visible, never disguised as verification.",
  "  overrideReason: z.string().min(10).max(1000).optional(),",
  "});",
].join(EOL);

s = s.replace(anchor, replacement);
fs.writeFileSync(FILE, s);
console.log("OK  taskUpdateSchema.overrideReason:", s.includes("overrideReason: z.string().min(10)"));
