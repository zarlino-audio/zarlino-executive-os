import { describe, expect, it } from "vitest";
import {
  isToolCallSequenceError,
  repairToolCallSequence,
  trimTranscript,
  type WireMessage,
} from "../src/core/transcript";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantCalls(ids: string[]): WireMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "local_read_file", arguments: "{}" } })),
  };
}
function toolCall(id: string, content = `out ${id}`): WireMessage {
  return { role: "tool", tool_call_id: id, content };
}
function userMsg(content: string): WireMessage {
  return { role: "user", content };
}
function assistantText(content: string): WireMessage {
  return { role: "assistant", content };
}

/**
 * The invariant DeepSeek enforces on the wire: a `tool` message is valid only
 * while a group opened by the immediately preceding assistant `tool_calls` is
 * unanswered, and the group must be fully answered before anything else.
 */
function isWireValid(messages: WireMessage[]): boolean {
  let open: Set<string> | null = null;
  for (const m of messages) {
    const role = typeof m.role === "string" ? m.role : "";
    if (role === "tool") {
      if (!open) return false;
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      if (!open.has(id)) return false;
      open.delete(id);
      if (open.size === 0) open = null;
      continue;
    }
    if (open) return false; // group interrupted before it was fully answered
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = m.tool_calls.map((c) => String((c as { id?: unknown }).id ?? ""));
      if (ids.some((id) => id === "")) return false;
      open = new Set(ids);
    }
  }
  return open === null;
}

/**
 * A realistic long daemon transcript: system + task prompt, then per turn one
 * assistant message with 3 parallel tool calls + their responses, plus a
 * "CONTINUE" user message every 3rd turn (what `runTurn` injects).
 */
function makeLongTranscript(turns: number): WireMessage[] {
  const msgs: WireMessage[] = [{ role: "system", content: "sys" }, userMsg("do the task")];
  for (let t = 0; t < turns; t++) {
    const ids = [`c${t}a`, `c${t}b`, `c${t}c`];
    msgs.push(assistantCalls(ids));
    for (const id of ids) msgs.push(toolCall(id));
    if (t % 3 === 2) msgs.push(userMsg(`CONTINUE (turn ${t})`));
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// The bug: raw head/tail slicing cuts a tool-call group in half
// ---------------------------------------------------------------------------

describe("trimTranscript — tool-call groups are never cut in half", () => {
  it("the RAW slice used before the fix produces a transcript DeepSeek 400s on", () => {
    const messages = makeLongTranscript(25);
    expect(messages.length).toBeGreaterThan(100);
    // Exactly the old daemon code: head 20 + tail 60 by raw index.
    const raw = [...messages.slice(0, 20), ...messages.slice(-60)];
    // Index 19 is an assistant `tool_calls` message whose responses were cut
    // away, and the tail starts on an orphaned `tool` response — the two
    // variants of the live HTTP 400.
    expect(isWireValid(raw)).toBe(false);
  });

  it("trims on group boundaries and keeps the system message first", () => {
    const messages = makeLongTranscript(25);
    const trimmed = trimTranscript(messages, { keepHead: 20, keepTail: 60 });
    expect(isWireValid(trimmed)).toBe(true);
    expect(trimmed.length).toBeLessThan(messages.length);
    expect(trimmed.length).toBeGreaterThan(60);
    expect(trimmed[0]?.role).toBe("system");
    // The task prompt survives the head trim (the head never collapses to the
    // system message alone for a healthy transcript).
    expect(trimmed[1]?.role).toBe("user");
    // A second trim of the already-trimmed transcript is stable.
    expect(isWireValid(trimTranscript(trimmed, { keepHead: 20, keepTail: 60 }))).toBe(true);
  });

  it("is a no-op while the transcript is under the bound", () => {
    const messages = makeLongTranscript(3);
    expect(trimTranscript(messages, { keepHead: 20, keepTail: 60 })).toBe(messages);
  });

  it("backs the tail up onto the assistant message that opened the group", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "sys" },
      userMsg("do the task"),
      assistantCalls(["a", "b"]),
      toolCall("a"),
      toolCall("b"),
      assistantText("done"),
    ];
    const trimmed = trimTranscript(messages, { keepHead: 1, keepTail: 2 });
    expect(isWireValid(trimmed)).toBe(true);
    // The kept suffix starts with the call, not with a response without a call.
    expect(trimmed[1]?.role).toBe("assistant");
    expect((trimmed[1]?.tool_calls as unknown[])?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Repair: any transcript can be made wire-valid (heals old checkpoints)
// ---------------------------------------------------------------------------

describe("repairToolCallSequence — makes any transcript wire-valid", () => {
  it("returns the same array when nothing is wrong (no-op fast path)", () => {
    const messages = makeLongTranscript(4);
    expect(repairToolCallSequence(messages)).toBe(messages);
  });

  it("backfills a missing `tool` response instead of dropping the assistant call", () => {
    // Exactly the logged failure: assistant asked for a+b, only a was answered.
    const messages: WireMessage[] = [
      { role: "system", content: "sys" },
      userMsg("do the task"),
      assistantCalls(["a", "b"]),
      toolCall("a"),
    ];
    const repaired = repairToolCallSequence(messages);
    expect(repaired).not.toBe(messages);
    expect(isWireValid(repaired)).toBe(true);
    expect(repaired.length).toBe(5);
    expect(repaired[3]?.role).toBe("tool");
    expect(repaired[3]?.tool_call_id).toBe("a");
    expect(repaired[4]?.role).toBe("tool");
    expect(repaired[4]?.tool_call_id).toBe("b");
    expect(String(repaired[4]?.content)).toContain("tool result unavailable");
  });

  it("drops `tool` messages that answer nothing (orphans and duplicates)", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "sys" },
      toolCall("ghost"), // orphan: no assistant call before it
      userMsg("do the task"),
      assistantCalls(["a"]),
      toolCall("a"),
      toolCall("a"), // duplicate response for an already answered call
      assistantText("done"),
    ];
    const repaired = repairToolCallSequence(messages);
    expect(isWireValid(repaired)).toBe(true);
    expect(repaired.length).toBe(5);
    expect(repairToolCallSequence(repaired)).toBe(repaired);
  });

  it("cleans up unusable call ids and keeps assistant content a string", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "sys" },
      userMsg("do the task"),
      {
        role: "assistant",
        content: undefined,
        tool_calls: [
          { type: "function", function: { name: "x", arguments: "{}" } }, // no id
          { id: "a", type: "function", function: { name: "y", arguments: "{}" } },
          { id: "a", type: "function", function: { name: "z", arguments: "{}" } }, // duplicate id
        ],
      },
      toolCall("a"),
    ];
    const repaired = repairToolCallSequence(messages);
    expect(isWireValid(repaired)).toBe(true);
    const calls = repaired[2]?.tool_calls as Array<{ id: string }>;
    expect(calls.length).toBe(1);
    expect(calls[0]?.id).toBe("a");
    expect(typeof repaired[2]?.content).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Error recognition (repair-and-retry guard)
// ---------------------------------------------------------------------------

describe("isToolCallSequenceError", () => {
  it("matches both phrasings seen in local-daemon.log", () => {
    expect(
      isToolCallSequenceError(
        new Error(
          `DeepSeek HTTP 400: {"error":{"message":"An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls mes`,
        ),
      ),
    ).toBe(true);
    expect(
      isToolCallSequenceError(
        new Error(
          `DeepSeek HTTP 400: {"error":{"message":"An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id', The following tool_call_ids did not have response messages: call_00_nVifkn4W2IYdUAHFXPyg2792","type":"invalid_request_error"}}`,
        ),
      ),
    ).toBe(true);
  });

  it("does not match other provider failures (no pointless retries)", () => {
    expect(isToolCallSequenceError(new Error("DeepSeek HTTP 402: Insufficient Balance"))).toBe(false);
    expect(isToolCallSequenceError(new Error("DeepSeek HTTP 400: Invalid tools[0].function.name"))).toBe(false);
    expect(isToolCallSequenceError(new Error("Empty model response"))).toBe(false);
    expect(isToolCallSequenceError(undefined)).toBe(false);
  });
});
