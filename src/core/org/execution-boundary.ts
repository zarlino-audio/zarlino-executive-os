/**
 * Execution boundary (spec §2.3) — typed registry of what a machine agent may
 * and may not be asked to do.
 *
 * The VM/machine is the CEO's communication and intelligence environment. It
 * hosts the WhatsApp bridge and reports health; it does NOT write or modify
 * project source, run coding agents, compile, build, test, render, package or
 * deploy. All of that is engineering work and runs remotely (GitHub Actions),
 * dispatched and tracked by core/remote/execution.ts.
 *
 * Enforcement is server-side (fail closed):
 *   1. Local dispatches are refused at CREATION when the request looks like
 *      engineering work, or when the caller did not explicitly acknowledge a
 *      non-engineering machine-maintenance purpose.
 *   2. The claim path only serves rows explicitly tagged
 *      `machine_maintenance` — a daemon can never silently pick up an
 *      engineering task, even if one is written into the table by an older
 *      client. Rows without a tag are not claimable.
 *   3. A one-time policy sweep classifies legacy PENDING rows: engineering
 *      ones are cancelled with an explicit reason (to be re-dispatched
 *      remotely); the rest are tagged machine_maintenance.
 *
 * Classification deliberately errs toward "engineering": a false positive
 * only routes work to the correct remote environment, while a false negative
 * would let engineering run on the VM — the exact failure this prevents.
 */
import type { ExecutiveStore } from "../../db/store";
import { newId, nowIso } from "../../ids";
import { originalPromptOf } from "./dispatch";

/** Phrases that make a request engineering work (checked lowercased). */
export const ENGINEERING_MARKERS: readonly string[] = [
  "build",
  "compile",
  "cmake",
  "ctest",
  "ninja",
  "msvc",
  "msbuild",
  "rebuild",
  "run the tests",
  "run tests",
  "unit test",
  "test suite",
  "vitest",
  "fuzz",
  "source code",
  "source file",
  "edit the",
  "edit file",
  "write the code",
  "modify the code",
  "implement",
  "refactor",
  "patch",
  "fix the bug",
  "fix the code",
  "vst3",
  "installer",
  "nsis",
  "package the",
  "package release",
  "build-release",
  "release build",
  "render",
  "bounce",
  "golden",
  "dsp",
  "commit",
  "push the",
  "pull request",
  "merge",
  "checkout",
  "deploy",
  "code signing",
  "sign the",
  "plugin",
];

/** True when the prompt asks for engineering execution (remote-only). */
export function isEngineeringPrompt(prompt: string): boolean {
  const text = (prompt ?? "").toLowerCase();
  return ENGINEERING_MARKERS.some((m) => text.includes(m));
}

export interface LocalWorkVerdict {
  /** May this work be dispatched to a machine daemon at all? */
  local_allowed: boolean;
  target: "engineering" | "machine_maintenance";
  reason: string;
}

/**
 * Full verdict for one local dispatch. `acknowledgedMachineMaintenance` must
 * be set EXPLICITLY by the caller; without it every local dispatch is refused
 * (the safe default — local is the exception, not the rule).
 */
export function classifyLocalWork(prompt: string, acknowledgedMachineMaintenance = false): LocalWorkVerdict {
  const text = (prompt ?? "").toLowerCase();
  const hit = ENGINEERING_MARKERS.find((m) => text.includes(m));
  if (hit) {
    return {
      local_allowed: false,
      target: "engineering",
      reason: `engineering marker "${hit}" — engineering execution is remote-only (dispatch a GitHub Actions workflow via remote.dispatch_workflow)`,
    };
  }
  if (!acknowledgedMachineMaintenance) {
    return {
      local_allowed: false,
      target: "engineering",
      reason:
        "no explicit machine_maintenance acknowledgement — local dispatch defaults to refused; set machine_maintenance:true only for non-engineering machine checks (health, connectivity, local facts)",
    };
  }
  return { local_allowed: true, target: "machine_maintenance", reason: "explicit non-engineering machine-maintenance dispatch" };
}

export interface BoundarySweepResult {
  tagged: number;
  cancelled: number;
  cancelledIds: string[];
}

/**
 * One-time, idempotent policy sweep over ungoverned legacy local rows
 * (execution_target IS NULL). Engineering rows are cancelled with a reason
 * that names the correct route; everything else is tagged as machine
 * maintenance and remains claimable by a daemon.
 */
export function applyExecutionBoundarySweep(store: ExecutiveStore): BoundarySweepResult {
  let rows: Array<{ id: string; prompt: string; task_id?: string | null; meta_json?: string | null }> = [];
  try {
    rows = store.listUngovernedLocalTasks(200);
  } catch {
    return { tagged: 0, cancelled: 0, cancelledIds: [] };
  }
  let tagged = 0;
  let cancelled = 0;
  const cancelledIds: string[] = [];
  for (const row of rows) {
    try {
      // Classify the ORIGINAL ask, not the stored prompt: the OS dispatch
      // wrapper quotes the constitution ("a build/test run...") and would
      // make every stored prompt look like engineering work.
      const original = originalPromptOf({
        id: row.id,
        task_id: row.task_id,
        prompt: row.prompt,
        status: "PENDING",
        created_at: "",
        meta_json: row.meta_json,
      });
      if (isEngineeringPrompt(original)) {
        store.cancelLocalTaskPolicy(
          row.id,
          "Execution boundary: engineering work never runs on this machine. Re-dispatch it to the remote environment (GitHub Actions) — the VM is comms/intelligence only.",
        );
        cancelled += 1;
        cancelledIds.push(row.id);
        store.insertAudit({
          id: newId("aud"),
          actor: "system",
          action: "execution.boundary_cancelled",
          entity_type: "local_tasks",
          entity_id: row.id,
          detail_json: JSON.stringify({ task_id: row.task_id ?? null, policy: "engineering-remote-only" }),
          source: "runtime",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      } else {
        store.setLocalTaskTarget(row.id, "machine_maintenance");
        tagged += 1;
      }
    } catch {
      /* one bad row must not stop the sweep */
    }
  }
  return { tagged, cancelled, cancelledIds };
}
