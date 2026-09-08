/**
 * ID + timestamp helpers shared across the Executive OS.
 * IDs are lexicographically sortable (timestamp prefix) and collision-safe
 * enough for a single-operator system (crypto-random suffix).
 */

/** Generate a prefixed, roughly-time-ordered id: `<prefix>_<base36ts>_<rand>`. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand =
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}_${rand}`;
}

/** Current time as an ISO-8601 string (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Today's date key `YYYY-MM-DD` (UTC). */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** This month's key `YYYY-MM` (UTC). */
export function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}
