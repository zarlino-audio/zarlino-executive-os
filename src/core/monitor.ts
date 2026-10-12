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
  /** redirect handling; "manual" is required for targets that EXPECT a 3xx. */
  redirect?: "follow" | "manual";
}

/** Canonical website surface (the site's deployed worker + repo of record). */
export const WEBSITE_BASE = "https://zarlinoaudio.com";
export const WEBSITE_REPO = "zarlino-audio/zarlino-website";

/** Minimal shape of https://zarlinoaudio.com/api/contract (routes/contract.json). */
export interface WebsiteContract {
  schemaVersion: number;
  service?: string;
  required: Array<{ path: string; status: number }>;
  redirect: Array<{ path: string; to?: string; status: number }>;
  absent: Array<{ path: string; status: number }>;
  api: Array<{ path: string; status: number; method?: string }>;
  artifacts: Array<{ path: string; status: number; method?: string }>;
}

/**
 * Targets that are NOT part of the website route contract:
 *   - os-api: the OS API is probed THROUGH the website worker (the OS worker
 *     cannot fetch its own custom domain: self-fetch -> 522).
 */
export const STATIC_TARGETS: MonitorTarget[] = [
  { id: "os-api", url: `${WEBSITE_BASE}/api/probe-exec-os`, expect: 200, method: "GET" },
];

/**
 * Essential coverage used ONLY when /api/contract cannot be fetched. Ids match
 * buildWebsiteTargets() ids so state continuity is preserved across fallbacks.
 */
export const WEBSITE_FALLBACK_TARGETS: MonitorTarget[] = [
  { id: "site:required:/", url: `${WEBSITE_BASE}/`, expect: 200, method: "GET" },
  {
    id: "site:required:/plugins/ztame/",
    url: `${WEBSITE_BASE}/plugins/ztame/`,
    expect: 200,
    method: "GET",
  },
  { id: "site:api:/api/health", url: `${WEBSITE_BASE}/api/health`, expect: 200, method: "GET" },
  {
    id: "site:absent:/nonexistent-404-probe",
    url: `${WEBSITE_BASE}/nonexistent-404-probe`,
    expect: 404,
    method: "GET",
  },
];

/**
 * Build one monitor target per contract entry. The OS never maintains its own
 * route subset: the website's routes/contract.json (served at /api/contract)
 * is the ONE authoritative route list, so the OS cannot infer website health
 * from a hand-picked slice of evidence.
 *
 * Expected-404 entries are first-class: a 404 there counts as OK, anything
 * else fails; a 404 on a required entry is an application failure. Redirect
 * entries are probed with redirect:"manual" so the 307 itself is asserted.
 */
export function buildWebsiteTargets(
  contract: WebsiteContract,
  baseUrl: string = WEBSITE_BASE,
): MonitorTarget[] {
  const base = baseUrl.replace(/\/$/, "");
  const targets: MonitorTarget[] = [];
  for (const e of contract.required) {
    targets.push({ id: `site:required:${e.path}`, url: base + e.path, expect: e.status, method: "GET" });
  }
  for (const e of contract.redirect) {
    targets.push({
      id: `site:redirect:${e.path}`,
      url: base + e.path,
      expect: e.status,
      method: "GET",
      redirect: "manual",
    });
  }
  for (const e of contract.absent) {
    targets.push({ id: `site:absent:${e.path}`, url: base + e.path, expect: e.status, method: "GET" });
  }
  for (const e of contract.api) {
    targets.push({
      id: `site:api:${e.path}`,
      url: base + e.path,
      expect: e.status,
      method: e.method === "HEAD" ? "HEAD" : "GET",
    });
  }
  for (const e of contract.artifacts) {
    targets.push({
      id: `site:artifacts:${e.path}`,
      url: base + e.path,
      expect: e.status,
      method: "HEAD",
    });
  }
  return targets;
}

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
