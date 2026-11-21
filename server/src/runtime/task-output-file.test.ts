import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AgentHandle } from '../agents/types.ts';
import { Commands } from './commands.ts';
import { isTaskOutputPath, readOutputTail, taskIdOfOutput } from './task-output-file.ts';

function taskFile(name: string, text: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'kestrel-tasks-')), 'tasks');
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('task output files', () => {
  test('only absolute <name>.output files in a tasks folder are taken', () => {
    expect(isTaskOutputPath('/tmp/x/tasks/bl5bbdm2j.output')).toBe(true);
    expect(isTaskOutputPath('tasks/b.output')).toBe(false);
    expect(isTaskOutputPath('/etc/passwd')).toBe(false);
    expect(isTaskOutputPath('/tmp/x/other/b.output')).toBe(false);
  });

  test('a task output file is named for its task', () => {
    expect(taskIdOfOutput('/tmp/x/tasks/bl5bbdm2j.output')).toBe('bl5bbdm2j');
    expect(taskIdOfOutput('/tmp/x/other/b.output')).toBeUndefined();
  });

  test('reads the end of the file, saying when it is only the end', async () => {
    const path = taskFile('b1.output', 'tick 1\ntick 2\ntick 3\n');
    expect(await readOutputTail(path, 1000)).toEqual({ text: 'tick 1\ntick 2\ntick 3\n', truncated: false });
    expect(await readOutputTail(path, 7)).toEqual({ text: 'tick 3\n', truncated: true });
  });
});

describe('Commands with an output file', () => {
  // Seen live: Claude's process may never answer get_task_output. The file is read instead.
  const hangs: AgentHandle = { backgroundOutput: () => new Promise(() => {}) } as unknown as AgentHandle;

  test('a running background command shows what its file holds, without asking the agent', async () => {
    const path = taskFile('b1.output', 'tick 1\ntick 2\n');
    const commands = new Commands(() => 1000, () => {});
    commands.apply('s', 'Claude', { type: 'tool', id: 't1', name: 'Bash', summary: 'Run', status: 'started', command: 'loop' }, hangs);
    commands.apply('s', 'Claude', { type: 'tool', id: 't1', name: 'Bash', summary: 'Run', status: 'finished', inBackground: true, outputFile: path }, hangs);
    commands.apply('s', 'Claude', { type: 'background-tasks', tasks: [{ id: 'b1', kind: 'command', description: 'loop', toolId: 't1' }] }, hangs);
    expect(await commands.output('s', 't1', hangs, 'Claude')).toEqual({ text: 'tick 1\ntick 2\n', truncated: false });
  });

  test('once it ended with the agent gone, the file named in the end notice still shows', async () => {
    const path = taskFile('b2.output', 'tick 60\n\n[exited with code 0]\n');
    const commands = new Commands(() => 1000, () => {});
    commands.apply('s', 'Claude', { type: 'tool', id: 't2', name: 'Bash', summary: 'Run', status: 'started', command: 'loop' }, null);
    commands.apply('s', 'Claude', { type: 'tool', id: 't2', name: 'Bash', summary: 'Run', status: 'finished', inBackground: true }, null);
    commands.apply('s', 'Claude', { type: 'background-tasks', tasks: [{ id: 'b2', kind: 'command', description: 'loop', toolId: 't2' }] }, null);
    commands.apply('s', 'Claude', { type: 'background-ended', taskId: 'b2', status: 'completed', outputFile: path }, null);
    await new Promise((r) => setTimeout(r, 20));
    expect((await commands.output('s', 't2', null, 'Claude')).text).toContain('[exited with code 0]');
  });
});
