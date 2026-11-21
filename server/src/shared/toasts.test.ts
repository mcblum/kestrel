// Toasts: how many are held, how long each stays, and which one ⌘Z undoes.
import { describe, expect, it } from 'vitest';
import { counted, MAX_TOASTS, TOAST_MS, toastDuration, undoable, UNDO_TOAST_MS, withoutToast, withToast, type Toast } from './toasts.ts';

const note = (id: number, undo?: () => void): Toast => ({ id, message: `note ${id}`, ...(undo ? { undo } : {}) });

describe('toasts', () => {
  it('are added at the end, the oldest dropped past the most shown at once', () => {
    let list: Toast[] = [];
    for (let id = 1; id <= MAX_TOASTS + 2; id += 1) list = withToast(list, note(id));
    expect(list.map((t) => t.id)).toEqual([3, 4, 5]);
    expect(withoutToast(list, 4).map((t) => t.id)).toEqual([3, 5]);
  });

  it('stay longer when there is something to undo', () => {
    expect(toastDuration(note(1))).toBe(TOAST_MS);
    expect(toastDuration(note(1, () => undefined))).toBe(UNDO_TOAST_MS);
    expect(UNDO_TOAST_MS).toBeGreaterThan(TOAST_MS);
  });

  it('the newest one that can be undone is what the undo key undoes', () => {
    const list = [note(1, () => undefined), note(2, () => undefined), note(3)];
    expect(undoable(list)?.id).toBe(2);
    expect(undoable([note(1)])).toBeUndefined();
  });

  it('counts in words', () => {
    expect(counted(1, 'review request')).toBe('1 review request');
    expect(counted(12, 'review request')).toBe('12 review requests');
  });
});
