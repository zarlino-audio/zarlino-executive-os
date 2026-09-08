/**
 * Password hashing (PBKDF2-SHA256, `salt:hex` format) — works in Cloudflare
 * Workers (WebCrypto) and Node. Shared between the worker auth handlers and
 * tests so credential verification is covered by the test suite.
 *
 * The stored format is `salt:hex` where salt is a hex string; verification
 * re-derives the key with the stored salt and constant-time-compares.
 */

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash a password with PBKDF2-SHA256 (100k iterations) into `salt:hex`. */
export async function hashPassword(password: string, salt?: string): Promise<string> {
  const s = salt ?? toHex(crypto.getRandomValues(new Uint8Array(16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(s), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `${s}:${toHex(bits)}`;
}

/** Constant-time compare two equal-length hex strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a plaintext password against a stored `salt:hex` hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const idx = stored.lastIndexOf(":");
  if (idx <= 0) return false;
  const salt = stored.slice(0, idx);
  const expected = stored.slice(idx + 1);
  const actual = (await hashPassword(password, salt)).slice(idx + 1);
  return timingSafeEqual(actual, expected);
}
