/**
 * Minimal .env file loader (no external dependency).
 * Parses KEY=VALUE lines; supports blank lines and # comments.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Load a dotenv-style file into a plain object.
 * @param {string} path absolute path to the .env file
 * @returns {Record<string, string>}
 */
export function loadDotEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
