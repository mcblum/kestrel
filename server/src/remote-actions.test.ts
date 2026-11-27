// Which operation of the closed list each session route asks of the computer a session runs on, and how its
// answer comes back in the route's own shape (remote-actions.ts). The two-computer tests are in
// connect/link/remote-actions.test.ts; here the other computer is a stand-in that records what it was asked.
import { describe, expect, it } from 'vitest';
import type { RemoteAnswer } from './connect/link/remote-sessions.ts';
import { remoteActionRoute } from './remote-actions.ts';

const MINI = { id: 'mini', name: 'Mac mini' };

function computer(answer: RemoteAnswer) {
  const asked: { op: string; args: Record<string, unknown> }[] = [];
  const deps = { ask: async (_m: string, op: string, args: Record<string, unknown>) => (asked.push({ op, args }), answer), drafts: null };
  const route = (path: string, body: Record<string, unknown> = {}, method = 'POST') => remoteActionRoute(['api', 'sessions', 's1', ...path.split('/').filter(Boolean)], method, async () => body, 's1', MINI, deps);
  return { asked, route };
}

describe('a session route as an operation of the list', () => {
  it.each([
    ['autopilot', { on: true, merge: true }, 'autopilot.set', { sessionId: 's1', on: true, merge: true }],
    ['findings', { cardId: 'c1', findingId: 'f1', action: 'dismiss' }, 'findings.act', { sessionId: 's1', cardId: 'c1', findingId: 'f1', action: 'dismiss' }],
    ['review-end', { cardId: 'c1', action: 'fix', findingIds: ['f1'] }, 'reviewEnd.act', { sessionId: 's1', cardId: 'c1', action: 'fix', findingIds: ['f1'] }],
    ['review-reply', { cardId: 'c1', verdict: 'approve' }, 'review.post', { sessionId: 's1', cardId: 'c1', verdict: 'approve' }],
    ['suggestions/g1/dismiss', {}, 'suggestion.dismiss', { sessionId: 's1', suggestionId: 'g1' }],
    ['suggestions/g1/undo', {}, 'suggestion.undo', { sessionId: 's1', suggestionId: 'g1' }],
    ['answer', { requestId: 'r1', optionId: 'allow' }, 'session.answer', { sessionId: 's1', requestId: 'r1', optionId: 'allow' }],
    ['stop', {}, 'session.stop', { sessionId: 's1' }],
    ['compact', {}, 'session.compact', { sessionId: 's1' }],
  ])('%s asks %s', async (path, body, op, args) => {
    const c = computer({ ok: true, result: {} });
    await c.route(path, body);
    expect(c.asked).toEqual([{ op, args }]);
  });

  it('answers in the route’s own shape', async () => {
    expect(await computer({ ok: true, result: { answered: true } }).route('answer', { requestId: 'r1', optionId: 'a' })).toEqual({ status: 204 });
    expect(await computer({ ok: true, result: { review: { posted: true } } }).route('review-reply', { cardId: 'c1' })).toEqual({ status: 200, body: { posted: true } });
    expect(await computer({ ok: true, result: { autopilot: null } }).route('autopilot', { on: false })).toEqual({ status: 200, body: { autopilot: null } });
  });

  it('checks a request as the other computer will, before asking it', async () => {
    const c = computer({ ok: true, result: {} });
    expect(await c.route('autopilot', { on: 'yes' })).toEqual({ status: 400, body: { error: 'on must be true or false.' } });
    expect(await c.route('findings', { cardId: 'c1', findingId: 'f1', action: 'explode' })).toMatchObject({ status: 400 });
    expect(c.asked).toEqual([]);
  });

  it('a refusal there is the window’s here; not reaching it names it', async () => {
    expect(await computer({ ok: false, reached: true, reason: 'There is nothing to undo there.' }).route('suggestions/g1/undo')).toEqual({ status: 409, body: { error: 'There is nothing to undo there.' } });
    expect(await computer({ ok: false, reached: false, reason: 'Kestrel Connect is not connected.' }).route('stop')).toEqual({ status: 503, body: { error: 'Mac mini cannot be reached, so nothing was done there. Kestrel Connect is not connected. Try again when it is back.' } });
  });

  it('a route with no operation, or not a POST, is refused with where it runs, asking nothing', async () => {
    for (const [path, method] of [['queue/send', 'POST'], ['role', 'POST'], ['review', 'POST'], ['background-tasks/t1/stop', 'POST'], ['context', 'GET'], ['stop', 'DELETE'], ['suggestions/g1/explode', 'POST']] as const) {
      const c = computer({ ok: true, result: {} });
      expect(await c.route(path, {}, method)).toEqual({ status: 409, body: { error: 'This session runs on Mac mini. That can only be done there.' } });
      expect(c.asked).toEqual([]);
    }
  });
});
