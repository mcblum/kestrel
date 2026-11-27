import { describe, expect, it } from 'vitest';
import type { Link } from '../model.ts';
import { AUTOPILOT_KIND } from '../suggestions/autopilot-kind.ts';
import { REQUEST_KIND } from '../suggestions/request-kind.ts';
import { REVIEW_KIND } from '../suggestions/review-kind.ts';
import type { PullRequest, PullRequestLookup } from './details.ts';
import { REQUEST_CARD_KINDS, cardSession, requestCardGone, requestCardHome } from './request-cards.ts';
import { ready, type Sourced } from './sourced.ts';

const link = (parentId: string, childId: string, kind: Link['kind'] = 'delegate'): Link => ({ id: `${parentId}-${childId}`, parentId, childId, kind });
const everyone = () => true;

describe('where a card about a pull request is shown', () => {
  it('a session nobody started as a child keeps its own', () => {
    expect(requestCardHome('a', [], [], everyone)).toBe('a');
    // A handoff is clean: the new session is a sibling, not a child.
    expect(requestCardHome('b', [link('a', 'b', 'handoff')], [], everyone)).toBe('b');
    expect(requestCardHome('b', [link('a', 'b', 'fork')], [], everyone)).toBe('b');
  });

  it('a delegate child’s goes to the top of its tree, however deep', () => {
    const links = [link('root', 'mid'), link('mid', 'leaf')];
    expect(requestCardHome('mid', links, [], everyone)).toBe('root');
    expect(requestCardHome('leaf', links, [], everyone)).toBe('root');
    expect(requestCardHome('root', links, [], everyone)).toBe('root');
  });

  it('to the workstream’s lead when the top is in one, and to the session itself when neither is in sight', () => {
    const links = [link('top', 'child')];
    expect(requestCardHome('child', links, [{ sessionIds: ['lead', 'top', 'child'] }], everyone)).toBe('lead');
    expect(requestCardHome('child', links, [{ sessionIds: ['lead', 'top', 'child'] }], (id) => id !== 'lead')).toBe('top');
    expect(requestCardHome('child', links, [], (id) => id === 'child')).toBe('child');
  });

  it('a card acts on the session it is about', () => {
    expect(cardSession({ sessionId: 'root', about: 'child' })).toBe('child');
    expect(cardSession({ sessionId: 'root' })).toBe('root');
  });

  it('covers the three kinds of card about a request, by their own names', () => {
    expect([...REQUEST_CARD_KINDS].sort()).toEqual([AUTOPILOT_KIND, REQUEST_KIND, REVIEW_KIND].sort());
  });
});

describe('when such a card goes by itself', () => {
  const pr = (state: PullRequest['state'], number = 7): PullRequest => ({ number, title: 'T', state, checks: 'passing', review: 'none', url: 'u' });
  const lookup = (...prs: PullRequest[]): Sourced<PullRequestLookup> => ready({ host: 'gitlab', pullRequests: prs });
  const card = (kind: string, payload: Record<string, unknown>) => ({ kind, payload, state: 'open' as const });

  it('its request was merged or closed', () => {
    expect(requestCardGone(card(AUTOPILOT_KIND, { host: 'gitlab', number: 7 }), lookup(pr('merged')))).toBe('!7 was merged');
    expect(requestCardGone(card(REVIEW_KIND, { reviewer: 'R', host: 'github', number: 7 }), lookup(pr('closed')))).toBe('#7 was closed');
    expect(requestCardGone(card(REQUEST_KIND, { number: 7, reason: 'conflicts' }), lookup(pr('merged')))).toBe('!7 was merged');
  });

  it('not while it is open or a draft, nor for another request, a card naming none, another kind, or no answer', () => {
    expect(requestCardGone(card(AUTOPILOT_KIND, { number: 7 }), lookup(pr('open')))).toBeNull();
    expect(requestCardGone(card(AUTOPILOT_KIND, { number: 7 }), lookup(pr('draft')))).toBeNull();
    expect(requestCardGone(card(AUTOPILOT_KIND, { number: 7 }), lookup(pr('merged', 8), pr('open')))).toBeNull();
    expect(requestCardGone(card(REVIEW_KIND, { reviewer: 'R', asked: true }), lookup(pr('merged')))).toBeNull();
    expect(requestCardGone(card('tag', { number: 7 }), lookup(pr('merged')))).toBeNull();
    expect(requestCardGone(card(AUTOPILOT_KIND, { number: 7 }), undefined)).toBeNull();
    expect(requestCardGone({ ...card(AUTOPILOT_KIND, { number: 7 }), state: 'answered' }, lookup(pr('merged')))).toBeNull();
  });
});
