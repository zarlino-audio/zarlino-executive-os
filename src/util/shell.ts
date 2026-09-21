/**
 * Shell-correct command construction for the local agent.
 *
 * WHY THIS MODULE EXISTS (defect: local_run_tests failed with
 * a not-recognized-as-an-internal-or-external-command error):
 *
 *   The tool built its command string with a PowerShell-only pipeline stage
 *   and handed that string to child_process.exec, which on Windows spawns
 *   %COMSPEC% (cmd.exe) - NOT PowerShell. cmd.exe parsed
 *   npx vitest run 2>&1 | Select-Object -Last 12 as a pipe into a program
 *   literally named Select-Object and failed to find it.
 *
 *   So the defect was a SHELL/STRING MISMATCH, not a quoting bug: the string
 *   was well-formed, it was simply written in a language the executing shell
 *   does not speak.
 *
 * THE RULE, enforced below: a command string carries the shell it is written
 * for. A PowerShell-flavoured string is executed BY PowerShell; a plain
 * cmd/POSIX string runs on the host shell. No single shell is hardcoded.
 */

import { win32 as pathWin32 } from "node:path";

export type ShellDialect = "posix" | "powershell";

/** A command plus the shell that must execute it. */
export interface ShellCommand {
  /** The executable to spawn (an absolute path when one is required). */
  file: string;
  /** argv for file - never one string, so no shell re-parses the quoting. */
  args: string[];
  /** Which shell the command string was written for. */
  dialect: ShellDialect;
  /** True when the command needs PowerShell and this host cannot provide it. */
  powerShellAvailable: boolean;
  /** False when the caller must not use file/args (translation needed). */
  runnable: boolean;
}

/**
 * Syntax that only PowerShell understands.
 *
 * Deliberately narrow: the pipeline verbs this codebase actually used, plus
 * the PowerShell call operator. A bare ampersand used as a command separator
 * is cmd/POSIX-only and must NOT be classified as PowerShell.
 */
export const POWERSHELL_ONLY = [
  /\bSelect-Object\b/i,
  /\bForEach-Object\b/i,
  /\bWhere-Object\b/i,
  /\bSort-Object\b/i,
  /\bMeasure-Object\b/i,
  /\bTee-Object\b/i,
  /\bOut-String\b/i,
  /\bOut-File\b/i,
  /\bWrite-Output\b/i,
  /&\s*\"/,
] as const;

/** PowerShell cmdlets without the -Object suffix (still PowerShell-only). */
export const POWERSHELL_VERBS = [
  /\bGet-ChildItem\b/i,
  /\bGet-Content\b/i,
  /\bGet-Item\b/i,
  /\bRemove-Item\b/i,
  /\bCopy-Item\b/i,
  /\bStart-Process\b/i,
  /\bInvoke-Expression\b/i,
] as const;

/** True when the script uses syntax that only PowerShell can parse. */
export function isPowerShellScript(script: string): boolean {
  return POWERSHELL_ONLY.some((re) => re.test(script)) || POWERSHELL_VERBS.some((re) => re.test(script));
}

/** The dialect a command string is written for. */
export function detectShellDialect(command: string): ShellDialect {
  return isPowerShellScript(command) ? "powershell" : "posix";
}

/** True when this process is running on Windows. */
export function isWindowsHost(): boolean {
  return process.platform === "win32";
}

/**
 * Can this host execute PowerShell?
 *
 * Decided from `platform`, not by probing the filesystem for powershell.exe: the
 * agent runs under cmd, under a daemon and under test runners, and a filesystem
 * probe is exactly the kind of guess that produced the original bug. Windows
 * always has Windows PowerShell; POSIX hosts do not.
 */
export function powerShellAvailable(): boolean {
  return isWindowsHost();
}

/**
 * The PowerShell argv a script becomes, or null when unavailable.
 *
 * `-Command` is used (not `-EncodedCommand`) because a command may contain
 * non-ASCII (note titles, plugin names) and execFile argv quoting carries it
 * through intact. `runPowerShell()` in local-agent.ts keeps using
 * `-EncodedCommand` for whole multi-line script bodies.
 */
export function powerShellInvocation(script: string): { file: string; args: string[] } | null {
  if (!powerShellAvailable()) return null;
  return { file: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
}
/** The host shell: cmd on Windows, /bin/sh elsewhere. */
export function hostShellFile(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return "/bin/sh";
}


/**
 * Rewrite cmd / Windows-isms into POSIX equivalents so tool definitions stay
 * runnable on the Linux VPS. The 2>&1 redirect is already valid POSIX and is
 * left alone.
 */
export function normalizeToPosix(command: string): string {
  return command
    .replace(/&\s*"([^"]+)"/g, (_m, p: string) => `${pathWin32.normalize(p).replace(/\\/g, "/")}`)
    .replace(/\s*2>nul\b/g, " 2>/dev/null")
    .replace(/\bnul\b/g, "/dev/null");
}

/**
 * Split a command on UNQUOTED pipe characters.
 *
 * cmd and POSIX shells split pipelines on a bare pipe regardless of
 * surrounding quotes, so honouring quotes here is strictly safer, never less
 * correct.
 */
export function splitTopLevelPipes(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}
/** Extract the numeric argument of a `Select-Object -Last N` stage, if present. */
export function parseTailCount(command: string): number | null {
  const m = /-Last\s+(\d+)/i.exec(command);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Keep only the last `n` lines of `text`. */
export function tailLines(text: string, n: number): string {
  if (n <= 0) return "";
  const rows = text.split(/\r?\n/);
  return rows.slice(Math.max(0, rows.length - n)).join("\n");
}
/** Reduce a PowerShell command string to one the host shell can really run. */
export function toHostDialect(command: string): { command: string; translated: boolean } {
  let translated = false;
  const mapped = splitTopLevelPipes(command).map((part) => {
    if (/^\s*(Select-Object|Out-String|Write-Output)\b/i.test(part)) {
      const last = parseTailCount(part);
      if (last !== null) {
        translated = true;
        return "tail -n " + last;
      }
    }
    return part;
  });
  const joined = mapped.join(" | ");
  const normalized = normalizeToPosix(joined);
  return { command: normalized, translated: translated || normalized !== command };
}

/**
 * Build the exact spawn for a command string, choosing the shell from the
 * command dialect instead of assuming one.
 *
 * - PowerShell-dialect string -> spawn PowerShell with -Command <script>.
 * - Plain cmd/POSIX string    -> spawn the host shell (cmd.exe on Windows,
 *                               /bin/sh elsewhere) with the matching flag.
 *
 * The returned file/args are what the caller must hand to execFile. The
 * command string is never re-quoted by us, so there is no place for a shell
 * to mangle it a second time.
 */
export function buildShellCommand(command: string): ShellCommand {
  const dialect = detectShellDialect(command);
  const psAvailable = powerShellAvailable();

  if (dialect === "powershell") {
    const inv = powerShellInvocation(command);
    if (!inv) {
      const { command: translatedCmd, translated: didTranslate } = toHostDialect(command);
      return {
        file: hostShellFile(),
        args: [process.platform === "win32" ? "/d" : "-c", translatedCmd],
        dialect,
        powerShellAvailable: false,
        runnable: didTranslate,
      };
    }
    return { file: inv.file, args: inv.args, dialect, powerShellAvailable: true, runnable: true };
  }

  const shell = hostShellFile();
  const flag = process.platform === "win32" ? "/d" : "-c";
  return { file: shell, args: [flag, command], dialect, powerShellAvailable: psAvailable, runnable: true };
}

/** Human-readable one-liner, for the failure message a tool returns. */
export function describeShellCommand(sc: ShellCommand): string {
  return sc.file + " " + sc.args.map((a) => a).join(" ");
}

