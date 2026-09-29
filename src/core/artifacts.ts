/**
 * Artifact storage helpers (R2-backed) — mandate §25.
 *
 * Artifacts are large outputs the OS must keep durably OUTSIDE the Durable
 * Object's SQLite: audio renders, build zip/tgz packages, screenshots,
 * reports. Keys are always generated here (a caller-supplied name can never
 * escape the `artifacts/` prefix), and URL-supplied keys are validated
 * against traversal before they reach R2.
 *
 * Layout: `artifacts/<kind>/<utc-stamp>-<slug>`
 *   kind — short bucket-ish group: render | build | shot | report | misc
 */

/** Hard cap for a single PUT through the JSON route (base64 in memory). */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024; // 25 MB

/** Lowercase, path-safe slug for a display name. Never empty. */
export function artifactSlug(name: string): string {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return s || "artifact";
}

/** Deterministic key for a new artifact. `kind` is sanitized, never trusted. */
export function artifactKey(name: string, kind = "misc", at: Date = new Date()): string {
  const safeKind = /^[a-z0-9_-]{1,24}$/.test(kind) ? kind : "misc";
  const stamp = at.toISOString().replace(/[:.]/g, "-"); // 2026-09-29T15-20-01-123Z
  return `artifacts/${safeKind}/${stamp}-${artifactSlug(name)}`;
}

/**
 * Validate an R2 key that arrived through a URL. Returns the normalized key
 * or null when it is unsafe/out-of-scope (traversal, wrong prefix, too long).
 */
export function normalizeArtifactPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = String(raw).replace(/^\/+/, "");
  if (key.length === 0 || key.length > 300) return null;
  if (!key.startsWith("artifacts/")) return null;
  if (key.includes("..") || key.includes("\\") || key.includes("\0")) return null;
  return key;
}
