/**
 * Agent-instance identity helpers (AOrgI §7) — instances are NOT roles.
 *
 * Every physical runtime registers under its own instance id. The local
 * daemon on the founder's machine is `local_daemon_01`; a remote dev machine
 * runs the same daemon with AGENT_ID=remote_daemon_01. Ids are validated
 * strictly: the DO never accepts an arbitrary row from a heartbeat.
 */

export const DEFAULT_DAEMON_AGENT_ID = "local_daemon_01";

/** Accept only safe instance ids; anything else → null (caller falls back). */
export function sanitizeInstanceId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim();
  return /^[a-z0-9_]{3,40}$/.test(v) ? v : null;
}

/** The id a daemon heartbeat registers under — sanitized, defaulted, pinned role. */
export function resolveDaemonAgentId(raw: string | null | undefined): string {
  return sanitizeInstanceId(raw) ?? DEFAULT_DAEMON_AGENT_ID;
}
