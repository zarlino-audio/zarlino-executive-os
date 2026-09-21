/**
 * DeepSeek tool-loop transcript hygiene.
 *
 * DeepSeek (like OpenAI) enforces a hard structural invariant on the wire:
 * every assistant message that carries `tool_calls` must be *immediately*
 * followed by one `tool` message per `tool_call_id`, and a `tool` message may
 * never appear without the assistant message that issued its call.
 *
 * Violating it rejects the whole request with HTTP 400:
 *   "An assistant message with 'tool_calls' must be followed by tool messages
 *    responding to each 'tool_call_id'."
 *   "insufficient tool messages following tool_calls message."
 *
 * Two code paths used to break that invariant:
 *   1. transcript trimming by RAW INDEX (`slice(0, head)` + `slice(-tail)`)
 *      cut the conversation in the middle of a tool-call group — the assistant
 *      message stayed, its `tool` responses were dropped (or the reverse);
 *   2. the worker persisted that broken transcript as the durable run
 *      checkpoint, so every auto-resume replayed the same invalid request and
 *      the run could never make progress again.
 *
 * This module provides the primitives that make the failure impossible:
 *   - `trimTranscript` — index-aligned trimming that only ever cuts on
 *     tool-call group boundaries (used by both agent loops);
 *   - `repairToolCallSequence` — a repair pass that makes ANY transcript
 *     wire-valid (used before every send and when loading old checkpoints, so
 *     checkpoints written by older builds heal instead of poisoning resumes);
 *   - `isToolCallSequenceError` — recognises that specific HTTP 400 so a
 *     caller can repair and retry once instead of losing the run.
 */

/**
 * Loose structural view of the fields this module reads. Deliberately typed
 * with `unknown` optionals so it fits both the Worker's `ChatMsg` interface
 * and the local agent's plain `Record<string, unknown>` messages.
 */
export interface WireMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

/** Stand-in result for a tool call whose recorded output can no longer be found. */
export const MISSING_TOOL_RESULT =
  "ERROR: tool result unavailable — this output was dropped when the conversation was trimmed. Re-run the tool if you still need the value.";

function roleOf(m: WireMessage | undefined): string {
  return m && typeof m.role === "string" ? m.role : "";
}

/**
 * The usable tool calls of an assistant message: entries with a non-empty,
 * unique string id. Entries without an id can never be matched by a `tool`
 * response, so they are not part of the wire contract.
 */
function usableCalls(m: WireMessage): Array<Record<string, unknown>> {
  const raw: unknown = m.tool_calls;
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const id = (c as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(c as Record<string, unknown>);
  }
  return out;
}

function cloneWith(m: WireMessage, patch: Record<string, unknown>, remove?: string): Record<string, unknown> {
  const clone = { ...(m as Record<string, unknown>), ...patch };
  if (remove && !(remove in patch)) delete clone[remove];
  return clone;
}

/**
 * Make any transcript acceptable to the tool-calling API.
 *
 * - assistant `tool_calls` with missing responses get an explicit placeholder
 *   `tool` message (the call itself is preserved — dropping it would hide what
 *   the model already did);
 * - `tool` messages that answer nothing (orphans, duplicates, unknown ids) are
 *   dropped;
 * - assistant messages that carry `tool_calls` always end up with a string
 *   `content`, and unusable call entries (no id / duplicate id) are removed.
 *
 * Returns the SAME array reference when the transcript was already valid, so
 * callers can cheaply detect "nothing to do" (`repaired !== messages`).
 */
export function repairToolCallSequence<T extends WireMessage>(messages: readonly T[]): T[] {
  const out: T[] = [];
  let changed = false;
  let pending: { ids: string[]; answered: Set<string> } | null = null;

  const backfill = () => {
    if (!pending) return;
    for (const id of pending.ids) {
      if (pending.answered.has(id)) continue;
      out.push({ role: "tool", tool_call_id: id, content: MISSING_TOOL_RESULT } as unknown as T);
      changed = true;
    }
    pending = null;
  };

  for (const m of messages) {
    if (!m || typeof m !== "object") {
      changed = true;
      continue;
    }
    const role = roleOf(m);

    if (role === "tool") {
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      // Orphans (no open group, unknown/duplicate id) would be rejected as a
      // response to nothing — drop them.
      if (!pending || !id || !pending.ids.includes(id) || pending.answered.has(id)) {
        changed = true;
        continue;
      }
      pending.answered.add(id);
      if (pending.answered.size >= pending.ids.length) pending = null;
      out.push(m);
      continue;
    }

    // Any non-tool message closes the open group first, backfilling anything
    // that never got an answer so the responses stay contiguous.
    backfill();

    if (role === "assistant") {
      const rawCalls: unknown = m.tool_calls;
      if (Array.isArray(rawCalls) && rawCalls.length > 0) {
        const calls = usableCalls(m);
        if (calls.length === 0) {
          // Nothing addressable — keep the text, drop the unusable calls.
          out.push(cloneWith(m, { content: typeof m.content === "string" ? m.content : "" }, "tool_calls") as unknown as T);
          changed = true;
          continue;
        }
        const ids = calls.map((c) => String(c.id));
        const needsCallsFix = calls.length !== rawCalls.length;
        const needsContentFix = typeof m.content !== "string";
        let msg: T = m;
        if (needsCallsFix || needsContentFix) {
          const patch: Record<string, unknown> = {};
          if (needsCallsFix) patch.tool_calls = calls;
          if (needsContentFix) patch.content = "";
          msg = cloneWith(m, patch) as unknown as T;
          changed = true;
        }
        out.push(msg);
        pending = { ids, answered: new Set() };
        continue;
      }
    }

    out.push(m);
  }

  backfill();
  return changed ? out : (messages as T[]);
}

/**
 * True when a cut after index `end` would split a tool-call group: the kept
 * prefix would either end on an assistant `tool_calls` message that is still
 * waiting for responses, or end inside a response run that no longer shows the
 * call it answers.
 */
export function endsMidToolGroup(messages: readonly WireMessage[], end: number): boolean {
  if (end <= 0) return false;
  if (end >= messages.length) return false;

  const last = messages[end - 1];
  if (roleOf(last) !== "tool") {
    return roleOf(last) === "assistant" && usableCalls(last as WireMessage).length > 0;
  }

  // Walk back over the trailing run of responses to find the message that
  // opened the group.
  let i = end - 1;
  while (i >= 0 && roleOf(messages[i]) === "tool") i--;
  const opener = i >= 0 ? messages[i] : undefined;
  if (!opener || roleOf(opener) !== "assistant") return true; // responses with no visible call
  const wanted = usableCalls(opener as WireMessage).map((c) => String(c.id));
  if (wanted.length === 0) return true;
  const answered = new Set<string>();
  for (let j = i + 1; j < end; j++) {
    const r = messages[j];
    if (r && roleOf(r) === "tool" && typeof r.tool_call_id === "string") answered.add(r.tool_call_id);
  }
  return wanted.some((id) => !answered.has(id));
}

/**
 * Bound a transcript to `keepHead` leading + `keepTail` trailing messages
 * WITHOUT ever cutting a tool-call group in half.
 *
 * The leading slice keeps the system prompt (and the task prompt after it) and
 * is stepped back off any dangling assistant call; the trailing slice never
 * begins on a `tool` message (that would be a response without its call) —
 * it backs up onto the assistant message that issued the calls so the group
 * stays whole, or, if there is nowhere to back up to, skips the orphan run.
 *
 * The result is passed through `repairToolCallSequence` as a final guarantee,
 * so the output is always wire-valid.
 */
export function trimTranscript<T extends WireMessage>(
  messages: readonly T[],
  opts: { keepHead?: number; keepTail?: number } = {},
): T[] {
  const keepHead = Math.max(0, Math.floor(opts.keepHead ?? 10));
  const keepTail = Math.max(0, Math.floor(opts.keepTail ?? 70));
  const len = messages.length;
  if (len <= keepHead + keepTail) return messages as T[];

  let headEnd = Math.min(keepHead, len);
  while (headEnd > 0 && endsMidToolGroup(messages, headEnd)) headEnd--;
  if (headEnd === 0) headEnd = 1; // never drop the system message

  let tailStart = Math.max(headEnd, len - keepTail);
  while (tailStart > headEnd && roleOf(messages[tailStart]) === "tool") tailStart--;
  while (tailStart < len && roleOf(messages[tailStart]) === "tool") tailStart++; // orphan run with nowhere to back up to

  const trimmed = [...messages.slice(0, headEnd), ...messages.slice(tailStart)];
  return repairToolCallSequence(trimmed);
}

/** The exact HTTP 400 DeepSeek returns for a broken tool-call sequence. */
const TOOL_SEQUENCE_ERROR =
  /must be followed by tool messages|must be followed by tool_calls|insufficient tool messages|did not have response messages|tool_call_id.*did not have/i;

/**
 * True when an error is the "broken tool-call sequence" 400 — the one error a
 * repair + single retry can fix, as opposed to a funding/parameter error.
 */
export function isToolCallSequenceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/HTTP 400/.test(msg)) return false;
  return TOOL_SEQUENCE_ERROR.test(msg);
}
