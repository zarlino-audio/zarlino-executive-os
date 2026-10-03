import { describe, expect, it } from "vitest";
import { evaluateChecks, planBackupPrune, parseDeepSeekBalance, type MonitorState } from "../src/core/monitor";

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
