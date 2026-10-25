import { describe, expect, it } from "vitest";
import {
  buildWebsiteTargets,
  evaluateChecks,
  monitorStateWrites,
  planBackupPrune,
  parseDeepSeekBalance,
  STATIC_TARGETS,
  WEBSITE_FALLBACK_TARGETS,
  type MonitorState,
} from "../src/core/monitor";

const now = "2026-10-02T00:00:00.000Z";

function up(id: string): MonitorState {
  return { id, state: "UP", failCount: 0, at: now, lastStatus: 200 };
}

describe("external monitor decision (Phase 0 continuity)", () => {
  it("keeps UP and emits no transition on the first failure (flaky grace)", () => {
    const { next, transitions } = evaluateChecks({ website: up("website") }, [
      { id: "website", ok: false, status: 503 },
    ], now);
    expect(transitions).toHaveLength(0);
    expect(next[0]?.state).toBe("UP");
    expect(next[0]?.failCount).toBe(1);
  });

  it("flips to DOWN after two consecutive failures and emits one transition", () => {
    const prev: Record<string, MonitorState | undefined> = {
      website: { ...up("website"), failCount: 1 },
    };
    const { next, transitions } = evaluateChecks(prev, [{ id: "website", ok: false, status: 0 }], now);
    expect(transitions).toEqual([{ id: "website", to: "DOWN" }]);
    expect(next[0]?.state).toBe("DOWN");
    expect(next[0]?.failCount).toBe(2);
  });

  it("does not re-emit DOWN while already DOWN", () => {
    const prev: Record<string, MonitorState | undefined> = {
      website: { id: "website", state: "DOWN", failCount: 4, at: now, lastStatus: 0 },
    };
    const { transitions } = evaluateChecks(prev, [{ id: "website", ok: false, status: 0 }], now);
    expect(transitions).toHaveLength(0);
  });

  it("recovers: DOWN -> UP emits a recovery transition and resets failCount", () => {
    const prev: Record<string, MonitorState | undefined> = {
      website: { id: "website", state: "DOWN", failCount: 3, at: now, lastStatus: 0 },
    };
    const { next, transitions } = evaluateChecks(prev, [{ id: "website", ok: true, status: 200 }], now);
    expect(transitions).toEqual([{ id: "website", to: "UP" }]);
    expect(next[0]?.failCount).toBe(0);
  });

  it("first-ever run with a healthy target emits no transition", () => {
    const { transitions } = evaluateChecks({}, [{ id: "fresh", ok: true, status: 200 }], now);
    expect(transitions).toHaveLength(0);
  });
});

describe("backup prune plan", () => {
  it("keeps the newest N keys and schedules the rest for deletion", () => {
    const keys = Array.from({ length: 34 }, (_, i) => `backups/db/2026-09-${String(i + 1).padStart(2, "0")}.json`);
    const prune = planBackupPrune(keys, 30);
    expect(prune).toHaveLength(4);
    expect(prune[0]).toBe("backups/db/2026-09-01.json");
    expect(prune[3]).toBe("backups/db/2026-09-04.json");
  });

  it("is a no-op while at or under the cap", () => {
    expect(planBackupPrune(["a", "b", "c"], 30)).toEqual([]);
  });
});

describe("deepseek balance parsing (top-up sentinel)", () => {
  it("reads the USD entry when present", () => {
    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "14.00" },
        { currency: "USD", total_balance: "2.00" },
      ],
    };
    expect(parseDeepSeekBalance(payload)).toBe(2);
  });

  it("falls back to the first entry when no USD entry exists", () => {
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: "CNY", total_balance: "14.5" }] })).toBe(14.5);
  });

  it("returns null for unknown shapes", () => {
    expect(parseDeepSeekBalance(null)).toBeNull();
    expect(parseDeepSeekBalance({})).toBeNull();
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull();
    expect(parseDeepSeekBalance({ balance_infos: [{ total_balance: "n/a" }] })).toBeNull();
  });
});

describe("website contract -> monitor targets (single source of truth)", () => {
  const contract = {
    schemaVersion: 1,
    service: "zarlino-website",
    required: [
      { path: "/", status: 200 },
      { path: "/plugins/ztame/", status: 200 },
    ],
    redirect: [{ path: "/plugins/ztame", status: 307, to: "/plugins/ztame/" }],
    absent: [{ path: "/about", status: 404 }],
    api: [
      { path: "/api/health", status: 200 },
      { path: "/api/license", status: 405, method: "GET" },
    ],
    artifacts: [{ path: "/downloads/x.zip", status: 200, method: "HEAD" }],
  };

  it("builds exactly one target per contract entry, with deterministic ids", () => {
    const targets = buildWebsiteTargets(contract);
    expect(targets.map((t) => t.id)).toEqual([
      "site:required:/",
      "site:required:/plugins/ztame/",
      "site:redirect:/plugins/ztame",
      "site:absent:/about",
      "site:api:/api/health",
      "site:api:/api/license",
      "site:artifacts:/downloads/x.zip",
    ]);
  });

  it("keeps exact expected statuses, methods and redirect handling", () => {
    const byId = new Map(buildWebsiteTargets(contract).map((t) => [t.id, t]));
    expect(byId.get("site:required:/")?.expect).toBe(200);
    expect(byId.get("site:absent:/about")?.expect).toBe(404);
    expect(byId.get("site:redirect:/plugins/ztame")?.expect).toBe(307);
    expect(byId.get("site:redirect:/plugins/ztame")?.redirect).toBe("manual");
    expect(byId.get("site:artifacts:/downloads/x.zip")?.method).toBe("HEAD");
    expect(byId.get("site:api:/api/health")?.url).toBe("https://zarlinoaudio.com/api/health");
  });

  it("fallback ids remain compatible with contract-derived ids (state continuity)", () => {
    for (const t of WEBSITE_FALLBACK_TARGETS) expect(t.id).toMatch(/^site:/);
    expect(WEBSITE_FALLBACK_TARGETS.some((t) => t.expect === 404)).toBe(true);
    expect(STATIC_TARGETS.some((t) => t.id === "os-api")).toBe(true);
  });
});

describe("monitor state writes stay inside the free plan's daily budget", () => {
  // 20 targets x 96 sweeps a day = 1920 KV writes against a 1000/day allowance.
  // When this ran on every sweep the account exhausted its KV write budget and
  // the factory could not publish artifacts at all
  // (`reached the free usage limit for this operation for today`).
  const later = "2026-10-02T00:15:00.000Z";
  const anHourLater = "2026-10-02T01:15:00.000Z";

  const targets = Array.from({ length: 20 }, (_, i) => `site:${i}`);

  it("writes nothing when every target is unchanged", () => {
    const prev: Record<string, MonitorState | undefined> = {};
    for (const id of targets) prev[id] = up(id);
    const next = targets.map((id) => up(id));

    expect(monitorStateWrites(prev, next, later)).toHaveLength(0);
  });

  it("writes on the first observation and on every state change", () => {
    const first = monitorStateWrites({}, targets.map((id) => up(id)), now);
    expect(first).toHaveLength(20);

    const prev: Record<string, MonitorState | undefined> = { a: up("a") };
    const down: MonitorState[] = [{ id: "a", state: "DOWN", failCount: 2, at: later, lastStatus: 503 }];
    expect(monitorStateWrites(prev, down, later)).toHaveLength(1);
  });

  it("still records a failing check before it crosses into DOWN", () => {
    const prev: Record<string, MonitorState | undefined> = { a: up("a") };
    const failing: MonitorState[] = [{ id: "a", state: "UP", failCount: 1, at: later, lastStatus: 503 }];
    expect(monitorStateWrites(prev, failing, later)).toHaveLength(1);
    // Once recorded, repeating the same observation writes nothing.
    expect(monitorStateWrites({ a: failing[0]! }, failing, "2026-10-02T00:30:00.000Z")).toHaveLength(0);
  });

  it("refreshes a still-DOWN target about once an hour, not every sweep", () => {
    const prev: Record<string, MonitorState | undefined> = {
      a: { id: "a", state: "DOWN", failCount: 3, at: now, lastStatus: 503 },
    };
    const down: MonitorState[] = [{ id: "a", state: "DOWN", failCount: 4, at: later, lastStatus: 503 }];
    expect(monitorStateWrites(prev, down, "2026-10-02T00:15:00.000Z")).toHaveLength(0);
    expect(monitorStateWrites(prev, down, anHourLater)).toHaveLength(1);
  });
});
