// The sidebar row's right-hand slot: dot, or the changed-files and request icons with their tones and
// labels, or nothing; and the Archive button offered on hover.
import { describe, expect, it } from 'vitest';
import type { ChangeCounts, PullRequest, PullRequestLookup } from './details.ts';
import { archiveLabel, asksForChanges, asksForRequest, changesIcon, offersArchive, rowSlot } from './row-slot.ts';
import { LOADING, ready, unavailable } from './sourced.ts';

const open: PullRequest = { number: 12, title: 'Fix', state: 'open', checks: 'running', review: 'none', url: 'https://example.test/12' };
const lookup = (host: PullRequestLookup['host'], ...pullRequests: PullRequest[]) => ready<PullRequestLookup>({ host, pullRequests });
const counts = (changed: number, uncommitted: number) => ready<ChangeCounts>({ changed, uncommitted });

describe('asksForRequest', () => {
  it('asks only for a row with no dot whose session has a branch', () => {
    expect(asksForRequest(false, 'feat/x')).toBe(true);
    expect(asksForRequest(true, 'feat/x')).toBe(false);
    expect(asksForRequest(false, null)).toBe(false);
    expect(asksForRequest(false, '')).toBe(false);
    expect(asksForRequest(false, undefined)).toBe(false);
  });
});

describe('asksForChanges', () => {
  it('asks only for a row with no dot whose session has a branch and a worktree', () => {
    expect(asksForChanges(false, { branch: 'feat/x', worktreePath: '/wt' })).toBe(true);
    expect(asksForChanges(true, { branch: 'feat/x', worktreePath: '/wt' })).toBe(false);
    expect(asksForChanges(false, { branch: null, worktreePath: '/wt' })).toBe(false);
    expect(asksForChanges(false, { branch: 'feat/x', worktreePath: null })).toBe(false);
  });
});

describe('changesIcon', () => {
  it('is amber while files are uncommitted, grey once all are committed, in the Changes button’s words', () => {
    expect(changesIcon(counts(3, 1))).toEqual({ tone: 'amber', label: '3 changed files · 1 uncommitted' });
    expect(changesIcon(counts(1, 0))).toEqual({ tone: 'muted', label: '1 changed file' });
  });
  it('is absent when nothing differs from the base, or there is no answer', () => {
    expect(changesIcon(counts(0, 0))).toBeNull();
    expect(changesIcon(LOADING)).toBeNull();
    expect(changesIcon(unavailable('The worktree folder is gone'))).toBeNull();
    expect(changesIcon(null)).toBeNull();
  });
});

describe('rowSlot', () => {
  it('keeps the dot whenever there is one, whatever the sources say', () => {
    expect(rowSlot(true, lookup('github', open), counts(2, 2))).toEqual({ kind: 'dot' });
    expect(rowSlot(true, null)).toEqual({ kind: 'dot' });
  });
  it('shows an open request in its status colour, in the host’s words', () => {
    expect(rowSlot(false, lookup('gitlab', open))).toEqual({ kind: 'icons', changes: null, request: { tone: 'amber', label: 'Merge request !12 · Checks running' } });
    expect(rowSlot(false, lookup('github', { ...open, checks: 'passing', readiness: 'ready' }))).toMatchObject({ request: { tone: 'green', label: 'Pull request #12 · Ready to merge' } });
    expect(rowSlot(false, lookup('github', { ...open, checks: 'failing' }))).toMatchObject({ request: { tone: 'red', label: 'Pull request #12 · Checks failed' } });
  });
  it('shows a draft too', () => {
    expect(rowSlot(false, lookup('github', { ...open, state: 'draft' }))).toMatchObject({ request: { tone: 'muted', label: 'Pull request #12 · Draft' } });
  });
  it('prefers the open request over an older merged one', () => {
    expect(rowSlot(false, lookup('github', { ...open, number: 9, state: 'merged' }, open))).toMatchObject({ kind: 'icons', request: { label: 'Pull request #12 · Checks running' } });
  });
  it('shows a merged request in purple; nothing for a closed one, none at all, or no answer yet', () => {
    expect(rowSlot(false, lookup('github', { ...open, state: 'merged' }))).toMatchObject({ request: { tone: 'purple', label: 'Pull request #12 · Merged' } });
    expect(rowSlot(false, lookup('github', { ...open, state: 'closed' }))).toEqual({ kind: 'none' });
    expect(rowSlot(false, lookup('github'))).toEqual({ kind: 'none' });
    expect(rowSlot(false, LOADING)).toEqual({ kind: 'none' });
    expect(rowSlot(false, unavailable('gh is not installed'))).toEqual({ kind: 'none' });
    expect(rowSlot(false, null)).toEqual({ kind: 'none' });
  });
  it('shows the changed-files icon alone, or before the request', () => {
    expect(rowSlot(false, null, counts(2, 0))).toEqual({ kind: 'icons', changes: { tone: 'muted', label: '2 changed files' }, request: null });
    expect(rowSlot(false, lookup('github', open), counts(2, 2))).toEqual({
      kind: 'icons',
      changes: { tone: 'amber', label: '2 changed files · 2 uncommitted' },
      request: { tone: 'amber', label: 'Pull request #12 · Checks running' },
    });
    expect(rowSlot(false, lookup('github'), counts(0, 0))).toEqual({ kind: 'none' });
  });
});

describe('offersArchive', () => {
  it('offers Archive when the row menu does: not while the session works or waits on an answer', () => {
    expect(offersArchive('done', false)).toBe(true);
    expect(offersArchive('interrupted', false)).toBe(true);
    expect(offersArchive('running', false)).toBe(false);
    expect(offersArchive('attention', false)).toBe(false);
  });
  it('not while the row is being renamed', () => {
    expect(offersArchive('done', true)).toBe(false);
  });
  it('names the session it archives', () => {
    expect(archiveLabel('Keyboard shortcuts')).toBe('Archive Keyboard shortcuts');
  });
});
