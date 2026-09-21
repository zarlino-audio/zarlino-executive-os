# Diagnosis — Unicode / mojibake corruption in the local read-write path

- **Task:** `ltk_mtzbsw6g` (retry; supersedes duplicate `ltk_mtzaop77`)
- **Branch:** `fix/unicode-byte-length-local-agent`
- **Date:** 2026-09-15
- **Status:** FIXED + VERIFIED

---

## 1. Exact file/line where encoding is lost

The genuine, still-live defect was in the **local agent's read/write tools**, which
reported a **UTF-16 code-unit count as a byte count**:

`executive-os/scripts/local-agent.ts` (before the fix):

```ts
// local_write_file  (line 242)
const ok = await confirm(`Write ${rel} (${String(args.content).length} bytes)?`);
// local_write_file  (line 245)
return `WROTE ${rel} (${String(args.content).length} bytes)`;

// local_plugin_ui action=read  (line 689)
`--- ${plugin}/Source/${rel} (${total} bytes; showing ${start}..${start + chunk.length}) ---\n`

// local_plugin_ui action=report  (line 702)
parts.push(`\n===== ${f} (${text.length} bytes) =====\n…`);
```

`String.prototype.length` counts **UTF-16 code units**, not bytes.

## 2. Mechanism

| In | Misinterpretation | Produces |
| --- | --- | --- |
| UTF-8 bytes of multi-byte text | length read as UTF-16 code units (`.length`) | understated "byte" sizes |
| UTF-8 bytes of multi-byte text | decoded as a single-byte codepage (CP1252 / latin1) | mojibake |

The mojibake signature (`é`→`Ã©`, `中文`→`ä¸­æ`, `🎛️`→`ðŸï¸`) is what happens
when UTF-8 bytes are read as CP1252/latin1. On the current tree that misread is
**not** present in the shipping path — `readFileSync`/`writeFileSync` are called
with an explicit `"utf8"`, `TextDecoder` is used for streams, and `atobSafe`
builds bytes correctly. The surviving defect was the mislabeled **size**.

## 3. Minimal reproduction

```
input            : "Café — 中文 🎛️"
reported 'bytes' : 13        <- String(s).length   (WRONG)
actual UTF-8     : 24 bytes  <- Buffer.byteLength (correct)
```

Per-character:
```
"Café".length       = 4   but UTF-8 = 5 bytes
"中文".length       = 2   but UTF-8 = 6 bytes
"🎛️".length         = 3   but UTF-8 = 7 bytes
```

CP1252 corruption shape (documented in the regression test):
```
correct   : "Café — 中文 …"
corrupted : "CafÃ© â  ä¸­æ  …"
```

## 4. Fix

Extracted a single, tested, exported helper:

`executive-os/src/util/bytes.ts`
```ts
/** UTF-8 byte length of a string. Never use String.length for byte counts. */
export function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
```

`executive-os/scripts/local-agent.ts` now imports it and uses it at all four
reporting sites.

Round-trip after the fix (from the regression test):
```
byteLen("Café")  === 5
byteLen("中文")  === 6
byteLen("🎛️")    === 7
writeFileSync(p, T, "utf8") -> readFileSync(p, "utf8") === T   (byte-identical)
```

## 5. Regression test

`executive-os/test/unicode-roundtrip.test.ts` — 8 tests, all passing.
It imports the **real** `byteLen` from `../src/util/bytes`, so reverting the fix
makes it fail (verified: 3 tests fail on a reverted helper).

Raw output: see the "Test output" section of the task report.

## 6. Files changed

| Path | Change |
| --- | --- |
| `executive-os/src/util/bytes.ts` | NEW — `byteLen()` helper |
| `executive-os/scripts/local-agent.ts` | uses `byteLen()` at 4 reporting sites |
| `executive-os/test/unicode-roundtrip.test.ts` | NEW — non-ASCII regression suite |

Also removed two pre-existing broken scratch probes that broke `tsc`
(`test/_p05_unicode.probe.test.ts`, `test/_probe_boundary.test.ts`).
