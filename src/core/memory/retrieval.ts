/**
 * Memory retrieval (spec §27). Lightweight, cost-free keyword retrieval —
 * no embeddings, no vector DB. Scores memories by title/body/tag term overlap,
 * weighted by importance and recency. Good enough for a single-operator system.
 */
import type { Memory } from "../../types";

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "it", "at", "by", "as", "from", "that",
  "this", "do", "did", "does", "i", "you", "we", "they", "he", "she",
]);

function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Recency factor: 1.0 now → 0.3 after ~120 days. */
function recencyFactor(createdAt: string): number {
  const ageMs = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const days = ageMs / 86_400_000;
  return Math.max(0.3, 1 - days / 180);
}

/**
 * Score a single memory against a query (0..~1). Higher is more relevant.
 * Title matches weigh more than body matches; tag matches add a bonus.
 */
export function scoreMemory(memory: Memory, query: string): number {
  if (!query) return memory.importance;
  const q = new Set(tokenize(query));
  if (q.size === 0) return memory.importance;
  const title = tokenize(memory.title);
  const body = tokenize(memory.body);
  const tags = tokenize(memory.tags_json ?? "");

  let hits = 0;
  let titleHits = 0;
  for (const term of q) {
    if (title.includes(term)) { hits += 2; titleHits += 1; }
    if (body.includes(term)) hits += 1;
    if (tags.includes(term)) hits += 1.5;
  }
  const raw = hits / q.size; // 0..~4
  const recency = recencyFactor(memory.created_at);
  const importance = Math.min(1, Math.max(0, Number(memory.importance) || 0.5));
  return Math.min(1, raw * 0.55 + importance * 0.3 + recency * 0.15 + (titleHits > 0 ? 0.1 : 0));
}

export interface RetrieveOptions {
  query?: string;
  limit?: number;
  layers?: Memory["layer"][] | string[];
}

/** Return the top memories for a query, best first. */
export function retrieve(memories: Memory[], opts: RetrieveOptions = {}): Memory[] {
  const query = (opts.query ?? "").trim();
  const layers = opts.layers?.length ? new Set(opts.layers as string[]) : null;
  const filtered = layers ? memories.filter((m) => layers.has(String(m.layer))) : memories;
  const scored = filtered
    .map((m) => ({ m, score: scoreMemory(m, query) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 8).map((s) => s.m);
}
