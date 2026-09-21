/**
 * Local Agent tool-call WIRE INVARIANT (root-cause guard).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireMessage } from '../src/core/transcript';

interface OutgoingPayload {
  messages: WireMessage[];
  tools?: unknown;
}

/**
 * The invariant exactly as the provider enforces it: a tool message is legal
 * only while a group opened by the immediately preceding assistant tool_calls
 * still has unanswered ids, and every id must be answered exactly once.
 */
function wireViolations(messages: WireMessage[]): string[] {
  const problems: string[] = [];
  let open: Set<string> | null = null;

  messages.forEach((m, i) => {
    const role = typeof m.role === 'string' ? m.role : '';
    if (role === 'tool') {
      if (!open) {
        problems.push('[' + i + '] tool message with no assistant tool_calls before it (tool_call_id=' + String(m.tool_call_id) + ')');
        return;
      }
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      if (!id) {
        problems.push('[' + i + '] tool message without a tool_call_id');
        return;
      }
      if (!open.has(id)) {
        problems.push('[' + i + '] tool message answers unknown/duplicate tool_call_id=' + id);
        return;
      }
      open.delete(id);
      if (open.size === 0) open = null;
      return;
    }

    if (open) {
      problems.push('[' + i + '] assistant tool_calls at an earlier index still had unanswered ids: ' + [...open].join(', '));
      open = null;
    }

    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = m.tool_calls.map((c) => String((c as { id?: unknown }).id ?? ''));
      if (ids.some((id) => id === '')) {
        problems.push('[' + i + '] assistant tool_calls entry with no id');
      }
      open = new Set(ids.filter((id) => id !== ''));
      if (open.size === 0) open = null;
    }
  });

  if (open) problems.push('transcript ended with unpaired tool_call_ids: ' + [...open].join(', '));
  return problems;
}

interface ScriptedReply {
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
  content?: string;
}

const sentPayloads: OutgoingPayload[] = [];

function okReply(body: Record<string, unknown>, reply: ScriptedReply) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: reply.content ?? '',
            ...(reply.toolCalls
              ? {
                  tool_calls: reply.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                  })),
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Stub the provider: capture every outgoing payload and play the script.
 * Non-DeepSeek URLs are answered with a harmless 200.
 */
function installStub(script: ScriptedReply[]): void {
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : String((url as Request).url);
      if (href.includes('api.deepseek.com')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        sentPayloads.push({ messages: (body.messages ?? []) as WireMessage[], tools: body.tools });
        n++;
        const reply = script[Math.min(n - 1, script.length - 1)]!;
        return okReply(body, reply);
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
    }),
  );
}

async function loadRunTurn() {
  const mod = await import('../scripts/local-agent');
  return mod.runTurn as (
    msg: string,
    maxToolCalls?: number,
    opts?: { perTurnCalls?: number; maxTotalCalls?: number },
  ) => Promise<string>;
}

beforeEach(() => {
  sentPayloads.length = 0;
  process.env.DEEPSEEK_API_KEY ||= 'test-key-not-used';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function assertAllPayloadsValid(where: string): void {
  const allProblems: string[] = [];
  sentPayloads.forEach((p, idx) => {
    for (const v of wireViolations(p.messages)) allProblems.push('payload#' + idx + ' ' + v);
  });
  expect(allProblems, where).toEqual([]);
}

describe('local agent runTurn - every outgoing payload is wire-valid', () => {
  it('asserts the invariant on a long multi-turn tool loop (the ltk_mtzbsw6g shape)', async () => {
    const runTurn = await loadRunTurn();
    const script: ScriptedReply[] = [];
    for (let i = 0; i < 12; i++) {
      script.push({
        toolCalls: [
          { id: 'call_' + i + '_a', name: 'local_ship_check', args: { plugin: 'ZScorch' } },
          { id: 'call_' + i + '_b', name: 'local_ship_check', args: { plugin: 'ZTame' } },
          { id: 'call_' + i + '_c', name: 'local_ship_check', args: { plugin: 'ZPunch' } },
        ],
      });
    }
    script.push({ content: 'final report' });
    installStub(script);

    const answer = await runTurn('do a long multi-step job', 6, { maxTotalCalls: 60 });

    expect(sentPayloads.length).toBeGreaterThan(3);
    expect(answer).toBe('final report');
    assertAllPayloadsValid('first scenario');
  }, 60000);

  it('crosses the >100 transcript bound and still never sends a split group', async () => {
    const runTurn = await loadRunTurn();
    const script: ScriptedReply[] = [];
    for (let i = 0; i < 40; i++) {
      script.push({
        toolCalls: [
          { id: 'c' + i + 'x', name: 'local_ship_check', args: { plugin: 'ZScorch' } },
          { id: 'c' + i + 'y', name: 'local_ship_check', args: { plugin: 'ZTame' } },
          { id: 'c' + i + 'z', name: 'local_ship_check', args: { plugin: 'ZPunch' } },
        ],
      });
    }
    script.push({ content: 'done' });
    installStub(script);

    await runTurn('very long job', 8, { maxTotalCalls: 140 });

    const maxLen = Math.max(...sentPayloads.map((p) => p.messages.length));
    expect(maxLen).toBeGreaterThan(100);
    assertAllPayloadsValid('long transcript');
  }, 60000);

  it('regression: the raw head/tail slice really does break the invariant', () => {
    const messages: WireMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
    for (let t = 0; t < 25; t++) {
      const ids = ['c' + t + 'a', 'c' + t + 'b', 'c' + t + 'c'];
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'local_ship_check', arguments: '{}' } })),
      });
      for (const id of ids) messages.push({ role: 'tool', tool_call_id: id, content: 'out ' + id });
    }
    expect(messages.length).toBeGreaterThan(100);

    const oldSlice = [...messages.slice(0, 20), ...messages.slice(-60)];
    expect(wireViolations(oldSlice).length).toBeGreaterThan(0);
  });

  it('rejects a scripted error path: no payload ever has an unpaired tool_call_id', async () => {
    const runTurn = await loadRunTurn();
    const script: ScriptedReply[] = [];
    for (let i = 0; i < 10; i++) {
      script.push({
        toolCalls: [
          { id: 'err_' + i + '_a', name: 'local_plugin_ui', args: { plugin: 'NoSuchPlugin', action: 'report' } },
          { id: 'err_' + i + '_b', name: 'local_read_file', args: { path: 'does/not/exist.ts' } },
        ],
      });
    }
    script.push({ content: 'gave up' });
    installStub(script);

    await runTurn('probe failure handling', 5, { maxTotalCalls: 50 });
    assertAllPayloadsValid('error path');
  }, 60000);
});

// ---------------------------------------------------------------------------
// The trim seam: this is where ltk_mtzbsw6g / ltk_mtzaop77 died.
// The raw head/tail slice split a tool-call group; trimTranscript must not.
// ---------------------------------------------------------------------------

import { trimTranscript, endsMidToolGroup } from '../src/core/transcript';

function roleOfAt(messages: readonly WireMessage[], i: number): string {
  const r = messages[i];
  return r && typeof r.role === 'string' ? r.role : '';
}

function longTranscript(groups: number): WireMessage[] {
  const messages: WireMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  for (let t = 0; t < groups; t++) {
    const ids = ['c' + t + 'a', 'c' + t + 'b', 'c' + t + 'c'];
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'local_ship_check', arguments: '{}' } })),
    } as WireMessage);
    for (const id of ids) messages.push({ role: 'tool', tool_call_id: id, content: 'out ' + id } as WireMessage);
  }
  return messages;
}

describe('trim seam - the fix at scripts/local-agent.ts:962', () => {
  it('raw head/tail slice (the pre-fix code) violates the invariant', () => {
    const messages = longTranscript(25);
    expect(messages.length).toBeGreaterThan(100);
    const rawSlice = [...messages.slice(0, 20), ...messages.slice(-60)];
    const problems = wireViolations(rawSlice);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('trimTranscript output satisfies the invariant for every group count', () => {
    for (const groups of [20, 25, 30, 40, 55, 70]) {
      const messages = longTranscript(groups);
      if (messages.length <= 100) continue;
      const trimmed = trimTranscript(messages, { keepHead: 20, keepTail: 60 });
      expect(wireViolations(trimmed), 'groups=' + groups).toEqual([]);
    }
  });

  it('endsMidToolGroup flags a cut that splits a tool-call group', () => {
    const messages = longTranscript(25);
    // Index 18 opens a 3-response group (18=assistant, 19/20/21=tool).
    expect(roleOfAt(messages, 18)).toBe('assistant');
    expect(roleOfAt(messages, 19)).toBe('tool');
    // A cut after any strict subset of the responses is mid-group.
    expect(endsMidToolGroup(messages, 19)).toBe(true);
    expect(endsMidToolGroup(messages, 20)).toBe(true);
    // A cut immediately before the assistant message is safe.
    expect(endsMidToolGroup(messages, 18)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source guard: pin the exact call site so a revert to the raw slice fails CI.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('source guard - the transcript trim must stay tool-group aligned', () => {
  it('runTurn trims via trimTranscript, never via a raw head/tail slice', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'local-agent.ts'), 'utf8');
    expect(src).toContain('trimTranscript(messages, { keepHead: 20, keepTail: 60 })');
    expect(src).not.toContain('...messages.slice(0, 20), ...messages.slice(-60)');
  });

  it('callDeepSeek reconciles orphans before every provider call', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'local-agent.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function callDeepSeek'));
    const body = fn.slice(0, fn.indexOf('\\n}'));
    expect(body).toContain('repairToolCallSequence(messages)');
  });
});
