/**
 * REGRESSION: `local_run_tests` failed with
 *   'Select-Object' is not recognized as an internal or external command.
 *
 * ROOT CAUSE (a SHELL/STRING MISMATCH, not a quoting bug):
 *   scripts/local-agent.ts built the suite command as
 *       npx vitest run 2>&1 | Select-Object -Last 12
 *   and handed it to child_process.exec, which on Windows spawns %COMSPEC%
 *   (cmd.exe) - NOT PowerShell. cmd.exe piped into a program literally named
 *   Select-Object, could not find it, and every test run died.
 *
 * A naive fix would swap the stage for `tail -n 12`, but `where tail` shows this
 * host has NO tail.exe: that merely trades one is-not-recognized error for
 * another. The shipped fix embeds NO output-limiting stage at all and bounds the
 * captured text in TypeScript instead, so no shell's syntax is assumed.
 *
 * These assertions fail against the pre-fix code and pass after the fix.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildShellCommand,
  detectShellDialect,
  isPowerShellScript,
  toHostDialect,
} from '../src/util/shell.js';

/** The exact string that produced the failure. */
const PRE_FIX_COMMAND = 'npx vitest run 2>&1 | Select-Object -Last 12';

const AGENT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'local-agent.ts');
const toolSource = (): string => readFileSync(AGENT_SRC, 'utf8');

/** Strip `//` comments so assertions test live code, not explanatory prose. */
function stripLineComments(code: string): string {
  return code
    .split('\n')
    .map((l) => l.replace(/\r$/, '')) // CRLF checkouts must behave like LF
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

describe('local_run_tests - the command must be runnable by the host shell', () => {
  it('no LIVE line pipes into a shell-specific cmdlet or utility', () => {
    const live = stripLineComments(toolSource());
    // cmd.exe on this host has neither Select-Object (PowerShell) nor tail.exe,
    // so neither may appear in an executed command string.
    expect(live).not.toContain('Select-Object');
    expect(live).not.toMatch(/\|\s*tail\b/);
  });

  it('the suite command is plain host-shell text', () => {
    const src = toolSource();
    const start = src.indexOf('name: "local_run_tests"');
    expect(start, 'local_run_tests tool not found').toBeGreaterThan(-1);
    const definition = src.slice(start, src.indexOf('name: "local_build_console"', start));

    expect(definition).toContain('npx vitest run 2>&1');
    expect(definition).not.toContain('Select-Object');
    expect(definition).not.toContain('tail');
    // No shell metacharacters beyond the 2>&1 redirect.
    const m = /runCommand\(\s*"([^"]+)"/.exec(definition);
    expect(m, 'could not extract the suite command').not.toBeNull();
    expect(m![1]).toBe('npx vitest run 2>&1');
  });

  it('truncateOutput bounds output in TypeScript, keeping the log tail', async () => {
    const { truncateOutput } = await import('../scripts/local-agent');
    const short = 'a'.repeat(50);
    expect(truncateOutput(short, 100)).toBe(short);

    const long = 'START' + 'x'.repeat(500) + 'Test Files  20 passed (20)';
    const out = truncateOutput(long, 100);
    // Keeps the LAST chars, which is where vitest prints its summary.
    expect(out).toContain('Test Files  20 passed');
    expect(out).not.toContain('START');
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(200);
  });
});

describe('local_run_tests - shell dialect detection (non-vacuous)', () => {
  it('classifies the exact pre-fix string as PowerShell', () => {
    expect(isPowerShellScript(PRE_FIX_COMMAND)).toBe(true);
    expect(detectShellDialect(PRE_FIX_COMMAND)).toBe('powershell');

    // Plain commands must NOT be dragged into PowerShell.
    expect(isPowerShellScript('npx vitest run')).toBe(false);
    expect(isPowerShellScript('npm --prefix web run build')).toBe(false);
    expect(isPowerShellScript('git status 2>&1')).toBe(false);
    // A bare `&` separator is cmd/POSIX-only, never PowerShell.
    expect(isPowerShellScript('npm run build & npm test')).toBe(false);
  });

  it('translates the pre-fix pipeline into a PowerShell-runnable form on Windows', () => {
    const { command, translated } = toHostDialect(PRE_FIX_COMMAND);
    expect(translated).toBe(true);
    expect(isPowerShellScript(command)).toBe(false);
  });

  it('routes a PowerShell command to PowerShell and a plain command to the host shell', () => {
    const plain = buildShellCommand('npx vitest run 2>&1');
    expect(plain.dialect).toBe('posix');
    expect(plain.runnable).toBe(true);

    if (process.platform === 'win32') {
      // A PowerShell string is actually executed by PowerShell, which is what
      // makes Select-Object resolve rather than fail.
      const ps = buildShellCommand(PRE_FIX_COMMAND);
      expect(ps.file.toLowerCase()).toContain('powershell');
      expect(ps.args).toContain('-Command');
      expect(ps.args[ps.args.length - 1]).toBe(PRE_FIX_COMMAND);
      // A plain string is executed by cmd.exe, exactly as `exec` would have.
      expect(plain.file.toLowerCase()).toContain('cmd');
    } else {
      expect(plain.file).toBe('/bin/sh');
    }
  });
});
