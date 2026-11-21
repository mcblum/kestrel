import { describe, expect, it } from 'vitest';
import { cameFromText, sessionCardLines, type SessionCardInput } from './session-card.ts';
import { whenText } from './when.ts';

const NOW = Date.UTC(2026, 10, 17, 15, 0);
const base: SessionCardInput = { title: 'Fix login', project: 'Kestrel', group: null, agent: 'Claude', status: 'Working', dot: '', note: '', mark: null, branch: null, activityAt: NOW - 60_000 };

describe('sessionCardLines', () => {
  it('says where the session lives, with its group and filing mark', () => {
    expect(sessionCardLines(base, NOW).place).toBe('Kestrel');
    expect(sessionCardLines({ ...base, group: 'November launch', mark: 'handed off' }, NOW).place).toBe('Kestrel · November launch · Handed off');
    expect(sessionCardLines({ ...base, project: null }, NOW).place).toBe('No project');
  });

  it('puts the agent before the status, and the dot only when it says something else', () => {
    expect(sessionCardLines({ ...base, dot: 'New output' }, NOW).status).toBe('Claude · Working · New output');
    expect(sessionCardLines({ ...base, dot: 'Working' }, NOW).status).toBe('Claude · Working');
    expect(sessionCardLines({ ...base, status: 'Needs you', dot: 'Needs your answer' }, NOW).status).toBe('Claude · Needs you');
  });

  it('shows the note only when it adds to the status', () => {
    expect(sessionCardLines({ ...base, note: 'Running the tests' }, NOW).note).toBe('Running the tests');
    expect(sessionCardLines({ ...base, note: 'working' }, NOW).note).toBeNull();
    expect(sessionCardLines({ ...base, note: '  ' }, NOW).note).toBeNull();
  });

  it('says when it was last active', () => {
    expect(sessionCardLines(base, NOW).when).toBe(`Last active ${whenText(NOW - 60_000, NOW)}`);
  });
});

describe('cameFromText', () => {
  it('names the parent by how the session came from it', () => {
    expect(cameFromText('handoff', 'Plan')).toBe('Handed off from Plan');
    expect(cameFromText('delegate', 'Plan')).toBe('Part of Plan');
    expect(cameFromText('fork', 'Plan')).toBe('Forked from Plan');
  });
});
