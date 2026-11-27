// What another machine sends is read through these parsers only (machines.ts), and the line a remote
// conversation shows when its copy is behind and its machine did not answer.
import { describe, expect, it } from 'vitest';
import { asHeadRecord, asRemotePage, asRemotePatch, notAnsweredText, notReachedSettings, paneThere } from './machines.ts';

describe('notAnsweredText', () => {
  const at = new Date(2026, 10, 25, 14, 2).getTime();
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  it('says as of when this computer last read it, naming the day when it was not today', () => {
    expect(notAnsweredText('Mac mini', at, at + 60_000)).toBe(`Mac mini did not answer. Shown as of ${time}; anything newer is still on Mac mini.`);
    expect(notAnsweredText('Mac mini', at, at + 2 * 86_400_000)).toMatch(new RegExp(`^Mac mini did not answer\\. Shown as of .+, ${time}; anything newer is still on Mac mini\\.$`));
    expect(notAnsweredText('Mac mini', null)).toBe('Mac mini did not answer. Anything newer than what is shown is still on Mac mini.');
    expect(notAnsweredText('Mac mini', at, at)).not.toMatch(/asleep/);
  });
});

describe('what another machine sends', () => {
  it('a page keeps only messages, and is refused when it is not a page', () => {
    expect(asRemotePage({ messages: [{ id: 'm1', author: 'agent', time: '', text: 'hi' }, { author: 'robot', text: 'x' }, 'junk'], before: null, total: 1 })).toEqual({ messages: [{ id: 'm1', author: 'agent', time: '', text: 'hi' }], before: null, total: 1 });
    expect(asRemotePage({ messages: [], before: 7, total: 1 })).toBeNull();
    expect(asRemotePage(null)).toBeNull();
  });

  it('a live patch keeps what a window draws of the session, drops what does not read as it, and never the agent’s raw output', () => {
    expect(asRemotePatch({ messages: [{ id: 'm1', author: 'agent', time: '', text: 'hi' }], status: 'Thinking…', files: [{ path: 'no-status' }], agentOutput: 'x', removedMessages: ['m0', 3] })).toEqual({ messages: [{ id: 'm1', author: 'agent', time: '', text: 'hi' }], status: 'Thinking…', files: [], removedMessages: ['m0'] });
    expect(asRemotePatch({ files: [] })).toEqual({ files: [] });
    expect(asRemotePatch({ agentOutput: 'x' })).toBeNull();
  });
});

describe('a head’s model and mode (issue 79)', () => {
  const head = { id: 's1', title: 'Fix it', agent: 'codex', state: 'done', createdAt: 1, updatedAt: 2 };
  const record = (session: Record<string, unknown>) => asHeadRecord({ kind: 'head', machine: { id: 'mini-1', name: 'Mac mini' }, session });

  it('keeps them when they read as a model and a mode, effort and fast mode included', () => {
    expect(record({ ...head, settings: { model: 'gpt-5', permission: 'bypass', effort: 'high', fast: true } })!.head.settings).toEqual({ model: 'gpt-5', permission: 'bypass', effort: 'high', fast: true });
  });

  it('leaves them out when they do not, or when an older machine never said them', () => {
    expect(record({ ...head, settings: { model: 'gpt-5', permission: 'everything' } })!.head).not.toHaveProperty('settings');
    expect(record({ ...head, settings: 'auto' })!.head).not.toHaveProperty('settings');
    expect(record(head)!.head).not.toHaveProperty('settings');
  });

  it('says why they cannot be changed while their computer cannot be reached', () => {
    expect(notReachedSettings('Mac mini')).toBe("Mac mini cannot be reached, so this session's model and mode cannot be changed from here now. Try again when it is back.");
  });
});

describe('what stays on the computer a session runs on', () => {
  it('names the pane and the computer', () => {
    expect(paneThere('terminal', 'Mac mini')).toBe('The terminal is on Mac mini.');
    expect(paneThere('browser', 'Mac mini')).toBe('The browser pane is on Mac mini.');
    expect(paneThere('simulator', 'Mac mini')).toBe('The simulator is on Mac mini.');
  });
});
