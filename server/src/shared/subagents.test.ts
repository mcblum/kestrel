import { describe, expect, it } from 'vitest';
import { anyRunning, appendSubagentOutput, applySubagent, isSubagentTool } from './subagents.ts';

describe('sub-agents listed under a session', () => {
  it('knows Claude\'s sub-agent tool by either name', () => {
    expect(isSubagentTool('Agent')).toBe(true);
    expect(isSubagentTool('Task')).toBe(true);
    expect(isSubagentTool('Bash')).toBe(false);
  });
  it('adds one when it starts and marks it when it ends', () => {
    let list = applySubagent([], { id: 'a', summary: 'Check the last commit', status: 'started' });
    expect(list).toEqual([{ id: 'a', title: 'Check the last commit', status: 'running', output: '' }]);
    list = applySubagent(list, { id: 'b', summary: 'Read the docs', status: 'started' });
    list = applySubagent(list, { id: 'a', summary: 'Check the last commit', status: 'finished' });
    list = applySubagent(list, { id: 'b', summary: 'Read the docs', status: 'failed' });
    expect(list.map((x) => x.status)).toEqual(['done', 'failed']);
  });
  it('keeps what a helper said and did, then what it handed back', () => {
    let list = applySubagent([], { id: 'a', summary: 'Check', status: 'started' });
    list = appendSubagentOutput(list, 'a', '› Run git log');
    list = appendSubagentOutput(list, 'a', 'The last commit was Friday.');
    list = appendSubagentOutput(list, 'unknown', 'ignored');
    list = applySubagent(list, { id: 'a', summary: 'Check', status: 'finished', detail: 'Friday' });
    expect(list[0]!.output).toBe('› Run git log\nThe last commit was Friday.\n\nReturned:\nFriday');
  });
  it('knows whether any helper is still working', () => {
    const running = applySubagent([], { id: 'a', summary: 'x', status: 'started' });
    expect(anyRunning(running)).toBe(true);
    expect(anyRunning(applySubagent(running, { id: 'a', summary: 'x', status: 'finished' }))).toBe(false);
    expect(anyRunning([])).toBe(false);
  });
  it('ignores a repeated start and an end it never saw start', () => {
    const one = applySubagent([], { id: 'a', summary: 'x', status: 'started' });
    expect(applySubagent(one, { id: 'a', summary: 'x', status: 'started' })).toHaveLength(1);
    expect(applySubagent(one, { id: 'zzz', summary: 'y', status: 'finished' })).toEqual(one);
  });
});
