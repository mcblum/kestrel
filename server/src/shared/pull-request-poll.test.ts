import { describe, expect, test } from 'vitest';
import type { PullRequest } from './details.ts';
import { LOADING, ready, unavailable } from './sourced.ts';
import { CHANGING_POLL_MS, IDLE_POLL_MS, nextPullRequestAsk, OPEN_POLL_MS, pullRequestPollMs, WATCHED_POLL_MS } from './pull-request-poll.ts';

const open: PullRequest = { number: 7, title: 'Docs', url: 'https://example.com/7', state: 'open', checks: 'passing', review: 'none', readiness: 'ready' };
const lookup = (...pullRequests: PullRequest[]) => ready({ host: 'github' as const, pullRequests });

describe('pullRequestPollMs', () => {
  test('an open request is asked about every minute', () => {
    expect(pullRequestPollMs(lookup(open))).toBe(OPEN_POLL_MS);
  });
  test('sooner while its checks run or its readiness is not known', () => {
    expect(pullRequestPollMs(lookup({ ...open, checks: 'running' }))).toBe(CHANGING_POLL_MS);
    expect(pullRequestPollMs(lookup({ ...open, readiness: undefined }))).toBe(CHANGING_POLL_MS);
  });
  test('never once it is merged or closed, unless another one is still open', () => {
    expect(pullRequestPollMs(lookup({ ...open, state: 'merged' }))).toBeNull();
    expect(pullRequestPollMs(lookup({ ...open, state: 'closed' }))).toBeNull();
    expect(pullRequestPollMs(lookup({ ...open, number: 6, state: 'merged' }, open))).toBe(OPEN_POLL_MS);
  });
  test('slowly while none is linked or the host could not be asked', () => {
    expect(pullRequestPollMs(lookup())).toBe(IDLE_POLL_MS);
    expect(pullRequestPollMs(LOADING)).toBe(IDLE_POLL_MS);
    expect(pullRequestPollMs(unavailable('gh is not installed'))).toBe(IDLE_POLL_MS);
  });
});

describe('nextPullRequestAsk', () => {
  test('a session a window has open is asked about every few seconds, whatever it last answered', () => {
    expect(nextPullRequestAsk(lookup(open), 1000, true)).toBe(1000 + WATCHED_POLL_MS);
    expect(nextPullRequestAsk(lookup(), 1000, true)).toBe(1000 + WATCHED_POLL_MS);
    expect(nextPullRequestAsk(unavailable('gh is not installed'), 1000, true)).toBe(1000 + WATCHED_POLL_MS);
  });
  test('one nobody has open keeps the slower pace', () => {
    expect(nextPullRequestAsk(lookup(open), 1000, false)).toBe(1000 + OPEN_POLL_MS);
    expect(nextPullRequestAsk(lookup(), 1000, false)).toBe(1000 + IDLE_POLL_MS);
  });
  test('merged or closed is never asked about again, open or not', () => {
    expect(nextPullRequestAsk(lookup({ ...open, state: 'merged' }), 1000, true)).toBeNull();
  });
});
