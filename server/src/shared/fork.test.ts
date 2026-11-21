import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model.ts';
import { forkItem } from './menu.ts';
import { FORKS, forkCut, forkRefusal, forkTitle, NO_FORK_POINT, uncommittedNotice } from './fork.ts';

describe('who may fork', () => {
  it('a Claude or Codex session between turns', () => {
    expect(forkRefusal({ agent: 'claude', working: false })).toBeNull();
    expect(forkRefusal({ agent: 'codex', working: false })).toBeNull();
  });
  it('not while a turn runs or waits on the user: only at a turn boundary', () => {
    expect(forkRefusal({ agent: 'claude', working: true })).toBe('Wait for the turn to end');
  });
  it('not an agent whose SDK cannot fork, saying which', () => {
    expect(FORKS.opencode).toBe(false);
    expect(forkRefusal({ agent: 'opencode', working: false })).toBe('OpenCode cannot fork a conversation');
    // The agent comes first: waiting would not help.
    expect(forkRefusal({ agent: 'opencode', working: true })).toBe('OpenCode cannot fork a conversation');
  });
});

describe('what a fork is called', () => {
  it('the old title, marked as a fork', () => {
    expect(forkTitle('Invoice export')).toBe('Invoice export (fork)');
  });
  it('does not grow on a fork of a fork', () => {
    expect(forkTitle(forkTitle('Invoice export'))).toBe('Invoice export (fork)');
    expect(forkTitle('Invoice export (fork) (fork)')).toBe('Invoice export (fork)');
  });
  it('stays within the title length, cutting the old title', () => {
    const long = 'x'.repeat(80);
    const title = forkTitle(long);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith('… (fork)')).toBe(true);
  });
  it('names an untitled session', () => {
    expect(forkTitle('  ')).toBe('Untitled (fork)');
  });
});

describe('the notice about uncommitted changes', () => {
  it('says how many stayed behind and where', () => {
    expect(uncommittedNotice('Invoice export', 1)).toBe('“Invoice export” had 1 uncommitted change in its worktree when this fork was made. It stays there: this fork’s worktree has the commits only.');
    expect(uncommittedNotice('Invoice export', 3)).toContain('3 uncommitted changes');
  });
});

describe('forking from a turn', () => {
  const you = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, author: 'you', time: '', text: id, ...extra });
  const agent = (id: string): ChatMessage => ({ id, author: 'agent', time: '', text: id });
  const messages = [you('u1', { forkPoint: 'p1' }), agent('a1'), you('u2'), agent('a2'), you('u3', { forkPoint: 'p3' }), agent('a3')];
  const refuse = (reason: string) => new Error(reason);

  it('any turn while a turn runs: wait, whatever the turn', () => {
    expect(forkRefusal({ agent: 'claude', working: true, turn: { turn: 'u1', latest: false, point: true } })).toBe('Wait for the turn to end');
  });
  it('an earlier turn needs its point; the last turn never does', () => {
    expect(forkRefusal({ agent: 'claude', working: false, turn: { turn: 'u2', latest: false, point: false } })).toBe(NO_FORK_POINT);
    expect(forkRefusal({ agent: 'claude', working: false, turn: { turn: 'u3', latest: true, point: false } })).toBeNull();
    expect(forkRefusal({ agent: 'codex', working: false, turn: { turn: 'u1', latest: false, point: true } })).toBeNull();
  });
  it('the turn foot’s item names its turn, except the last turn’s, which forks from the end as the menu does', () => {
    expect(forkItem('s', 'claude', false, { turn: 'u1', latest: false, point: true }).action).toEqual({ type: 'fork-session', sessionId: 's', turn: 'u1' });
    expect(forkItem('s', 'claude', false, { turn: 'u3', latest: true, point: true }).action).toEqual({ type: 'fork-session', sessionId: 's' });
    expect(forkItem('s', 'claude', false, { turn: 'u2', latest: false, point: false })).toMatchObject({ disabled: true, hint: NO_FORK_POINT });
  });
  it('cuts the conversation after the turn and takes its point', () => {
    expect(forkCut(messages, 'u1', refuse)).toEqual({ messages: messages.slice(0, 2), at: 'p1', earlier: true });
    expect(forkCut(messages, 'u3', refuse)).toEqual({ messages, earlier: false });
    expect(forkCut(messages, undefined, refuse)).toEqual({ messages, earlier: false });
  });
  it('refuses a turn with no point, and one that is not there', () => {
    expect(() => forkCut(messages, 'u2', refuse)).toThrow(NO_FORK_POINT);
    expect(() => forkCut(messages, 'a1', refuse)).toThrow('That turn is not in the conversation');
  });
});
