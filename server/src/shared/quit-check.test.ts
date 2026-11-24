// What quitting would stop: a turn under way. The shell's quit check asks the server this, and nothing else.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../model.ts';
import { quitCheck, type Conversation } from './quit-check.ts';
import type { WaitingStep } from './waiting-steps.ts';
import { turnUnderWay } from './turns.ts';

const s = (id: string, state: 'running' | 'attention' | 'done' | 'interrupted', note = '', title = `Session ${id}`) => ({ id, title, state, note });
const asked: ChatMessage = { author: 'you', time: '', text: 'go', sentAt: 1 };
const ended: ChatMessage = { ...asked, turnEndedAt: 2 };
const card = (resolved?: string, kestrel = false): ChatMessage => ({ author: 'agent', time: '', text: '', input: { id: 'c', kind: 'approval', title: 'Run it', detail: 'x', tool: kestrel ? 'delegate' : 'Bash', options: [], ...(resolved ? { resolved } : {}), ...(kestrel ? { kestrel: true as const } : {}) } });

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
    expect(quitCheck([s('a', 'done'), s('b', 'interrupted')], () => ({ messages: [] }))).toEqual({ working: [], waiting: [] });
  });

  it('a running agent is working', () => {
    expect(quitCheck([s('a', 'running')], () => undefined).working.map((x) => x.id)).toEqual(['a']);
  });

  it('a turn paused on the agent’s card is working; a finished turn with a card open is not', () => {
    const messages: Record<string, ChatMessage[]> = { paused: [asked, card()], finished: [ended, card()] };
    const check = quitCheck([s('paused', 'attention', 'Needs you · Run it'), s('finished', 'attention', 'Needs you · Review findings')], (id) => ({ messages: messages[id]! }));
    expect(check.working.map((x) => x.id)).toEqual(['paused']);
  });

  it('a failed run is not working: its turn ended', () => {
    expect(quitCheck([s('a', 'attention', 'Failed · the model refused')], () => ({ messages: [ended, card()] }))).toEqual({ working: [], waiting: [] });
  });

  it('a finished turn with one of Kestrel’s own cards open and no step stored for it is waiting: a restart would close it', () => {
    const messages: Record<string, ChatMessage[]> = { own: [ended, card(undefined, true)], answered: [ended, card('Allow', true)], paused: [asked, card(undefined, true)] };
    const check = quitCheck(['own', 'answered', 'paused'].map((id) => s(id, 'attention')), (id) => ({ messages: messages[id]! }));
    expect(check.waiting.map((x) => x.id)).toEqual(['own']);
    expect(check.working.map((x) => x.id)).toEqual(['paused']);
  });

  it('one of Kestrel’s own cards whose step is stored survives a restart and holds nothing up; one being carried out does', () => {
    const step = (status: 'waiting' | 'taking'): WaitingStep => ({ requestId: 'c', call: { kind: 'tool', tool: 'delegate', args: {} }, card: { tool: 'delegate', title: 'Run it', detail: 'x' }, raisedAt: 1, status });
    const conversations: Record<string, Conversation> = { kept: { messages: [ended, card(undefined, true)], steps: [step('waiting')] }, taking: { messages: [ended, card(undefined, true)], steps: [step('taking')] } };
    const check = quitCheck(['kept', 'taking'].map((id) => s(id, 'attention')), (id) => conversations[id]);
    expect(check).toEqual({ working: [], waiting: [{ id: 'taking', title: 'Session taking' }] });
  });

  it('a session that is done or interrupted is never asked about, whatever its conversation holds', () => {
    expect(quitCheck([s('a', 'done'), s('b', 'interrupted')], () => ({ messages: [ended, card(undefined, true)] }))).toEqual({ working: [], waiting: [] });
  });

  it('a session with no title is still named', () => {
    expect(quitCheck([s('a', 'running', '', '  ')], () => undefined).working[0]!.title).toBe('Untitled session');
  });
});
