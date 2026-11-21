import { describe, expect, it } from 'vitest';
import { syncBranch } from './branch-sync.ts';

const store = () => {
  const set: [string, string][] = [];
  return { set, setBranch: async (id: string, branch: string) => void set.push([id, branch]) };
};
const here = () => true;

describe('syncBranch', () => {
  it('records a branch renamed inside the worktree and answers with the new name', async () => {
    const s = store();
    expect(await syncBranch(s, { id: 'a', branch: 'kestrel/old', worktreePath: '/wt/a' }, async () => 'fix/real-name', here)).toBe('fix/real-name');
    expect(s.set).toEqual([['a', 'fix/real-name']]);
  });

  it('writes nothing when the branch is the same', async () => {
    const s = store();
    expect(await syncBranch(s, { id: 'a', branch: 'kestrel/a', worktreePath: '/wt/a' }, async () => 'kestrel/a', here)).toBe('kestrel/a');
    expect(s.set).toEqual([]);
  });

  it('keeps what it had with no worktree, a missing worktree, a detached HEAD or a git failure', async () => {
    const s = store();
    const never = async () => { throw new Error('must not be asked'); };
    expect(await syncBranch(s, { id: 'a', branch: null, worktreePath: null }, never, here)).toBeNull();
    expect(await syncBranch(s, { id: 'a', branch: 'kestrel/a', worktreePath: '/gone' }, never, () => false)).toBe('kestrel/a');
    expect(await syncBranch(s, { id: 'a', branch: 'kestrel/a', worktreePath: '/wt/a' }, async () => null, here)).toBe('kestrel/a');
    expect(await syncBranch(s, { id: 'a', branch: 'kestrel/a', worktreePath: '/wt/a' }, async () => { throw new Error('git broke'); }, here)).toBe('kestrel/a');
    expect(s.set).toEqual([]);
  });
});
