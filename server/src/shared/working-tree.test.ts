// The one answer to "which worktree does this session work in" (working-tree.ts), and its reasons.
import { describe, expect, it } from 'vitest';
import { DISCARDED, HOST_GONE, MAIN_CHECKOUT, sessionFinder, workingTreeOf, worktreeOwnerId, worktreeSharers, type TreeSession } from './working-tree.ts';

const host: TreeSession = { id: 'h', title: 'Fix the inputs', worktreePath: '/wt/h', branch: 'kestrel/inputs', worktreeDiscarded: false };
const guest: TreeSession = { id: 'g', title: 'Restyle', worktreePath: null, branch: null, worktreeDiscarded: false, hostId: 'h' };
const find = (...all: TreeSession[]) => sessionFinder({ sessions: all });

describe('workingTreeOf', () => {
  it('gives a session its own worktree', () => {
    expect(workingTreeOf(host, find(host))).toEqual({ tree: { path: '/wt/h', branch: 'kestrel/inputs', ownerId: 'h', host: null } });
  });

  it('gives a guest its host’s worktree and branch, and names the host', () => {
    expect(workingTreeOf(guest, find(host, guest))).toEqual({ tree: { path: '/wt/h', branch: 'kestrel/inputs', ownerId: 'h', host: { id: 'h', title: 'Fix the inputs' } } });
  });

  it('gives a session on another computer its branch there, with no folder here', () => {
    const away: TreeSession = { id: 'a', title: 'Away', worktreePath: null, branch: 'kestrel/away', worktreeDiscarded: false, runsOn: 'mini-1' };
    expect(workingTreeOf(away, find(away))).toEqual({ tree: { path: '', branch: 'kestrel/away', ownerId: 'a', host: null } });
    const awayGuest: TreeSession = { ...guest, id: 'ag', hostId: 'a', runsOn: 'mini-1' };
    expect(workingTreeOf(awayGuest, find(away, awayGuest)).tree).toEqual({ path: '', branch: 'kestrel/away', ownerId: 'a', host: { id: 'a', title: 'Away' } });
    expect(workingTreeOf({ ...away, branch: null }, find(away)).tree).toBeNull();
  });

  it('finds an archived host', () => {
    expect(workingTreeOf(guest, sessionFinder({ sessions: [guest], archived: { sessions: [host] } })).tree?.path).toBe('/wt/h');
  });

  it('says why there is none', () => {
    expect(workingTreeOf({ ...host, worktreePath: null, branch: null }, find())).toMatchObject({ tree: null, reason: MAIN_CHECKOUT, discarded: false });
    expect(workingTreeOf({ ...host, worktreePath: null, worktreeDiscarded: true }, find())).toMatchObject({ tree: null, reason: DISCARDED, discarded: true });
    expect(workingTreeOf(guest, find(guest))).toMatchObject({ tree: null, reason: HOST_GONE, host: null });
    expect(workingTreeOf(guest, find({ ...host, worktreePath: null, worktreeDiscarded: true }, guest))).toMatchObject({ tree: null, reason: 'The worktree of "Fix the inputs", where this session worked, was discarded', host: { id: 'h' }, discarded: true });
    expect(workingTreeOf(guest, find({ ...host, worktreePath: null }, guest))).toMatchObject({ tree: null, reason: '"Fix the inputs" works in the main checkout, so there is no worktree to compare with' });
  });

  it('holds a guest’s requests under its host, and lists everyone in a worktree with the owner first', () => {
    expect(worktreeOwnerId(guest)).toBe('h');
    expect(worktreeOwnerId(host)).toBe('h');
    expect(worktreeSharers([guest, { id: 'x' }, host], 'h').map((s) => s.id)).toEqual(['h', 'g']);
  });
});
