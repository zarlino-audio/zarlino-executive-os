/**
 * Chat UI v2 regression guards.
 *
 * These lock the structural findings of the chat audit
 * (docs/audits/chat-ui-v1-readonly-audit.md):
 *   - §3.4: non-ASCII literals in the chat sources were mojibake (UTF-8 bytes
 *     re-decoded through CP1252) and rendered as garbage in the UI.
 *   - §3.5: the v1 "Claude-standard" CSS shipped without any component using
 *     it (dead selectors implying features that did not exist).
 *
 * If either regresses, these tests fail before a deploy can ship it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const CHAT_SOURCES = [
  "web/src/views/chat.tsx",
  "web/src/lib/entertain.tsx",
  "web/src/api.ts",
  "web/src/styles.css",
];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Mojibake signatures: UTF-8 lead bytes rendered through CP1252. */
const MOJIBAKE = ["â€", "ðŸ", "Ã©", "Â·", "âœ", "âš", "â†"];

describe("chat sources are un-mangled text (audit gap 8)", () => {
  for (const file of CHAT_SOURCES) {
    it(`${file} contains no mojibake sequences`, () => {
      const text = read(file);
      const hits = MOJIBAKE.filter((m) => text.includes(m));
      expect(hits).toEqual([]);
      expect(text).not.toContain("\uFFFD");
    });
  }
});

describe("the v1 'Claude-standard' CSS is wired to real components (audit gap 9)", () => {
  const css = read("web/src/styles.css");
  const tsx = read("web/src/views/chat.tsx") + read("web/src/lib/entertain.tsx");

  const classes = [
    "md-codeblock",
    "md-lang",
    "md-nest",
    "md-table",
    "md-quote",
    "tok-kw",
    "tok-str",
    "msg-group",
    "day-sep",
    "first-in-group",
    "edge-label",
    "copied",
    "data-regenerating",
  ];

  for (const cls of classes) {
    it(`${cls} is styled and referenced by TSX`, () => {
      // `data-regenerating` is an attribute hook, the rest are class selectors.
      expect(css.includes(cls)).toBe(true);
      expect(tsx.includes(cls)).toBe(true);
    });
  }
});

describe("chat client stays wired to the enhancement endpoints", () => {
  const api = read("web/src/api.ts");
  for (const fn of [
    "chatStreamStart",
    "chatStop",
    "chatRate",
    "chatRename",
    "chatTruncate",
    "chatRegenerate",
    "uploadFile",
    "chatSse",
  ]) {
    it(`api.${fn} is exported`, () => {
      expect(api.includes(`${fn}:`) || api.includes(`export async function ${fn}`) || api.includes(`export function ${fn}`)).toBe(true);
    });
  }

  it("SSE consumer honours `event: done` and resumes with `after` (gap 7)", () => {
    expect(api.includes('event === "done"')).toBe(true);
    expect(api.includes("after=${frames}")).toBe(true);
  });
});
