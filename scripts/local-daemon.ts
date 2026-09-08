/**
 * Local Agent Daemon — keeps the on-machine agent online.
 *
 * Loops every ~30s:
 *   1. Pings POST /api/local-agent/heartbeat so the System Doctor sees the
 *      machine agent is alive (and flags it when it isn't).
 *   2. Claims the oldest PENDING local task from the live worker.
 *   3. Runs it locally with the Local Agent's DeepSeek tool loop, heartbeats
 *      the lease every 60s while working, and posts the result/error back.
 *
 * Run (from executive-os/):
 *   npm run agent:daemon        # one pass, then exit
 *   npm run agent:daemon:loop   # run forever (survives idle; kill to stop)
 *   npm run agent:daemon -- --yes   # auto-confirm dangerous local actions
 *
 * Requires DEEPSEEK_API_KEY + FOUNDER_AUTH_TOKEN (from .dev.vars).
 */

import { hostname as osHostname } from "node:os";
import { API_KEY, EXEC_URL, TOKEN, ensureApiKey, runTurn } from "./local-agent.js";

const POLL_MS = 30_000; // claim + heartbeat cadence
const LEASE_HB_MS = 60_000; // heartbeat while working (lease is 10 min)
// Max DeepSeek tool-loop iterations per task. The old hard cap (12–16) was
// constantly hit on long-horizon tasks and returned "Reached the tool-call
// limit" without finishing. runTurn now CONTINUES past the per-turn budget
// until the total all-day budget is spent or the model answers — so a task
// can legitimately use hundreds/thousands of calls. Override per-turn with
// LOCAL_AGENT_MAX_TOOL_CALLS, the all-day ceiling with
// LOCAL_AGENT_MAX_TOTAL_TOOL_CALLS.
const MAX_TOOL_CALLS = Number(process.env.LOCAL_AGENT_MAX_TOOL_CALLS) || 60;
const MAX_TOTAL_TOOL_CALLS = Number(process.env.LOCAL_AGENT_MAX_TOTAL_TOOL_CALLS) || 2000;
const LOOP = process.argv.includes("--loop");

function log(...args: string[]): void {
  console.log(`[${new Date().toISOString()}] ${args.join(" ")}`);
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${EXEC_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Heartbeat the health beacon (also marks a claim so last_claim_at updates). */
async function beacon(claimed: boolean): Promise<void> {
  try {
    await post("/api/local-agent/heartbeat", {
      host: requireHost(),
      version: "local-agent-daemon-1.0",
      pid: String(process.pid),
      claimed,
    });
  } catch (err) {
    log("beacon failed:", err instanceof Error ? err.message : String(err));
  }
}

function requireHost(): string {
  try {
    return osHostname();
  } catch {
    return "unknown-host";
  }
}

async function runTask(task: { id: string; prompt: string }): Promise<void> {
  log("claimed task", task.id, "—", task.prompt.slice(0, 80));
  const hb = setInterval(() => {
    // Keep both the task lease AND the health beacon fresh while working.
    void post("/api/local-tasks/heartbeat", { id: task.id, status: "RUNNING" }).catch(() => {});
    void beacon(false).catch(() => {});
  }, LEASE_HB_MS);
  try {
    const result = await runTurn(task.prompt, MAX_TOOL_CALLS, {
      maxTotalCalls: MAX_TOTAL_TOOL_CALLS,
      onProgress: (p) => {
        if (p.turn > 1) log("task", task.id, `— continuing (turn ${p.turn}, ${p.iterations}/${MAX_TOTAL_TOOL_CALLS} calls, ${p.tools} tools)`);
      },
    });
    await post("/api/local-tasks/finish", { id: task.id, status: "DONE", result });
    log("finished task", task.id, "(DONE,", String(result.length), "chars)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await post("/api/local-tasks/finish", { id: task.id, status: "FAILED", error: msg }).catch(() => {});
    log("task", task.id, "FAILED:", msg.slice(0, 200));
  } finally {
    clearInterval(hb);
  }
}

async function tick(): Promise<void> {
  await beacon(false);
  try {
    const out = (await post("/api/local-tasks/claim", { claimer: `local-${requireHost()}-${process.pid}` })) as { ok: boolean; task: { id: string; prompt: string } | null };
    if (out?.task) {
      await beacon(true);
      await runTask(out.task);
    }
  } catch (err) {
    log("claim/run error:", err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  ensureApiKey();
  if (!TOKEN) {
    console.error("FOUNDER_AUTH_TOKEN not found — add it to executive-os/.dev.vars or the environment.");
    process.exit(1);
  }
  log("local-agent daemon online →", EXEC_URL, LOOP ? "(loop mode)" : "(single pass)");
  await beacon(false);
  if (!LOOP) {
    await tick();
    return;
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
