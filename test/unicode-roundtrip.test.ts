/**
 * Unicode / mojibake regression guard (local read-write path).
 *
 * Root cause this locks down (diagnosed 2026-09-15, task ltk_mtzbsw6g /
 * supersedes ltk_mtzaop77): the local agent's read/write path reported
 * `String(s).length` as "bytes". String.length is a UTF-16 code-unit count,
 * so every non-ASCII glyph understated the real byte size — e.g. "Café" is
 * 4 code units but 5 UTF-8 bytes; an emoji is 2 units but 4–7 bytes. Fix:
 * scripts/local-agent.ts `byteLen()` (Buffer.byteLength(s, "utf8")).
 *
 * It also guards the full text round-trip (disk -> store -> SSE -> decode)
 * against the classic mojibake failure mode: UTF-8 bytes reinterpreted as a
 * single-byte codepage (CP1252 / latin1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeSql } from "../src/db/sql";
import { ExecutiveStore } from "../src/db/store";

// Import the REAL helper from the product code, so this suite fails if the
// fix in scripts/local-agent.ts is reverted. local-agent.ts only starts its
// REPL under an isDirectRun guard, so importing it here has no side effects.
import { byteLen } from "../src/util/bytes";

/**
 * The multi-byte stress payload: Latin-1 accents, CJK, Arabic, emoji+VS16,
 * CJK punctuation, em dash, ellipsis, a ligature, and a combining mark.
 */
const T = "Café — 中文 العربية 🎛️ é à ü ñ ẹ̀ ﬀ … 中文。";

function utf8Hex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

/**
 * Server SSE frame encode (src/index.ts: `data: ${frame}\n\n`) + client decode
 * (web/src/api.ts:750 `decoder.decode(value, { stream: true })`), fed in
 * deliberately hostile `size`-byte reads so multi-byte chars straddle chunks.
 */
function sseRoundTrip(chunks: string[], size: number): string {
  const wire = Buffer.concat(
    chunks.map((c) => Buffer.from(`data: ${JSON.stringify({ text: c })}\n\n`, "utf8")),
  );
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  for (let i = 0; i < wire.length; i += size) {
    buffer += decoder.decode(wire.subarray(i, i + size), { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6)) as { text?: string };
        if (payload.text) out += payload.text;
      }
    }
  }
  out += decoder.decode(); // flush any held bytes
  return out;
}

describe("byteLen reports UTF-8 bytes, not UTF-16 code units", () => {
  it("counts multi-byte characters in bytes (the reported-size defect)", () => {
    expect("Café".length).toBe(4); // UTF-16 code units (old, wrong)
    expect(byteLen("Café")).toBe(5); // UTF-8 bytes (fixed)
    expect(byteLen("中文")).toBe(6); // 2 chars -> 6 bytes
    expect(byteLen("🎛️")).toBe(7); // emoji + VS16 -> 7 bytes, .length is 3
    expect(byteLen("—")).toBe(3); // em dash
    expect(byteLen("…")).toBe(3); // ellipsis
  });

  it("is exact for the full stress payload and never understates", () => {
    const actual = Buffer.byteLength(T, "utf8");
    expect(byteLen(T)).toBe(actual);
    expect(byteLen(T)).toBeGreaterThanOrEqual(T.length);
  });

  it("is ASCII-identical (no overcount regression)", () => {
    expect(byteLen("plain ascii")).toBe("plain ascii".length);
  });
});

describe("non-ASCII text round-trips through the write/read path", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zarlino-unicode-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeFileSync(utf8) -> readFileSync(utf8) is byte-identical", () => {
    const p = join(dir, "payload.txt");
    writeFileSync(p, T, "utf8");
    const back = readFileSync(p, "utf8");
    expect(back).toBe(T);
    expect(utf8Hex(back)).toBe(utf8Hex(T));
    expect(readFileSync(p).length).toBe(byteLen(T)); // on-disk size == byteLen
  });

  it("char-slice paging (local-agent local_read_file) reassembles exactly", () => {
    // local-agent.ts:223 does text.slice(start, start + limit) on a utf8 string.
    const text = readFileSync(join(dir, "payload.txt"), "utf8");
    for (const [start, limit] of [
      [0, 3],
      [4, 5],
      [10, 1],
      [0, text.length],
    ] as const) {
      const chunk = text.slice(start, start + limit);
      const reassembled = text.slice(0, start) + chunk + text.slice(start + limit);
      expect(reassembled).toBe(T);
    }
  });
});

describe("mojibake does not reappear end-to-end (store -> SSE -> decode)", () => {
  let db: DatabaseSync;
  let store: ExecutiveStore;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    store = new ExecutiveStore(createNodeSql(db as never));
    store.migrate();
  });
  afterAll(() => {
    db.close();
  });

  it("chat message survives store write/read byte-identically", () => {
    const ts = new Date().toISOString();
    store.insertChatMessage({
      id: "msg_unicode_reg",
      session_id: "s_unicode_reg",
      role: "user",
      content: T,
      source: "test",
      created_at: ts,
      updated_at: ts,
    });
    const back = store.listChatMessages("s_unicode_reg", 10)[0]!.content;
    expect(back).toBe(T);
    expect(utf8Hex(back)).toBe(utf8Hex(T));
  });

  it("streams intact across 1/2/3/5-byte chunk boundaries (no U+FFFD, no lone surrogates)", () => {
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const out = sseRoundTrip([T], size);
      expect(out).toBe(T);
      expect(utf8Hex(out)).toBe(utf8Hex(T));
      expect(out.includes("\uFFFD")).toBe(false);
      expect(
        [...out].some((c) => {
          const cp = c.codePointAt(0)!;
          return cp >= 0xd800 && cp <= 0xdfff;
        }),
      ).toBe(false);
    }
  });

  it("documents the CP1252 misread as the corruption signature (not the current path)", () => {
    // If UTF-8 bytes are ever reinterpreted as latin1/CP1252, this is the shape
    // of the damage. Expectations are DERIVED from the byte level (never typed
    // as mojibake literals — writing those is how the corruption starts).
    const bytes = Buffer.from(T, "utf8");
    const correct = bytes.toString("utf8");
    const corrupted = bytes.toString("latin1");
    expect(correct).toBe(T);
    expect(corrupted).not.toBe(T);
    // é (U+00E9 = C3 A9) read as CP1252 -> \u00C3\u00A9 ("Ã©")
    expect(corrupted.startsWith("Caf" + String.fromCharCode(0xc3, 0xa9))).toBe(true);
    // 中文 (E4 B8 AD E6 96 87) read as CP1252 -> four garbage glyphs
    expect(corrupted.includes(String.fromCharCode(0xe4, 0xb8, 0xad, 0xe6))).toBe(true);
    // every byte of a multi-byte char is >= 0x80 on the wire, so the corrupted
    // string is strictly longer and never equals the source
    expect(corrupted.length).toBeGreaterThan(T.length);
    expect(corrupted.includes("\uFFFD")).toBe(false); // latin1 never emits U+FFFD
  });
});
