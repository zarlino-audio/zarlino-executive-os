/**
 * Byte-accurate helpers for text handling.
 *
 * Why this exists: `String.prototype.length` is a count of UTF-16 code units,
 * NOT bytes. Reporting it as a size is wrong for every non-ASCII string —
 * "Café" is 4 code units but 5 UTF-8 bytes, and an emoji is 2 units but
 * 4–7 bytes. The local agent's read/write tools did exactly that, so every
 * non-ASCII file/prompt reported a size that was too small (the mojibake in
 * the read/write path defect, task ltk_mtzbsw6g). Always use byteLen().
 */

/** UTF-8 byte length of a string. Never use String.length for byte counts. */
export function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
