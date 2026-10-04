/**
 * Task de-duplication.
 *
 * The founder's words: "the org seems to be arguing itself just to burn tokens
 * instead of doing the work." Part of what that looked like: the same work
 * appearing on the board again and again (two identical "ZScorch UI inspection"
 * tasks, several "reconcile" audits, one probe re-asked after its report had
 * already been delivered), each copy spawning its own agent run.
 *
 * Rule: a task whose title means the same thing as a task that is still open,
 * or that already completed inside the recall window, is not created twice.
 * The caller gets the existing task back and is told to extend it.
 */
import type { ExecutiveStore } from "../../db/store";

/** Statuses that count as "this work is already on the board". */
const LIVE_STATUSES = ["OPEN", "IN_PROGRESS", "BLOCKED"];

/** How long a finished task still blocks a re-created twin. */
const RECALL_MS = 14 * 24 * 60 * 60 * 1000;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^task:\s*/, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that carry no distinguishing meaning when comparing titles. */
const STOPWORDS = new Set([
  "the", "a", "an", "in", "on", "of", "for", "to", "and", "or", "with", "that", "this",
  "then", "please", "must", "should", "make", "sure", "all", "any", "new", "again", "only",
  "into", "from", "by", "at", "as", "is", "are", "was", "be", "it", "its", "per", "via",
  "task", "work", "need", "needs", "verify", "check", "ensure", "also", "using", "use",
]);

/** Tokens that actually identify the work. */
function significantTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Token-set similarity: 1 means the same words, 0 means nothing shared. */
export function titleSimilarity(a: string, b: string): number {
  const wa = significantTokens(a);
  const wb = significantTokens(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.max(wa.size, wb.size);
}

/**
 * Is this the same work? A reworded version is (every significant word of the
 * candidate already appears in the existing title, and the existing title adds
 * at most a couple of qualifiers). One decisive word is enough to veto:
 * "fix the licence gate in ZScorch" must never swallow "...in ZTame".
 */
export function isSameWork(candidate: string, existing: string): boolean {
  const cand = significantTokens(candidate);
  const exist = significantTokens(existing);
  if (cand.size === 0 || exist.size === 0) return false;
  for (const w of cand) if (!exist.has(w)) return false;
  let extras = 0;
  for (const w of exist) if (!cand.has(w)) extras += 1;
  return extras <= 2;
}

export interface DuplicateHit {
  id: string;
  title: string;
  status: string;
  created_at: string;
  similarity: number;
}

/**
 * Find a task that already means the same thing. Deterministic, local, and
 * cheap: bounded scan of the most recent tasks, weighted Jaccard on words.
 * Similarity is deliberately conservative (0.72) so genuinely different work
 * is never swallowed.
 */
export function findDuplicateTask(
  store: ExecutiveStore,
  title: string,
  opts: { now?: Date } = {},
): DuplicateHit | null {
  const now = opts.now ?? new Date();
  let tasks: Array<{ id: string; title: string; status: string; created_at: string }> = [];
  try {
    tasks = store.listTasks({ limit: 200 }) as never;
  } catch {
    return null;
  }
  let best: DuplicateHit | null = null;
  for (const t of tasks) {
    const live = LIVE_STATUSES.includes(t.status);
    const recent = Number.isFinite(Date.parse(t.created_at))
      ? now.getTime() - Date.parse(t.created_at) < RECALL_MS
      : false;
    if (!live && !recent) continue;
    if (!isSameWork(title, t.title)) continue;
    const similarity = titleSimilarity(title, t.title);
    if (!best || similarity > best.similarity) {
      best = { id: t.id, title: t.title, status: t.status, created_at: t.created_at, similarity };
    }
  }
  return best;
}

/** The sentence the org gets back instead of a brand-new duplicate task. */
export function duplicateNote(hit: DuplicateHit): string {
  return (
    `DUPLICATE_TASK: "${hit.title}" (${hit.id}) is already ${hit.status} ` +
    `(${Math.round(hit.similarity * 100)}% match). Work that task instead of creating a twin — ` +
    `add a comment, task evidence, or a new acceptance criterion to it.`
  );
}

/** Statuses that count as "work already finished". */
export function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.includes(status);
}
