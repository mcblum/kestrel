import { describe, expect, test } from 'vitest';
import { allEnded, backgroundEnded, backgroundListed, commandReturned, commandStarted, DEFAULT_COMMANDS_KEPT, MAX_COMMANDS_KEPT, commandsKeptProblem, keepRecent, plainOutput, runningCount, tail, type SessionCommand, canRetry, restoredCommands, retryMessage, RETRY_IN_BACKGROUND } from './commands.ts';

const NO_STOP = 'Claude can only stop this by stopping the whole turn.';
const start = (list: readonly SessionCommand[], id: string, now = 1) => commandStarted(list, { id, description: `cmd ${id}`, command: `cmd ${id}` }, now, NO_STOP);

describe('commands', () => {
  test('a command a turn runs is listed as running and cannot be stopped on its own', () => {
    const list = start([], 'a');
    expect(list).toEqual([{ id: 'a', kind: 'command', description: 'cmd a', command: 'cmd a', status: 'running', since: 1, noStop: NO_STOP }]);
  });

  test('starting the same tool call twice lists it once', () => {
    expect(start(start([], 'a'), 'a')).toHaveLength(1);
  });

  test('its tool call returning ends it: completed or failed, with no stop note', () => {
    const done = commandReturned(start([], 'a'), 'a', true, false, 5);
    expect(done[0]).toMatchObject({ status: 'completed', endedAt: 5 });
    expect(done[0]!.noStop).toBeUndefined();
    expect(commandReturned(start([], 'a'), 'a', false, false, 5)[0]!.status).toBe('failed');
  });

  test('a command sent to the background keeps running after its tool call returns', () => {
    expect(commandReturned(start([], 'a'), 'a', true, true, 5)[0]!.status).toBe('running');
  });

  test('a command sent to the background with its output file named takes the task id, stoppable even if never listed', () => {
    const back = commandReturned(start([], 'a'), 'a', true, true, 5, 'b7');
    expect(back[0]).toMatchObject({ status: 'running', taskId: 'b7', unlisted: true });
    expect(back[0]!.noStop).toBeUndefined();
    // A list that leaves it out does not end it; one that names it makes it an ordinary listed task.
    expect(backgroundListed(back, [], 6)[0]!.status).toBe('running');
    const listed = backgroundListed(back, [{ id: 'b7', kind: 'command', description: 'cmd a', toolId: 'a' }], 7);
    expect(listed[0]!.unlisted).toBeUndefined();
    expect(backgroundListed(listed, [], 8)[0]!.status).toBe('completed');
    expect(backgroundEnded(back, 'b7', 'stopped', 9)[0]).toMatchObject({ status: 'stopped', endedAt: 9 });
    expect(backgroundEnded(back, 'b7', 'stopped', 9)[0]!.unlisted).toBeUndefined();
  });

  test('background work joins the command its tool call started and becomes stoppable', () => {
    const list = backgroundListed(start([], 'tool-1'), [{ id: 'task-1', kind: 'command', description: 'pnpm dev', toolId: 'tool-1', label: 'Start the dev server' }], 2);
    expect(list).toEqual([{ id: 'tool-1', kind: 'command', description: 'pnpm dev', command: 'cmd tool-1', label: 'Start the dev server', status: 'running', since: 1, taskId: 'task-1' }]);
  });

  test('background work whose tool call was not seen is added as its own command', () => {
    const list = backgroundListed([], [{ id: 'w', kind: 'watcher', description: 'Watch CI' }], 3);
    expect(list).toEqual([{ id: 'task:w', kind: 'watcher', description: 'Watch CI', taskId: 'w', status: 'running', since: 3 }]);
  });

  test('work listed before its tool call was known merges into that call’s command once it is', () => {
    const early = backgroundListed(start([], 'tool-1'), [{ id: 'task-1', kind: 'command', description: 'pnpm dev' }], 2);
    expect(early.map((c) => c.id).sort()).toEqual(['task:task-1', 'tool-1']);
    const tied = backgroundListed(early, [{ id: 'task-1', kind: 'command', description: 'pnpm dev', toolId: 'tool-1' }], 3);
    expect(tied).toEqual([expect.objectContaining({ id: 'tool-1', taskId: 'task-1', status: 'running' })]);
  });

  test('background work the list no longer holds has ended, as the agent said or else completed', () => {
    const listed = backgroundListed([], [{ id: 'x', kind: 'command', description: 'x' }, { id: 'y', kind: 'command', description: 'y' }], 1);
    const after = backgroundListed(listed, [], 9, new Map([['x', 'failed' as const]]));
    expect(after.map((c) => [c.taskId, c.status])).toEqual([['x', 'failed'], ['y', 'completed']]);
  });

  test('a task_notification ends that piece of work', () => {
    const listed = backgroundListed([], [{ id: 'x', kind: 'command', description: 'x' }], 1);
    expect(backgroundEnded(listed, 'x', 'stopped', 4)[0]).toMatchObject({ status: 'stopped', endedAt: 4 });
    expect(backgroundEnded(listed, 'other', 'stopped', 4)).toEqual(listed);
  });

  test('when the run ends, everything still running ends with it', () => {
    const list = allEnded(start(start([], 'a'), 'b'), 'stopped', 7);
    expect(list.every((c) => c.status === 'stopped' && c.endedAt === 7)).toBe(true);
    expect(runningCount(list)).toBe(0);
  });

  test('running commands come first, then the most recently ended, as many as are kept', () => {
    let list: SessionCommand[] = [];
    for (let i = 0; i < 15; i++) list = commandReturned(start(list, `e${i}`, i), `e${i}`, true, false, 100 + i);
    list = start(list, 'live', 500);
    expect(list[0]!.id).toBe('live');
    expect(list[1]!.id).toBe('e14');
    const kept = keepRecent(list, 10);
    expect(kept.map((c) => c.id)).toEqual(['live', ...[14, 13, 12, 11, 10, 9, 8, 7, 6].map((i) => `e${i}`)]);
    expect(keepRecent(list, 0)).toHaveLength(16); // 0 keeps every command
    expect(DEFAULT_COMMANDS_KEPT).toBe(50);
  });

  test('running commands are never dropped to make room', () => {
    let list: SessionCommand[] = [];
    for (let i = 0; i < 13; i++) list = start(list, `r${i}`, i);
    expect(keepRecent(list, 10)).toHaveLength(13);
  });

  test('the number kept is a whole number from 0 to the cap', () => {
    expect(commandsKeptProblem(0)).toBeNull();
    expect(commandsKeptProblem(MAX_COMMANDS_KEPT)).toBeNull();
    expect(commandsKeptProblem(-1)).toMatch(/0 \(keep every command\)/);
    expect(commandsKeptProblem(2.5)).toBe('Enter a whole number.');
    expect(commandsKeptProblem('50')).toBe('Enter a whole number.');
  });

  test('output is plain text: colours removed, carriage-return redraws kept to their last state', () => {
    expect(plainOutput('\u001b[32m✓\u001b[39m ok\n10%\r50%\r100%\ndone')).toBe('✓ ok\n100%\ndone');
  });

  test('tail keeps the end and says when it cut', () => {
    expect(tail('abcdef', 3)).toEqual({ text: 'def', truncated: true });
    expect(tail('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('commands kept across a restart', () => {
  const command = (id: string, status: 'running' | 'completed' | 'failed' | 'stopped') => ({ id, kind: 'command' as const, description: id, command: id, status, since: 10, ...(status === 'running' ? {} : { endedAt: 20 }) });

  test('come back as they were, with anything that was running ended as stopped', () => {
    const back = restoredCommands({ list: [command('a', 'completed'), command('b', 'running')], outputs: { a: 'ok', b: 'half', gone: 'x' } }, 99);
    // The list keeps its own order (most recent first); what matters is how each one ended.
    expect(back.list.map((c) => [c.id, c.status, c.endedAt]).sort()).toEqual([['a', 'completed', 20], ['b', 'stopped', 99]]);
    expect(back.outputs).toEqual({ a: 'ok', b: 'half' });
  });
});

describe('retrying a command', () => {
  test('is offered once a command has ended, however it ended', () => {
    expect(canRetry({ status: 'running' })).toBe(false);
    for (const status of ['completed', 'failed', 'stopped'] as const) expect(canRetry({ status })).toBe(true);
  });

  test('tells the agent the exact command, and for a failure the end of what it printed', () => {
    expect(retryMessage({ command: 'terraform plan', description: 'Plan', status: 'completed' }, 'ok')).toBe('Run this command again:\n\n```\nterraform plan\n```');
    expect(retryMessage({ command: 'terraform plan', description: 'Plan', status: 'stopped' }, '')).toMatch(/It was stopped before it finished\.$/);
    const failed = retryMessage({ command: 'terraform apply', description: 'Apply', status: 'failed' }, `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\nError: no credentials\n`);
    expect(failed).toMatch(/^Run this command again:\n\n```\nterraform apply\n```\n\nIt failed last time\. The end of what it printed:/);
    expect(failed).toContain('Error: no credentials');
    expect(failed).not.toContain('line 5\n');
    expect(failed).toMatch(/fix the cause first and say what you changed\.$/);
    expect(retryMessage({ description: 'Start the dev server', status: 'failed' }, '')).toMatch(/^Run this again: Start the dev server\n\nIt failed last time and printed nothing/);
  });

  test('asks for a command that ran in the background to run in the background again, not to be waited on', () => {
    const again = retryMessage({ command: 'sleep 150', description: 'Wait', status: 'completed', taskId: 'b1' }, '');
    expect(again).toBe(`Run this command again:\n\n\`\`\`\nsleep 150\n\`\`\`\n\n${RETRY_IN_BACKGROUND}`);
    expect(retryMessage({ command: 'sleep 150', description: 'Wait', status: 'completed' }, '')).not.toContain(RETRY_IN_BACKGROUND);
  });
});
