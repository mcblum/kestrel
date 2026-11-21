import { describe, expect, test } from 'vitest';
import type { AgentEvent, AgentHandle } from '../agents/types.ts';
import type { LivePatch } from '../model.ts';
import { Commands } from './commands.ts';

function harness() {
  let clock = 1000;
  const patches: LivePatch[] = [];
  const commands = new Commands(() => clock, (_id, patch) => patches.push(patch));
  const tick = (ms: number) => (clock += ms);
  return { commands, patches, tick };
}

// As the agents send them: only the starting call carries the command line; the result is matched by id.
const shell = (id: string, status: 'started' | 'finished' | 'failed', extra: Partial<Extract<AgentEvent, { type: 'tool' }>> = {}): AgentEvent => ({ type: 'tool', id, name: 'Bash', summary: 'Run', status, ...(status === 'started' ? { command: 'pnpm test' } : {}), ...extra });

describe('Commands', () => {
  test('a turn’s command is listed while it runs and ends with its tool result as output', async () => {
    const { commands, patches } = harness();
    commands.apply('s', 'Claude', shell('t1', 'started'), null);
    expect(patches.at(-1)?.commands?.[0]).toMatchObject({ id: 't1', status: 'running', noStop: expect.stringContaining('Claude') });
    expect(await commands.output('s', 't1', null, 'Claude')).toEqual({ text: '', truncated: false, note: 'Claude shows a command’s output when it finishes.' });

    commands.apply('s', 'Claude', shell('t1', 'finished', { detail: '\u001b[1m23 passed\u001b[0m' }), null);
    expect(commands.list('s')[0]!.status).toBe('completed');
    expect(await commands.output('s', 't1', null, 'Claude')).toEqual({ text: '23 passed', truncated: false });
  });

  test('a Claude result without a command line still ends the command its call started', () => {
    const { commands } = harness();
    commands.apply('s', 'Claude', shell('t1', 'started'), null);
    commands.apply('s', 'Claude', { type: 'tool', id: 't1', name: 'Bash', summary: 'Run', status: 'finished', detail: 'ok' }, null);
    expect(commands.list('s')[0]!.status).toBe('completed');
  });

  test('tools that run no command are not listed', () => {
    const { commands } = harness();
    commands.apply('s', 'Claude', { type: 'tool', id: 'r', name: 'Read', summary: 'Read a file', status: 'started' }, null);
    expect(commands.list('s')).toEqual([]);
  });

  test('Codex output is collected as it streams', async () => {
    const { commands } = harness();
    commands.apply('s', 'Codex', shell('c1', 'started'), null);
    expect((await commands.output('s', 'c1', null, 'Codex')).note).toBe('It has printed nothing yet.');
    commands.apply('s', 'Codex', { type: 'tool-output', id: 'c1', delta: 'line 1\n' }, null);
    commands.apply('s', 'Codex', { type: 'tool-output', id: 'c1', delta: 'line 2\n' }, null);
    expect((await commands.output('s', 'c1', null, 'Codex')).text).toBe('line 1\nline 2\n');
  });

  test('Claude’s background work is asked for its output while it runs, and kept as it ends', async () => {
    const { commands } = harness();
    let printed = 'Server listening\n';
    const handle = { backgroundOutput: async () => ({ text: printed, truncated: true }) } as unknown as AgentHandle;
    commands.apply('s', 'Claude', shell('t1', 'started', { inBackground: true }), handle);
    commands.apply('s', 'Claude', shell('t1', 'finished', { inBackground: true, detail: 'Command running in background with ID: b1' }), handle);
    commands.apply('s', 'Claude', { type: 'background-tasks', tasks: [{ id: 'b1', kind: 'command', description: 'pnpm dev', toolId: 't1' }] }, handle);
    expect(commands.list('s')[0]).toMatchObject({ id: 't1', status: 'running', taskId: 'b1' });
    expect(commands.list('s')[0]!.noStop).toBeUndefined();
    expect(await commands.output('s', 't1', handle, 'Claude')).toEqual({ text: 'Server listening\n', truncated: true });

    printed = 'Server listening\nshutting down\n';
    commands.apply('s', 'Claude', { type: 'background-ended', taskId: 'b1', status: 'stopped' }, handle);
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.list('s')[0]!.status).toBe('stopped');
    expect((await commands.output('s', 't1', null, 'Claude')).text).toBe('Server listening\nshutting down\n');
  });

  test('when the agent cannot say what it printed, the pane is told why', async () => {
    const { commands } = harness();
    const handle = { backgroundOutput: async () => Promise.reject(new Error('no such task')) } as unknown as AgentHandle;
    commands.apply('s', 'Claude', { type: 'background-tasks', tasks: [{ id: 'b1', kind: 'command', description: 'pnpm dev' }] }, handle);
    expect((await commands.output('s', 'task:b1', handle, 'Claude')).note).toBe('Claude could not say what it printed: no such task');
  });

  test('a failed run ends everything still running as failed', () => {
    const { commands } = harness();
    commands.apply('s', 'Codex', shell('c1', 'started'), null);
    commands.apply('s', 'Codex', { type: 'failed', reason: 'x', kind: 'other' }, null);
    expect(commands.list('s')[0]!.status).toBe('failed');
  });

  test('asking for a command the session does not list is refused with a reason', async () => {
    const { commands } = harness();
    await expect(commands.output('s', 'nope', null, 'Claude')).rejects.toThrow('not listed');
  });

  test('an unchanged list is not sent again', () => {
    const { commands, patches } = harness();
    commands.apply('s', 'Claude', shell('t1', 'started'), null);
    const sent = patches.length;
    commands.apply('s', 'Claude', shell('t1', 'started'), null);
    expect(patches).toHaveLength(sent);
  });
});
