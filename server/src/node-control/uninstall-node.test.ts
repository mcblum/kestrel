import { describe, expect, test } from 'vitest';
import type { Session } from '../model.ts';
import { leaveAccount, worktreeWork, type GitCounts } from './uninstall-node.ts';

type Row = Pick<Session, 'id' | 'title' | 'worktreePath' | 'branch' | 'worktreeDiscarded' | 'hostId'>;
const session = (id: string, change: Partial<Row> = {}): Row => ({ id, title: `Session ${id}`, worktreePath: `/w/${id}`, branch: `kestrel/${id}`, worktreeDiscarded: false, ...change });

/** Git as a table: uncommitted and unpushed per worktree. */
const counts = (table: Record<string, [number, number]>): GitCounts & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    uncommitted: async (path) => (asked.push(`status ${path}`), table[path]?.[0] ?? 0),
    unpushed: async (path, branch) => (asked.push(`rev-list ${path} ${branch}`), table[path]?.[1] ?? 0),
  };
};

describe('worktreeWork', () => {
  test('asks git about every worktree a session owns that is still on disk, archived ones too', async () => {
    const git = counts({ '/w/a': [2, 0], '/w/b': [0, 1] });
    const rows = await worktreeWork([session('a'), session('b')], git, () => true);
    expect(rows).toEqual([
      { sessionId: 'a', title: 'Session a', uncommitted: 2, unpushed: 0 },
      { sessionId: 'b', title: 'Session b', uncommitted: 0, unpushed: 1 },
    ]);
  });

  test('skips a guest (its host owns the worktree), a discarded worktree, the main checkout and a folder gone from disk', async () => {
    const git = counts({});
    const rows = await worktreeWork([session('guest', { hostId: 'a' }), session('gone', { worktreeDiscarded: true }), session('main', { worktreePath: null }), session('deleted')], git, (path) => path !== '/w/deleted');
    expect(rows).toEqual([]);
    expect(git.asked).toEqual([]);
  });

  test('a worktree with no branch recorded has no commits to push', async () => {
    const rows = await worktreeWork([session('a', { branch: null })], counts({ '/w/a': [0, 9] }), () => true);
    expect(rows[0]!.unpushed).toBe(0);
  });
});

describe('leaveAccount (the node’s part of uninstall)', () => {
  const server = (sessions: Row[], leave: () => Promise<'left' | 'not-signed-in'>) => {
    let left = 0;
    return {
      handle: { workspace: { state: async () => ({ sessions, archived: { sessions: [] } }) }, connect: { leaveAccount: () => (left++, leave()) } } as never,
      left: () => left,
    };
  };

  test('refuses, naming the sessions, while work is not pushed, and does not leave the account', async () => {
    const s = server([session('a', { worktreePath: process.cwd() })], async () => 'left');
    const answer = await leaveAccount(s.handle, counts({ [process.cwd()]: [3, 0] }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining('"Session a": 3 uncommitted files') });
    expect(s.left()).toBe(0);
  });

  test('with nothing to lose, leaves the account and says so', async () => {
    const s = server([], async () => 'left');
    expect(await leaveAccount(s.handle, counts({}))).toEqual({ ok: true, message: expect.stringContaining('Removed this node from your Kestrel Connect account') });
    expect(s.left()).toBe(1);
  });

  test('a service that refuses is a refusal with its reason, never a throw', async () => {
    const s = server([], async () => Promise.reject(new Error('Kestrel Connect could not remove this computer from your account: offline.')));
    expect(await leaveAccount(s.handle, counts({}))).toEqual({ ok: false, reason: 'Not uninstalled: Kestrel Connect could not remove this computer from your account: offline.' });
  });
});
