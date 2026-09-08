import { afterEach, describe, expect, it, vi } from "vitest";
import { paystackTools } from "../src/integrations/paystack";

const env = { PAYSTACK_SECRET_KEY: "sk_test_fake" };

/** Minimal fake store with the finance/settings surface sync_revenue uses. */
function fakeStore() {
  const settings = new Map<string, string>();
  const snaps: Array<{ revenue?: number; notes?: string; period?: string }> = [];
  return {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string | null) => {
      if (v === null) settings.delete(k);
      else settings.set(k, v);
    },
    latestSnapshot: () => (snaps.length ? snaps[snaps.length - 1] : null),
    insertSnapshot: (s: { revenue?: number; notes?: string; period?: string }) => {
      snaps.push(s);
    },
    _snaps: snaps,
  };
}

function paystackJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status: status < 400, message: "ok", data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paystack integration (revenue + spend)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("get_balance converts minor units to major units", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => paystackJson([{ currency: "GHS", balance: 75000 }])),
    );
    const tool = paystackTools({ env }).find((t) => t.name === "paystack.get_balance")!;
    const out = (await tool.run({} as never, {})) as { balances: Array<{ currency: string; balance: number }> };
    expect(out.balances[0]).toEqual({ currency: "GHS", balance: 750 });
  });

  it("list_transactions maps fields and converts amount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        paystackJson([
          { reference: "ZAR-1", status: "success", amount: 120000, currency: "GHS", customer: { email: "a@b.c" }, paid_at: "2026-08-28T00:00:00Z", channel: "card" },
          { reference: "ZAR-2", status: "abandoned", amount: 5000, currency: "GHS", customer: { email: "d@e.f" }, paid_at: "2026-08-27T00:00:00Z", channel: "bank" },
        ]),
      ),
    );
    const tool = paystackTools({ env }).find((t) => t.name === "paystack.list_transactions")!;
    const out = (await tool.run({} as never, {})) as { transactions: Array<{ reference: string; amount: number }> };
    expect(out.transactions).toHaveLength(2);
    expect(out.transactions[0]).toMatchObject({ reference: "ZAR-1", amount: 1200, status: "success" });
  });

  it("verify_transaction returns status/amount/email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        paystackJson({
          status: "success",
          amount: 75000,
          currency: "GHS",
          customer: { email: "buyer@x.y" },
          paid_at: "2026-08-28T00:00:00Z",
          channel: "card",
          metadata: { items: [{ plugin: "ztame" }] },
        }),
      ),
    );
    const tool = paystackTools({ env }).find((t) => t.name === "paystack.verify_transaction")!;
    const out = (await tool.run({} as never, { reference: "ZAR-1" })) as { status: string; amount: number; email: string };
    expect(out.status).toBe("success");
    expect(out.amount).toBe(750);
    expect(out.email).toBe("buyer@x.y");
  });

  it("sync_revenue records only NEW successful transactions and is idempotent", async () => {
    const store = fakeStore();
    const txn = (ref: string, amount: number) => ({
      reference: ref,
      status: "success",
      amount,
      currency: "GHS",
      customer: { email: "a@b.c" },
      paid_at: "2026-08-28T00:00:00Z",
    });
    const fetchMock = vi.fn(async () => paystackJson([txn("ZAR-A", 75000), txn("ZAR-B", 120000)]));
    vi.stubGlobal("fetch", fetchMock);

    const tool = paystackTools({ env }).find((t) => t.name === "paystack.sync_revenue")!;
    const first = (await tool.run({ store } as never, {})) as { added: number; totalRevenue: number };
    expect(first.added).toBe(2);
    expect(first.totalRevenue).toBe(1950); // 750 + 1200

    // Second run: same transactions — nothing new to add.
    const second = (await tool.run({ store } as never, {})) as { added: number };
    expect(second.added).toBe(0);

    // Revenue was applied to the snapshot.
    const latest = store._snaps[store._snaps.length - 1]!;
    expect(latest.revenue).toBe(1950);
  });

  it("sync_revenue skips non-success transactions", async () => {
    const store = fakeStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        paystackJson([
          { reference: "ZAR-X", status: "failed", amount: 50000, currency: "GHS", customer: { email: "a@b.c" }, paid_at: "2026-08-28T00:00:00Z" },
          { reference: "ZAR-Y", status: "success", amount: 30000, currency: "GHS", customer: { email: "a@b.c" }, paid_at: "2026-08-28T00:00:00Z" },
        ]),
      ),
    );
    const tool = paystackTools({ env }).find((t) => t.name === "paystack.sync_revenue")!;
    const out = (await tool.run({ store } as never, {})) as { added: number; totalRevenue: number };
    expect(out.added).toBe(1);
    expect(out.totalRevenue).toBe(300);
  });

  it("initiate_transfer posts the amount in minor units", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      paystackJson({ transfer_code: "TRF_1", reference: "REF_1", amount: 75000, currency: "GHS", status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = paystackTools({ env }).find((t) => t.name === "paystack.initiate_transfer")!;
    const out = (await tool.run({} as never, { recipient: "RCP_1", amount: 750, reason: "payout" })) as { amount: number; transferCode: string };
    expect(out.transferCode).toBe("TRF_1");
    expect(out.amount).toBe(750);

    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { body?: string; method?: string };
    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent.amount).toBe(75000); // minor units
    expect(sent.recipient).toBe("RCP_1");
    expect(sent.source).toBe("balance");
  });

  it("throws a clear error when PAYSTACK_SECRET_KEY is missing", async () => {
    const tool = paystackTools({ env: {} }).find((t) => t.name === "paystack.get_balance")!;
    await expect(tool.run({} as never, {})).rejects.toThrow(/PAYSTACK_SECRET_KEY/);
  });
});
