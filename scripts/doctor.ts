/**
 * System Doctor CLI — run the Doctor against the LIVE worker (default), or
 * against a local SQLite copy of the store (--local), or just run maintenance.
 *
 * Usage:
 *   npm run doctor            # check only (autoFix=false) against the live worker
 *   npm run doctor:fix        # check + auto-fix against the live worker
 *   npm run maintenance       # maintenance sweep against the live worker
 *   npm run doctor -- --local   # run the checks locally against .local/exec.db
 *
 * Requires EXEC_OS_URL + FOUNDER_AUTH_TOKEN (from executive-os/.dev.vars).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./dotenv.js";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const EXEC_OS = resolve(SCRIPT_DIR, "..");
const dotenv = loadDotEnv(join(EXEC_OS, ".dev.vars"));

const TOKEN = process.env.FOUNDER_AUTH_TOKEN ?? dotenv.FOUNDER_AUTH_TOKEN ?? "";
const EXEC_URL =
  process.env.EXEC_OS_URL ?? "https://zarlino-executive-os.zarlino001.workers.dev";
const IS_FIX = process.argv.includes("--fix");
const IS_MAINTENANCE = process.argv.includes("--maintenance");
const IS_LOCAL = process.argv.includes("--local");

const ICONS: Record<string, string> = { OK: "✅", WARN: "⚠️ ", FAIL: "❌" };

async function callLive(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${EXEC_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function printReport(report: { generatedAt: string; trigger: string; autoFix: boolean; checks: Array<{ id: string; label: string; severity: string; status: string; detail: string; fixed?: string; action?: string }>; summary: { total: number; ok: number; warn: number; fail: number; fixed: number }; healthy: boolean }): void {
  console.log(`\nSystem Doctor report — ${report.generatedAt}`);
  console.log(`Trigger: ${report.trigger}   Auto-fix: ${report.autoFix ? "ON" : "OFF"}`);
  console.log("-".repeat(72));
  for (const c of report.checks) {
    console.log(`${ICONS[c.status] ?? "•"} [${c.severity.padEnd(8)}] ${c.id}`);
    console.log(`   ${c.detail}`);
    if (c.fixed) console.log(`   ↳ FIXED: ${c.fixed}`);
    if (c.action) console.log(`   ↳ ACTION: ${c.action}`);
  }
  console.log("-".repeat(72));
  console.log(
    `Summary: ${report.summary.ok}/${report.summary.total} ok · ${report.summary.warn} warn · ${report.summary.fail} fail · ${report.summary.fixed} fixed`,
  );
  console.log(report.healthy ? "✅ HEALTHY" : "⚠️  ISSUES FOUND");
}

async function main(): Promise<void> {
  if (IS_LOCAL) {
    // Local mode: run the same checks against a local sqlite file if present.
    const dbPath = join(EXEC_OS, ".local", "exec.db");
    if (!existsSync(dbPath)) {
      console.log(`No local database at ${dbPath}`);
      console.log("Create one with:  node -e \"require('node:sqlite')\"  (then run migrations via the test suite).");
      process.exit(1);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const { createNodeSql } = await import("../src/db/sql.js");
    const { ExecutiveStore } = await import("../src/db/store.js");
    const { runDoctor } = await import("../src/core/doctor.js");
    const db = new DatabaseSync(dbPath);
    const store = new ExecutiveStore(createNodeSql(db as never));
    const report = await runDoctor(
      { store, env: { ...dotenv }, now: () => new Date().toISOString() },
      { autoFix: IS_FIX, trigger: "local-cli" },
    );
    printReport(report);
    db.close();
    return;
  }

  if (!TOKEN) {
    console.error("FOUNDER_AUTH_TOKEN not found — add it to executive-os/.dev.vars or the environment.");
    process.exit(1);
  }

  if (IS_MAINTENANCE) {
    const out = (await callLive("/api/maintenance/run", {})) as Record<string, unknown>;
    console.log("Maintenance sweep complete:", out);
    return;
  }

  const report = (await callLive("/api/doctor/run", {
    autoFix: IS_FIX,
    trigger: "local-cli",
  })) as Parameters<typeof printReport>[0];
  printReport(report);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
