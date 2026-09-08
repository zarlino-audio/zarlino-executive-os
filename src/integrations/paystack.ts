/**
 * Paystack integration (revenue + spend for the Executive).
 *
 * Paystack is the site's payment processor (zarlinoaudio.com checkout) and the
 * Executive uses it to:
 *   - check account balances,
 *   - list / verify transactions,
 *   - sync verified revenue into the finance system (financial snapshots), and
 *   - initiate transfers ("spend") — gated HIGH risk so the authority system
 *     requires Founder approval before any money leaves the account.
 *
 * Requires the `PAYSTACK_SECRET_KEY` secret (set via `wrangler secret put`).
 */

import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";
import { newId, nowIso } from "../ids";

const PAYSTACK_API = "https://api.paystack.co";
const PROCESSED_REFS_KEY = "paystack_processed_refs";

function paystackHeaders(ctx: { env: Record<string, string | undefined> }): Record<string, string> {
  const key = ctx.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("Paystack not configured: PAYSTACK_SECRET_KEY missing");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

interface PaystackEnvelope {
  status: boolean;
  message: string;
  data?: unknown;
}

async function paystackFetch(ctx: { env: Record<string, string | undefined> }, path: string, init?: RequestInit): Promise<PaystackEnvelope> {
  const res = await fetch(`${PAYSTACK_API}${path}`, { headers: paystackHeaders(ctx), ...init });
  const body = (await res.json().catch(() => ({}))) as PaystackEnvelope;
  if (!res.ok || body.status === false) {
    throw new Error(`Paystack ${res.status}: ${body.message || "request failed"}`);
  }
  return body;
}

/** Reference already recorded into finance (idempotency for sync_revenue). */
function processedRefs(store: NonNullable<ToolContext["store"]>): string[] {
  const raw = store.getSetting(PROCESSED_REFS_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function paystackTools(ctx: { env: Record<string, string | undefined> }): Tool[] {
  return [
    {
      name: "paystack.get_balance",
      description: "Get the Paystack account balance for every supported currency (e.g. GHS). Amounts are in major units.",
      inputSchema: z.object({}),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (tctx: ToolContext) => {
        const env = { ...ctx.env, ...tctx.env };
        const body = await paystackFetch({ env }, "/balance");
        const rows = (body.data as Array<{ currency?: string; balance?: number }>) ?? [];
        return {
          balances: rows.map((r) => ({ currency: r.currency ?? "?", balance: Number(r.balance ?? 0) / 100 })),
          note: "Balances are in major units (minor units / 100).",
        };
      },
    },
    {
      name: "paystack.list_transactions",
      description: "List recent Paystack transactions (status, amount, currency, email, reference, date). Default 20, max 100.",
      inputSchema: z.object({ perPage: z.number().int().min(1).max(100).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (tctx: ToolContext, input: { perPage?: number }) => {
        const env = { ...ctx.env, ...tctx.env };
        const perPage = input.perPage ?? 20;
        const body = await paystackFetch({ env }, `/transaction?perPage=${perPage}`);
        const rows = (body.data as Array<Record<string, unknown>>) ?? [];
        return {
          count: rows.length,
          transactions: rows.map((t) => ({
            reference: t.reference,
            status: t.status,
            amount: Number(t.amount ?? 0) / 100,
            currency: t.currency ?? "?",
            email: (t.customer as { email?: string } | undefined)?.email ?? "",
            paidAt: t.paid_at,
            channel: t.channel,
          })),
        };
      },
    },
    {
      name: "paystack.verify_transaction",
      description: "Verify a single Paystack transaction by reference. Returns status (success/abandoned/failed), amount, currency, email, and the raw metadata.",
      inputSchema: z.object({ reference: z.string().min(1).max(200) }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (tctx: ToolContext, input: { reference: string }) => {
        const env = { ...ctx.env, ...tctx.env };
        const body = await paystackFetch({ env }, `/transaction/verify/${encodeURIComponent(input.reference)}`);
        const t = (body.data as Record<string, unknown>) ?? {};
        return {
          status: t.status,
          amount: Number(t.amount ?? 0) / 100,
          currency: t.currency ?? "?",
          email: (t.customer as { email?: string } | undefined)?.email ?? "",
          paidAt: t.paid_at,
          channel: t.channel,
          metadata: t.metadata ?? null,
        };
      },
    },
    {
      name: "paystack.sync_revenue",
      description: "Pull the latest successful Paystack transactions and record each NEW one as revenue on the current financial snapshot (idempotent — already-recorded references are skipped). Use this to keep the finance system in sync with real sales.",
      inputSchema: z.object({
        maxTransactions: z.number().int().min(1).max(100).optional(),
        period: z.string().max(10).optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (tctx: ToolContext, input: { maxTransactions?: number; period?: string }) => {
        const store = tctx.store;
        if (!store) throw new Error("store unavailable");
        const env = { ...ctx.env, ...tctx.env };
        const perPage = input.maxTransactions ?? 25;
        const body = await paystackFetch({ env }, `/transaction?perPage=${perPage}`);
        const rows = (body.data as Array<Record<string, unknown>>) ?? [];
        const done = processedRefs(store);
        const seen = new Set(done);
        const period = input.period ?? new Date().toISOString().slice(0, 7);
        let added = 0;
        let totalRevenue = 0;
        const addedRefs: Array<{ reference: string; amount: number; currency: string; email: string; paidAt: string }> = [];

        for (const t of rows) {
          const reference = String(t.reference ?? "");
          const status = String(t.status ?? "");
          if (status !== "success" || !reference || seen.has(reference)) continue;
          const amount = Number(t.amount ?? 0) / 100;
          const currency = String(t.currency ?? "");
          const email = String((t.customer as { email?: string } | undefined)?.email ?? "");
          const paidAt = String(t.paid_at ?? "");

          const snap = store.latestSnapshot() ?? {
            id: newId("fin"),
            period,
            confidence: "ESTIMATE" as const,
            source: "tool" as const,
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          const revenue = (snap.revenue ?? 0) + amount;
          store.insertSnapshot({
            ...snap,
            id: newId("fin"),
            period,
            revenue,
            notes: [snap.notes, `+${currency} ${amount} Paystack ${reference}${email ? ` (${email})` : ""}`].filter(Boolean).join("; "),
            source: "tool",
            updated_at: nowIso(),
          });
          seen.add(reference);
          added++;
          totalRevenue += amount;
          addedRefs.push({ reference, amount, currency, email, paidAt });
        }

        store.setSetting(PROCESSED_REFS_KEY, JSON.stringify([...seen].slice(-500)));
        return {
          added,
          totalRevenue,
          period,
          addedRefs,
          alreadyRecorded: rows.filter((t) => String(t.status ?? "") === "success" && seen.has(String(t.reference ?? ""))).length,
        };
      },
    },
    {
      name: "paystack.initiate_transfer",
      description: "Initiate a Paystack transfer (send money out of the account to a recipient bank account). HIGH RISK — requires Founder approval before it executes. Provide the recipient code from the Paystack dashboard and the amount in major units.",
      inputSchema: z.object({
        recipient: z.string().min(1).max(200).describe("Paystack recipient code (e.g. RCP_...)"),
        amount: z.number().positive().describe("Amount in major units (e.g. 750 = 750 GHS)"),
        reason: z.string().min(1).max(300).optional(),
        currency: z.string().min(3).max(3).optional(),
      }),
      requiredPermission: "execute",
      riskLevel: "HIGH",
      reversible: false,
      auditRequired: true,
      run: async (tctx: ToolContext, input: { recipient: string; amount: number; reason?: string; currency?: string }) => {
        const env = { ...ctx.env, ...tctx.env };
        const body = await paystackFetch({ env }, "/transfer", {
          method: "POST",
          body: JSON.stringify({
            source: "balance",
            reason: input.reason ?? "Executive payout",
            amount: Math.round(input.amount * 100),
            recipient: input.recipient,
            currency: input.currency ?? undefined,
          }),
        });
        const d = (body.data as Record<string, unknown>) ?? {};
        return {
          ok: true,
          transferCode: d.transfer_code,
          reference: d.reference,
          amount: Number(d.amount ?? input.amount * 100) / 100,
          currency: d.currency ?? input.currency,
          status: d.status,
        };
      },
    },
  ];
}
