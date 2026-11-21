import { describe, expect, it } from 'vitest';
import { addTurnCost, baseParts, costText, isGitStatus, isPullRequest, middleSplit, middleTruncate, readUsage, syncState, syncText } from './details.ts';
import { asSourced, LOADING, ready, reasonOf, unavailable } from './sourced.ts';

describe('usage accumulation', () => {
  it('adds each reported turn cost and counts the turns, without changing the value it was given', () => {
    const one = addTurnCost(null, 0.25);
    expect(one).toEqual({ costUsd: 0.25, turns: 1 });
    const two = addTurnCost(one, 0.17);
    expect(two).toEqual({ costUsd: expect.closeTo(0.42, 10), turns: 2 });
    expect(one).toEqual({ costUsd: 0.25, turns: 1 });
  });
  it('leaves usage as it was when a turn reports no cost, so nothing is invented', () => {
    expect(addTurnCost(null, undefined)).toBeNull();
    expect(addTurnCost({ costUsd: 1, turns: 3 }, undefined)).toEqual({ costUsd: 1, turns: 3 });
    expect(addTurnCost(null, Number.NaN)).toBeNull();
    expect(addTurnCost(null, -1)).toBeNull();
  });
  it('reads a stored value only when it is one (an older store has none)', () => {
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage({ costUsd: 'x', turns: 1 })).toBeNull();
    expect(readUsage({ costUsd: 0.5, turns: 2 })).toEqual({ costUsd: 0.5, turns: 2 });
  });
  it('says the cost in dollars, a fraction of a cent as under one', () => {
    expect(costText({ costUsd: 11.36 })).toBe('$11.36');
    expect(costText({ costUsd: 0 })).toBe('$0.00');
    expect(costText({ costUsd: 0.004 })).toBe('<$0.01');
  });
});

describe('ahead and behind, said', () => {
  it('names the state without the base, and is up to date only when both are zero', () => {
    expect(syncText({ ahead: 0, behind: 0 })).toBe('Up to date');
    expect(syncText({ ahead: 2, behind: 0 })).toBe('2 commits ahead');
    expect(syncText({ ahead: 0, behind: 1 })).toBe('1 commit behind');
    expect(syncText({ ahead: 2, behind: 1 })).toBe('Diverged · 2 ahead, 1 behind');
    expect(syncState({ ahead: 2, behind: 1 })).toBe('diverged');
    expect(syncState({ ahead: 0, behind: 3 })).toBe('behind');
  });
});

describe('the base, taken apart', () => {
  it('splits a branch and its commit, a bare commit, and keeps anything else whole', () => {
    expect(baseParts('mcblum/chore/fix-stupid-lambdas at 758ee2c')).toEqual({ branch: 'mcblum/chore/fix-stupid-lambdas', commit: '758ee2c' });
    expect(baseParts('base 1a2b3c4')).toEqual({ branch: null, commit: '1a2b3c4' });
    expect(baseParts('something else')).toEqual({ branch: 'something else', commit: null });
  });
});

describe('middleSplit', () => {
  it('keeps a path’s last segment, slash included, as the tail when it is short enough', () => {
    expect(middleSplit('~/.kestrel/worktrees/cdo-modules-ab07f9cf', 24)).toEqual({ head: '~/.kestrel/worktrees', tail: '/cdo-modules-ab07f9cf' });
  });
  it('keeps the last characters when the last segment is too long', () => {
    const branch = 'kestrel/please-re-review-this-pr-https-g-ab07f9cf';
    const { head, tail } = middleSplit(branch, 10);
    expect(tail).toBe('g-ab07f9cf');
    expect(head + tail).toBe(branch);
  });
  it('leaves a short value whole in the head', () => {
    expect(middleSplit('main', 10)).toEqual({ head: 'main', tail: '' });
    expect(middleSplit('abc', 0)).toEqual({ head: 'abc', tail: '' });
  });
  it('never makes the whole value the tail of a leading-slash path', () => {
    expect(middleSplit('/abcdefghijkl', 12)).toEqual({ head: '/', tail: 'abcdefghijkl' });
  });
});

describe('middleTruncate', () => {
  it('keeps short names and cuts long ones in the middle to the length asked for', () => {
    expect(middleTruncate('main', 22)).toBe('main');
    const cut = middleTruncate('kestrel/make-search-feel-instant-1a2b3c4d', 22);
    expect(cut).toHaveLength(22);
    expect(cut.startsWith('kestrel/ma')).toBe(true);
    expect(cut.endsWith('1a2b3c4d')).toBe(true);
    expect(cut).toContain('…');
  });
});

describe('Sourced values from a server', () => {
  it('keeps the three states apart', () => {
    expect(asSourced({ state: 'loading' }, isGitStatus, 'x')).toEqual(LOADING);
    expect(asSourced({ state: 'unavailable', reason: 'gh is not signed in' }, isGitStatus, 'x')).toEqual(unavailable('gh is not signed in'));
    const value = { ahead: 1, behind: 0, uncommitted: 0, baseLabel: 'main' };
    expect(asSourced({ state: 'ready', value }, isGitStatus, 'x')).toEqual(ready(value));
  });
  it('turns anything else (an older server, a bad value) into unavailable with the fallback reason, never ready', () => {
    expect(asSourced(undefined, isGitStatus, 'restart')).toEqual(unavailable('restart'));
    expect(asSourced({ error: 'Not found' }, isGitStatus, 'restart')).toEqual(unavailable('restart'));
    expect(asSourced({ state: 'ready', value: { ahead: -1 } }, isGitStatus, 'restart')).toEqual(unavailable('restart'));
    expect(asSourced({ state: 'unavailable' }, isGitStatus, 'restart')).toEqual(unavailable('restart'));
  });
  it('checks a pull request’s fields', () => {
    expect(isPullRequest({ number: 1, title: 't', state: 'open', checks: 'none', review: 'none', url: '' })).toBe(true);
    expect(isPullRequest({ number: 1, title: 't', state: 'weird', checks: 'none', review: 'none', url: '' })).toBe(false);
  });
  it('keeps an error to its first line', () => {
    expect(reasonOf(new Error('\nfatal: bad revision\nmore'))).toBe('fatal: bad revision');
  });
});
