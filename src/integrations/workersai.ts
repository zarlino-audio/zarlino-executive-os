/**
 * Executive-tier model calls on Cloudflare Workers AI ("neurons").
 *
 * The org's executive layer (CEO agent decisions, summaries, light reasoning)
 * runs on Workers AI — consuming the account's daily neuron allowance
 * (default budget: 10,000 neurons/day) — while heavy workers (long-horizon
 * agent runs, coding loops, chat with tools) stay on DeepSeek.
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
  AI_NEURON_DAILY_BUDGET?: string;
}

export const DEFAULT_EXEC_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Neuron rates per 1M tokens (Cloudflare published rates, approximate). */
const NEURON_RATES: Record<string, { inPerM: number; outPerM: number }> = {
  "@cf/meta/llama-3.1-8b-instruct-fp8": { inPerM: 4119, outPerM: 25300 },
  "@cf/meta/llama-3.2-3b-instruct": { inPerM: 2059, outPerM: 12650 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 26630, outPerM: 204300 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inPerM: 12000, outPerM: 75000 },
};

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const rate = NEURON_RATES[model] ?? NEURON_RATES[DEFAULT_EXEC_MODEL]!;
  return Math.ceil((inputTokens * rate.inPerM + outputTokens * rate.outPerM) / 1_000_000);
}

export function neuronBudget(env: AiEnv): number {
  const n = Number(env.AI_NEURON_DAILY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
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

function addNeurons(store: ExecutiveStore, count: number, now = new Date()): void {
  const used = neuronsUsedToday(store, now);
  store.setSetting(dayKey(now), String(used + count));
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

/**
 * One executive-tier completion. Returns null when Workers AI is unbound,
 * the daily neuron budget is spent, or the call fails — callers then fall
 * back to the heavy tier (DeepSeek).
 */
export async function executiveGenerate(
  env: AiEnv,
  store: ExecutiveStore,
  messages: ExecChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<ExecResult | null> {
  const ai = env.AI as WorkersAiBinding | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  const model = env.EXEC_AI_MODEL || DEFAULT_EXEC_MODEL;
  if (neuronsUsedToday(store) >= neuronBudget(env)) return null;
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
