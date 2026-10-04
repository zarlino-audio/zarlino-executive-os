/**
 * Executive-tier model calls on Cloudflare Workers AI ("neurons").
 *
 * The org's executive layer (CEO agent decisions, summaries, founder voice)
 * runs on the HIGH tier of Workers AI — consuming the account's daily neuron
 * allowance (default budget: 10,000 neurons/day) — while heavy workers
 * (long-horizon agent runs, coding loops, chat with tools) stay on DeepSeek.
 *
 * Budget accounting is approximate and honest: neuron estimates are recorded
 * per UTC day in the settings table; when the budget is spent this module
 * returns null and callers fall back to DeepSeek. Nothing pretends a call
 * happened when it did not.
 */
import type { ExecutiveStore } from "../db/store";

/** Minimal structural type of the Workers AI binding (avoids types coupling). */
export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface AiEnv {
  AI?: unknown;
  EXEC_AI_MODEL?: string;
  CAO_AI_MODEL?: string;
  AI_NEURON_DAILY_BUDGET?: string;
  AI_NEURON_CAO_RESERVE?: string;
}

/**
 * Default executive-tier model: the high tier (Llama 3.3 70B) — every
 * executive agent consumes the neuron budget on this tier. Override with
 * EXEC_AI_MODEL; heavy workers stay on DeepSeek.
 */
export const DEFAULT_EXEC_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Neuron rates per 1M tokens (Cloudflare published rates, approximate).
 *
 * The CAO tier is priced in dollars upstream ($1.32/M in, $3.96/M out) and
 * converted here at Cloudflare's $0.011 / 1,000 neurons so the org keeps ONE
 * ledger for "what did the executive layer cost us today".
 */
const NEURON_RATES: Record<string, { inPerM: number; outPerM: number }> = {
  "@cf/meta/llama-3.1-8b-instruct-fp8": { inPerM: 4119, outPerM: 25300 },
  "@cf/meta/llama-3.2-3b-instruct": { inPerM: 2059, outPerM: 12650 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 26630, outPerM: 204300 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inPerM: 12000, outPerM: 75000 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { inPerM: 120000, outPerM: 360000 },
};

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const rate = NEURON_RATES[model] ?? NEURON_RATES[DEFAULT_EXEC_MODEL]!;
  return Math.ceil((inputTokens * rate.inPerM + outputTokens * rate.outPerM) / 1_000_000);
}

export function neuronBudget(env: AiEnv): number {
  const n = Number(env.AI_NEURON_DAILY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/**
 * The slice of the daily allowance that only the founder channel may spend.
 *
 * Without this the 15-minute CEO cron drains the whole day's neurons before
 * breakfast and the founder's WhatsApp agent degrades to a canned line. The
 * founder is the one caller that must never be starved, so background work is
 * refused while the reserve is the only thing left.
 */
export function neuronCaoReserve(env: AiEnv): number {
  const configured = Number(env.AI_NEURON_CAO_RESERVE);
  const budget = neuronBudget(env);
  const reserve = Number.isFinite(configured) && configured >= 0 ? configured : Math.floor(budget * 0.25);
  return Math.min(reserve, budget);
}

function dayKey(now: Date): string {
  return `ai_neurons:${now.toISOString().slice(0, 10)}`;
}

export function neuronsUsedToday(store: ExecutiveStore, now = new Date()): number {
  return Number(store.getSetting(dayKey(now)) || 0);
}

export function neuronsLeft(store: ExecutiveStore, env: AiEnv, now = new Date()): number {
  return Math.max(0, neuronBudget(env) - neuronsUsedToday(store, now));
}

/**
 * The ledger the founder channel and the console both read. `backgroundLeft`
 * is what cron/agent work may spend without touching the reserve.
 */
export function neuronLedger(
  store: ExecutiveStore,
  env: AiEnv,
  now = new Date(),
): { budget: number; reserve: number; used: number; left: number; backgroundLeft: number } {
  const budget = neuronBudget(env);
  const reserve = neuronCaoReserve(env);
  const used = neuronsUsedToday(store, now);
  const left = Math.max(0, budget - used);
  return { budget, reserve, used, left, backgroundLeft: Math.max(0, left - reserve) };
}

function addNeurons(store: ExecutiveStore, count: number, now = new Date()): void {
  const used = neuronsUsedToday(store, now);
  store.setSetting(dayKey(now), String(used + count));
}

/**
 * Charge a completion that ran outside executiveGenerate (the CAO tier talks
 * to the Workers AI binding directly). Without this the founder's own model
 * would be the only spend the ledger never saw.
 */
export function chargeNeurons(
  store: ExecutiveStore,
  model: string,
  inputTokens: number,
  outputTokens: number,
  now = new Date(),
): number {
  const neurons = estimateNeurons(model, inputTokens, outputTokens);
  addNeurons(store, neurons, now);
  return neurons;
}

export interface ExecChatMessage {
  role: string;
  content: string;
}

export interface ExecResult {
  text: string;
  model: string;
  neurons: number;
  inputTokens: number;
  outputTokens: number;
}

function roughTokens(messages: ExecChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length + 8;
  return Math.ceil(chars / 4);
}

export type AiCallClass = "background" | "founder";

/**
 * One executive-tier completion. Returns null when Workers AI is unbound,
 * the daily neuron budget is spent, or the call fails — callers then fall
 * back to the heavy tier (DeepSeek).
 *
 * `opts.class` decides which slice of the allowance the call may spend:
 * background work stops at `budget - reserve`, the founder channel may spend
 * the reserve as well.
 */
export async function executiveGenerate(
  env: AiEnv,
  store: ExecutiveStore,
  messages: ExecChatMessage[],
  opts: { maxTokens?: number; temperature?: number; class?: AiCallClass } = {},
): Promise<ExecResult | null> {
  const ai = env.AI as WorkersAiBinding | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  const model = env.EXEC_AI_MODEL || DEFAULT_EXEC_MODEL;
  const allowed = opts.class === "founder" ? neuronBudget(env) : neuronBudget(env) - neuronCaoReserve(env);
  if (neuronsUsedToday(store) >= allowed) return null;
  try {
    const out = (await ai.run(model, {
      messages,
      max_tokens: opts.maxTokens ?? 512,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })) as {
      response?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = typeof out?.response === "string" ? out.response : "";
    if (!text) return null;
    const inputTokens = out?.usage?.prompt_tokens ?? roughTokens(messages);
    const outputTokens = out?.usage?.completion_tokens ?? Math.ceil(text.length / 4);
    const neurons = estimateNeurons(model, inputTokens, outputTokens);
    addNeurons(store, neurons);
    return { text, model, neurons, inputTokens, outputTokens };
  } catch {
    return null;
  }
}
