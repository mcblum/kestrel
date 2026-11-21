import { describe, expect, it } from 'vitest';
import { heldHint, holdWhy, isSlashCommand, midTurnLabel, retriesMidTurn, type HoldCheck } from './mid-turn.ts';
import { EMPTY_QUEUE, enqueue, hasUserMessages, requeueFront, takeLeading, type QueuedMessage } from './queue.ts';

const free: HoldCheck = { cardPending: false, changesSettings: false, slashCommand: false, heldBefore: false, canTake: true };

describe('whether a message written during a turn goes in at once', () => {
  it('goes when nothing stands in the way', () => {
    expect(holdWhy(free)).toBeNull();
  });

  it('is held, with the first reason that applies', () => {
    expect(holdWhy({ ...free, heldBefore: true, cardPending: true })).toBe('behind');
    expect(holdWhy({ ...free, cardPending: true, changesSettings: true })).toBe('card');
    expect(holdWhy({ ...free, changesSettings: true, slashCommand: true })).toBe('settings');
    expect(holdWhy({ ...free, slashCommand: true, canTake: false })).toBe('command');
    expect(holdWhy({ ...free, canTake: false })).toBe('busy');
  });

  it('knows a slash command', () => {
    expect(isSlashCommand('/compact')).toBe(true);
    expect(isSlashCommand('  /review now')).toBe(true);
    expect(isSlashCommand('see /tmp/x')).toBe(false);
    expect(isSlashCommand('/ not one')).toBe(false);
  });

  it('tries again mid-turn only what may clear within the turn', () => {
    expect(['card', 'behind', 'busy'].map((w) => retriesMidTurn(w as never))).toEqual([true, true, true]);
    expect(['settings', 'command', 'unread', undefined].map((w) => retriesMidTurn(w as never))).toEqual([false, false, false, false]);
  });

  it('says plainly why held messages wait', () => {
    expect(heldHint('card', true, false, 1)).toMatch(/once you have answered above/);
    expect(heldHint('settings', true, false, 2)).toMatch(/^They go when this turn ends/);
    expect(heldHint('command', true, false, 1)).toMatch(/slash command/);
    expect(heldHint('unread', false, true, 1)).toMatch(/^Not read/);
    expect(heldHint('busy', false, true, 1)).toMatch(/^Not sent/);
    expect(heldHint('busy', true, false, 1)).toMatch(/could not take it in the middle/);
    expect(heldHint(undefined, true, false, 2)).toBe('They go when this turn ends.');
    expect(midTurnLabel('sent')).toBe('Sent while it worked');
    expect(midTurnLabel('read')).toBe('Read by the agent');
  });
});

const q = (...items: QueuedMessage[]) => items.reduce(enqueue, EMPTY_QUEUE);

describe('held messages around a running turn', () => {
  it('puts unread messages back in front, in their order, held after a stop', () => {
    const back = requeueFront(q({ id: 'c', text: 'c' }), [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }], true);
    expect(back.items.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(back.held).toBe(true);
    const same = q({ id: 'c', text: 'c' });
    expect(requeueFront(same, [], true)).toBe(same);
  });

  it("takes the user's leading messages that may go now, passing over another session's, stopping at one that may not", () => {
    const queue = q({ id: 'a', text: 'a', why: 'card' }, { id: 'x', text: 'ask', fromAgent: true }, { id: 'b', text: 'b', why: 'behind' }, { id: 'c', text: 'c', why: 'settings' }, { id: 'd', text: 'd', why: 'behind' });
    const { items, queue: rest } = takeLeading(queue, (m) => m.why !== 'settings');
    expect(items.map((m) => m.id)).toEqual(['a', 'b']);
    expect(rest.items.map((m) => m.id)).toEqual(['x', 'c', 'd']);
    expect(takeLeading({ ...queue, held: true }, () => true).items).toEqual([]);
  });

  it("knows whether any of the user's own messages wait", () => {
    expect(hasUserMessages(q({ id: 'x', text: 'ask', fromAgent: true }))).toBe(false);
    expect(hasUserMessages(q({ id: 'x', text: 'ask', fromAgent: true }, { id: 'a', text: 'a' }))).toBe(true);
  });
});
