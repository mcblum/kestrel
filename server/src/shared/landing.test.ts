import { describe, expect, it } from 'vitest';
import { discardLoss, REMOVE_WHILE_WORKING, REMOVE_WORKTREE_ID, worktreeMenuItems } from './landing.ts';

describe('landing text', () => {
  it('names what discarding loses, counting unmerged commits only when the branch goes too', () => {
    const p = { uncommitted: ['a.txt'], totalUnmerged: 2, target: 'main' };
    expect(discardLoss(p, false)).toBe('Lost for good: 1 uncommitted file.');
    expect(discardLoss(p, true)).toBe('Lost for good: 1 uncommitted file and 2 commits not in main.');
    expect(discardLoss({ uncommitted: [], totalUnmerged: 2, target: 'main' }, false)).toBeNull();
  });
});

describe('worktreeMenuItems', () => {
  it('offers removal, disabled while the agent works', () => {
    expect(worktreeMenuItems(false)).toEqual([{ id: REMOVE_WORKTREE_ID, label: 'Remove worktree…' }]);
    expect(worktreeMenuItems(true)[0]).toMatchObject({ disabled: true, hint: REMOVE_WHILE_WORKING });
  });
});
