// wait_for: a session in a workstream waiting on a sibling, through a real runtime with a scripted
// agent. The pure rules (every refusal, cycles, the combined list) are in shared/waits.test.ts.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import type { ToolResult } from './agents/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents, until, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { Workspace } from './workspace.ts';

// Real repositories and worktrees: slow under a full parallel run (see delegation.test.ts).
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const SPLIT = 'split the work';
const B_SAYS = 'The export endpoint is live at /export.';
const REASON = 'the export endpoint';

/** What a session's agent does when the user writes to it: call wait_for with these arguments. */
type Ask = { session?: string; reason?: string; clear?: boolean };

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-wait-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  await runtime.registerProject(makeRepo(), 'repoB');
  const asks = new Map<string, Ask>();
  const results: ToolResult[] = [];
  const heard: string[] = [];
  // A reply to a busy session may arrive joined to news from another one: find the ask in the text.
  const askIn = (text: string) => [...asks].find(([key]) => text.includes(key))?.[1];
  let releaseB: (end: 'done' | 'failed') => void = () => undefined;
  const bEnds = new Promise<'done' | 'failed'>((resolve) => (releaseB = resolve));
  agents.script = async (turn: Turn) => {
    if (turn.text === SPLIT) await turn.options.tools.delegate({ tasks: [{ project: 'repoA', brief: 'Work A' }, { project: 'repoB', brief: 'Work B' }], name: 'Invoices' });
    else if (turn.text.startsWith('Work B')) {
      if ((await bEnds) === 'failed') return turn.emit({ type: 'failed', reason: 'crashed', kind: 'other' });
      turn.emit({ type: 'message', id: 'b-last', text: B_SAYS, delta: B_SAYS, done: true });
    } else if (askIn(turn.text)) results.push(await turn.options.tools.waitFor(askIn(turn.text)!));
    else if (turn.text.includes('which you were waiting on')) heard.push(turn.text);
  };
  const lead = await runtime.start({ agent: 'claude', projectId: a.id, prompt: SPLIT, permission: 'auto' });
  await until(async () => (await workspace.state()).workstreams[0]?.sessionIds.length === 3, 'the workstream of three');
  const [, aId, bId] = (await workspace.state()).workstreams[0]!.sessionIds as [string, string, string];
  // A's first turn ends at once; B's waits for the test.
  await until(async () => (await workspace.state()).sessions.find((s) => s.id === aId)!.state === 'done', 'A to finish its first turn');
  /** The user writes `text` to a session, whose agent then calls wait_for with `ask`. */
  const call = async (sessionId: string, ask: Ask): Promise<ToolResult> => {
    const text = `[ask ${asks.size}]`;
    asks.set(text, ask);
    const before = results.length;
    await runtime.reply(sessionId, text);
    await until(() => results.length > before, 'the tool call');
    return results.at(-1)!;
  };
  const waits = async () => (await workspace.state()).waits ?? [];
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  return { workspace, runtime, lead, aId, bId, call, waits, heard, releaseB, settle };
}

describe('wait_for', () => {
  it('records the wait, tells the agent it will hear; when the target finishes the wait ends and the waiter is told once, with the report', async () => {
    const w = await world();
    const result = await w.call(w.aId, { session: w.bId, reason: REASON });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/You will be told when it finishes/);
    expect(await w.waits()).toEqual([expect.objectContaining({ waiterId: w.aId, targetId: w.bId, reason: REASON })]);
    w.releaseB('done');
    await w.settle();
    expect(await w.waits()).toEqual([]);
    expect(w.heard).toHaveLength(1);
    expect(w.heard[0]).toContain(B_SAYS);
    expect(w.heard[0]).toContain(REASON);
  });

  it('keeps the wait while the target waits on the user (or failed)', async () => {
    const w = await world();
    await w.call(w.aId, { session: w.bId, reason: REASON });
    w.releaseB('failed');
    await until(async () => (await w.workspace.state()).sessions.find((s) => s.id === w.bId)!.state === 'attention', 'B to need the user');
    await w.settle();
    expect(await w.waits()).toHaveLength(1);
    expect(w.heard).toEqual([]);
  });

  it('is cleared by the agent that declared it, and by no other', async () => {
    const w = await world();
    await w.call(w.aId, { session: w.bId, reason: REASON });
    const other = await w.call(w.lead.id, { session: w.bId, clear: true });
    expect(other).toMatchObject({ isError: true, text: expect.stringMatching(/not waiting on/) });
    expect(await w.waits()).toHaveLength(1);
    const own = await w.call(w.aId, { session: w.bId, clear: true });
    expect(own.isError).toBeUndefined();
    expect(own.text).toMatch(/no longer waiting/);
    expect(await w.waits()).toEqual([]);
  });

  it('refuses a target that has already finished, giving its last message so the caller can go on', async () => {
    const w = await world();
    w.releaseB('done');
    await w.settle();
    const result = await w.call(w.aId, { session: w.bId, reason: REASON });
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/already finished/) });
    expect(result.text).toContain(B_SAYS);
    expect(await w.waits()).toEqual([]);
  });

  it('refuses with the reason in the conversation: no session named, and a session outside the workstream', async () => {
    const w = await world();
    expect(await w.call(w.aId, { reason: REASON })).toMatchObject({ isError: true, text: expect.stringMatching(/Name the session/) });
    const outside = await w.call(w.aId, { session: 'nope', reason: REASON });
    expect(outside).toMatchObject({ isError: true, text: expect.stringContaining(`(${w.bId})`) });
    expect(w.runtime.overlay(w.aId)!.messages.some((m) => m.notice && /Kestrel refused wait_for/.test(m.text))).toBe(true);
  });
});
