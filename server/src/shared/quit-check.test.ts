// What quitting would stop: a turn under way. The shell's quit check asks the server this, and nothing else.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model.ts';
import { quitCheck } from './quit-check.ts';
import { turnUnderWay } from './turns.ts';

const s = (id: string, state: 'running' | 'attention' | 'done' | 'interrupted', note = '', title = `Session ${id}`) => ({ id, title, state, note });
const asked: ChatMessage = { author: 'you', time: '', text: 'go', sentAt: 1 };
const ended: ChatMessage = { ...asked, turnEndedAt: 2 };
const card = (resolved?: string): ChatMessage => ({ author: 'agent', time: '', text: '', input: { id: 'c', kind: 'approval', title: 'Run it', detail: 'x', tool: 'Bash', options: [], ...(resolved ? { resolved } : {}) } });

describe('turnUnderWay', () => {
  it('is under way until the turn that started last is stamped as ended', () => {
    expect(turnUnderWay([asked, card()])).toBe(true);
    expect(turnUnderWay([ended, card()])).toBe(false);
    expect(turnUnderWay([ended, { author: 'agent', time: '', text: 'done' }, { ...asked, sentAt: 3 }])).toBe(true);
  });
  it('cannot be known to have ended with no turn recorded', () => {
    expect(turnUnderWay([])).toBe(true);
  });
});

describe('quitCheck', () => {
  it('nothing working: an empty answer, so the shell quits without asking', () => {
    expect(quitCheck([s('a', 'done'), s('b', 'interrupted')], () => [])).toEqual({ working: [] });
  });

  it('a running agent is working', () => {
    expect(quitCheck([s('a', 'running')], () => undefined).working.map((x) => x.id)).toEqual(['a']);
  });

  it('a turn paused on the agent’s card is working; a finished turn with a card open is not', () => {
    const messages: Record<string, ChatMessage[]> = { paused: [asked, card()], finished: [ended, card()] };
    const check = quitCheck([s('paused', 'attention', 'Needs you · Run it'), s('finished', 'attention', 'Needs you · Review findings')], (id) => messages[id]);
    expect(check.working.map((x) => x.id)).toEqual(['paused']);
  });

  it('a failed run is not working: its turn ended', () => {
    expect(quitCheck([s('a', 'attention', 'Failed · the model refused')], () => [ended]).working).toEqual([]);
  });

  it('a session with no title is still named', () => {
    expect(quitCheck([s('a', 'running', '', '  ')], () => undefined).working[0]!.title).toBe('Untitled session');
  });
});
