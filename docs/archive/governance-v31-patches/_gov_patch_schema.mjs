import fs from "fs";

let s = fs.readFileSync("src/db/schema.ts", "utf8");
const stamp = "\nexport { TASK_EVIDENCE_SQL } from " + JSON.stringify("./task-evidence-schema") + ";\n";
if (!s.includes("TASK_EVIDENCE_SQL")) s += stamp;
s = s.split("SCHEMA_VERSION = 30").join("SCHEMA_VERSION = 31");
fs.writeFileSync("src/db/schema.ts", s);

let m = fs.readFileSync("src/db/migrations.ts", "utf8");
if (!m.includes("  TASK_EVIDENCE_SQL,")) m = m.replace("  CHAT_ENHANCE_SQL,", "  CHAT_ENHANCE_SQL,\n  TASK_EVIDENCE_SQL,");
const line = '{ version: 31, name: "task_evidence", sql: [TASK_EVIDENCE_SQL] },';
if (!m.includes("version: 31")) {
  m = m.replace(
    '{ version: 30, name: "chat_enhance", sql: [CHAT_ENHANCE_SQL] },',
    '{ version: 30, name: "chat_enhance", sql: [CHAT_ENHANCE_SQL] },\n  ' + line,
  );
}
fs.writeFileSync("src/db/migrations.ts", m);

const s2 = fs.readFileSync("src/db/schema.ts", "utf8");
const m2 = fs.readFileSync("src/db/migrations.ts", "utf8");
console.log("schema version:", (s2.match(/SCHEMA_VERSION = \d+/) || [])[0]);
console.log("schema exports TASK_EVIDENCE_SQL:", s2.includes("TASK_EVIDENCE_SQL"));
console.log("migrations imports TASK_EVIDENCE_SQL:", m2.includes("  TASK_EVIDENCE_SQL,"));
console.log("migrations registered v31:", m2.includes("version: 31, name: \"task_evidence\""));
