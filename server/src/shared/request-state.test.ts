// The newest linked request's state (request-state.ts): highest number on the host linked to most
// recently, unknown when not stored, and grouped per session.
import { describe, expect, it } from 'vitest';
import type { RequestLink } from '../model.ts';
import type { PullRequestState } from './details.ts';
import type { HostKind } from './host-terms.ts';
import { isPullRequestState, newestRequestState, requestStatesBySession } from './request-state.ts';

const link = (number: number, state: PullRequestState | undefined, linkedAt = 1, host: HostKind = 'github'): RequestLink => ({ host, number, url: `u${number}`, branch: 'b', linkedAt, ...(state ? { state } : {}) });

describe('the newest linked request', () => {
  it('is none without links', () => {
    expect(newestRequestState([])).toBeNull();
  });

  it('is the highest number, whatever order they were linked in', () => {
    expect(newestRequestState([link(9, 'open'), link(4, 'merged')])).toBe('open');
    expect(newestRequestState([link(4, 'open', 1), link(9, 'merged', 2)])).toBe('merged');
  });

  it('decides alone: an older open one under a newer merged one does not count', () => {
    expect(newestRequestState([link(3, 'open'), link(5, 'merged')])).toBe('merged');
    expect(newestRequestState([link(3, 'open'), link(5, 'draft')])).toBe('draft');
  });

  it('is unknown when its state was never stored', () => {
    expect(newestRequestState([link(3, 'open'), link(5, undefined)])).toBeNull();
  });

  it('is on the host linked to most recently', () => {
    expect(newestRequestState([link(90, 'merged', 1, 'gitlab'), link(2, 'open', 5)])).toBe('open');
  });
});

describe('per session', () => {
  it('groups the rows by session; a session with none is not listed', () => {
    const states = requestStatesBySession([
      { ...link(1, 'open'), sessionId: 'a' },
      { ...link(2, 'closed'), sessionId: 'b' },
      { ...link(3, 'open'), sessionId: 'b' },
    ]);
    expect([...states]).toEqual([
      ['a', 'open'],
      ['b', 'open'],
    ]);
  });

  it('knows only the four states', () => {
    expect(['open', 'draft', 'merged', 'closed'].every(isPullRequestState)).toBe(true);
    expect(isPullRequestState('approved')).toBe(false);
    expect(isPullRequestState(null)).toBe(false);
  });
});
