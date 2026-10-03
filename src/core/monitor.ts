/**
 * Continuity ops (Phase 0, 2026-10-02) — external uptime monitoring + cloud
 * backup housekeeping. Pure decision helpers live here so they are unit
 * testable; the fetch/R2/KV side effects stay in src/index.ts.
 *
 * Design notes:
 *  - A single failed check never alerts (flaky networks exist). A target flips
 *    to DOWN only after TWO consecutive failures, and back to UP on the first
 *    success — transitions are what we notify on, not raw statuses.
 *  - "UP but failing once" is represented as state UP with failCount 1.
 *  - Backup pruning keeps the newest N objects under the backups/db/ prefix.
 */

export interface MonitorTarget {
  id: string;
  url: string;
  expect: number;
  method: "GET" | "HEAD";
}

export const MONITOR_TARGETS: MonitorTarget[] = [
  { id: "website", url: "https://zarlinoaudio.com/", expect: 200, method: "GET" },
  // The OS worker cannot fetch its own custom domain (self-fetch -> 522), so
  // the OS API is probed THROUGH the website worker (a different worker).
  { id: "os-api", url: "https://zarlinoaudio.com/api/probe-exec-os", expect: 200, method: "GET" },
  {
    id: "downloads",
    url: "https://zarlinoaudio.com/downloads/ZTame-v1.2.0-Windows-Installer.exe",
    expect: 200,
    method: "HEAD",
  },
];

export interface CheckResult {
  id: string;
  ok: boolean;
  status: number;
  error?: string;
}

export interface MonitorState {
  id: string;
  state: "UP" | "DOWN";
  failCount: number;
  at: string;
  lastStatus: number;
}

export interface MonitorTransition {
  id: string;
  to: "UP" | "DOWN";
}

export interface MonitorDecision {
  next: MonitorState[];
  transitions: MonitorTransition[];
}

/**
 * Pure state machine: previous KV states + fresh check results -> next states
 * plus the transitions worth alerting on.
 */
export function evaluateChecks(
  prev: Record<string, MonitorState | undefined>,
  checks: CheckResult[],
  now: string,
): MonitorDecision {
  const next: MonitorState[] = [];
  const transitions: MonitorTransition[] = [];

  for (const c of checks) {
    const p = prev[c.id];
    const failCount = c.ok ? 0 : (p?.failCount ?? 0) + 1;
    const state: "UP" | "DOWN" = !c.ok && failCount >= 2 ? "DOWN" : "UP";
    const prevState = p?.state ?? "UP";

    if (state === "DOWN" && prevState !== "DOWN") transitions.push({ id: c.id, to: "DOWN" });
    if (state === "UP" && prevState === "DOWN") transitions.push({ id: c.id, to: "UP" });

    next.push({ id: c.id, state, failCount, at: now, lastStatus: c.status });
  }

  return { next, transitions };
}

/** Keys that must be deleted so at most `keep` newest remain (lexicographic
 *  order == chronological for the ISO-stamped backup keys we write). */
export function planBackupPrune(keys: string[], keep = 30): string[] {
  const sorted = [...keys].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** Parse a DeepSeek /user/balance payload into a USD number (null when the
 *  shape is unknown). Prefers the USD entry; falls back to the first entry. */
export function parseDeepSeekBalance(payload: unknown): number | null {
  const obj = payload as
    | { balance_infos?: Array<{ currency?: string; total_balance?: string | number }> }
    | null
    | undefined;
  if (!obj || !Array.isArray(obj.balance_infos) || obj.balance_infos.length === 0) return null;
  const usd =
    obj.balance_infos.find((b) => String(b.currency ?? "").toUpperCase() === "USD") ??
    obj.balance_infos[0];
  const n = Number(usd?.total_balance);
  return Number.isFinite(n) ? n : null;
}
