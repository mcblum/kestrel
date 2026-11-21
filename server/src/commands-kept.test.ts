// "Commands kept per session" (Settings → Workflow): the store keeps that many, 0 keeps every one,
// running commands are never dropped, the number is stored and refused with a reason when unusable.
import { describe, expect, test } from 'vitest';
import type { AgentEvent } from './agents/types.ts';
import { commandsKeptRoute } from './commands-kept/api.ts';
import { CommandsKept } from './commands-kept/prefs.ts';
import { Commands } from './runtime/commands.ts';
import { memorySettings } from './suggestions/prefs.ts';

const started = (id: string): AgentEvent => ({ type: 'tool', id, name: 'Bash', summary: 'Run', status: 'started', command: `echo ${id}` });
const finished = (id: string): AgentEvent => ({ type: 'tool', id, name: 'Bash', summary: 'Run', status: 'finished', detail: id });

function store(kept: () => number) {
  let clock = 1000;
  const commands = new Commands(() => clock++, () => undefined, () => undefined, kept);
  const run = (n: number, prefix = 'c') => {
    for (let i = 0; i < n; i++) {
      commands.apply('s', 'Claude', started(`${prefix}${i}`), null);
      commands.apply('s', 'Claude', finished(`${prefix}${i}`), null);
    }
  };
  return { commands, run };
}

describe('commands kept per session', () => {
  test('keeps as many as the setting says, newest first, and follows a change', () => {
    let kept = 50;
    const { commands, run } = store(() => kept);
    run(60);
    expect(commands.list('s')).toHaveLength(50);
    expect(commands.list('s')[0]!.id).toBe('c59');
    kept = 5;
    run(1, 'x');
    expect(commands.list('s').map((c) => c.id)).toEqual(['x0', 'c59', 'c58', 'c57', 'c56']);
  });

  test('0 keeps every command, and a running one is never dropped', () => {
    const all = store(() => 0);
    all.run(120);
    expect(all.commands.list('s')).toHaveLength(120);
    const tight = store(() => 1);
    tight.commands.apply('s', 'Claude', started('long'), null);
    tight.run(3);
    expect(tight.commands.list('s').map((c) => c.id)).toEqual(['long']);
  });

  test('the number is stored, read back, and refused with the reason when unusable', async () => {
    const settings = memorySettings();
    const prefs = new CommandsKept({ settings });
    expect(await prefs.view()).toEqual({ kept: 50, defaultKept: 50 });
    const route = (method: string, body: Record<string, unknown> = {}) => commandsKeptRoute(['api', 'commands-kept'], method, async () => body, prefs);
    expect(await route('PUT', { kept: 0 })).toEqual({ status: 200, body: { kept: 0, defaultKept: 50 } });
    expect(prefs.current()).toBe(0);
    expect(await route('PUT', { kept: -3 })).toEqual({ status: 400, body: { error: 'Enter 0 (keep every command) to 1000.' } });
    expect(await route('PUT', { kept: '20' })).toEqual({ status: 400, body: { error: 'Enter a whole number.' } });
    const again = new CommandsKept({ settings });
    await again.loaded;
    expect(again.current()).toBe(0);
  });
});
