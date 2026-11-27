// Which operation of the closed list each session route asks of the computer a session runs on, and how its
// answer comes back in the route's own shape (remote-actions.ts). The two-computer tests are in
// connect/link/remote-actions.test.ts; here the other computer is a stand-in that records what it was asked.
import { describe, expect, it } from 'vitest';
import type { RemoteAnswer } from './connect/link/remote-sessions.ts';
import { remoteActionRoute } from './remote-actions.ts';
import { BYPASS_FROM_ELSEWHERE } from './shared/connect-ops.ts';

const MINI = { id: 'mini', name: 'Mac mini' };

function computer(answer: RemoteAnswer) {
  const asked: { op: string; args: Record<string, unknown> }[] = [];
  const deps = { ask: async (_m: string, op: string, args: Record<string, unknown>) => (asked.push({ op, args }), answer), drafts: null };
  const route = (path: string, body: Record<string, unknown> = {}, method = 'POST') => {
    const url = new URL(`http://kestrel/api/sessions/s1/${path}`);
    return remoteActionRoute(url.pathname.split('/').filter(Boolean), method, async () => body, 's1', MINI, deps, url);
  };
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
    ['archive', { archived: true }, 'session.archive', { sessionId: 's1', archived: true }],
    ['archive', { archived: false }, 'session.archive', { sessionId: 's1', archived: false }],
    ['archive', { archived: true, skipScript: true }, 'session.archive', { sessionId: 's1', archived: true, skipScript: true }],
    ['compact', {}, 'session.compact', { sessionId: 's1' }],
    ['tags', { tag: 'release' }, 'session.tag', { sessionId: 's1', tag: 'release', on: true }],
    ['role', { role: 'build', brief: 'Wire it in.' }, 'session.role', { sessionId: 's1', role: 'build', brief: 'Wire it in.' }],
    ['review', { comment: true }, 'session.review', { sessionId: 's1', comment: true }],
    ['fork', { turn: 'm3' }, 'session.fork', { sessionId: 's1', turn: 'm3' }],
    ['queue/send', {}, 'queue.send', { sessionId: 's1' }],
    ['background-tasks/t1/stop', {}, 'background.stop', { sessionId: 's1', taskId: 't1' }],
    ['commands/c%3A1/retry', {}, 'command.retry', { sessionId: 's1', commandId: 'c:1' }],
    ['commands/c1/stop', {}, 'command.stop', { sessionId: 's1', commandId: 'c1' }],
    ['pr-prepare', { generated: true }, 'pr.prepare', { sessionId: 's1', generated: true }],
    ['pr-create', { title: 'Fix', body: '', base: 'main', draft: false, autopilot: 'merge' }, 'pr.create', { sessionId: 's1', title: 'Fix', body: '', base: 'main', draft: false, autopilot: 'merge' }],
    ['pr-merge-preview', { number: 12 }, 'pr.mergePreview', { sessionId: 's1', number: 12 }],
    ['pr-merge', { number: 12, sha: 'a'.repeat(40), base: 'main', method: 'squash' }, 'pr.merge', { sessionId: 's1', number: 12, sha: 'a'.repeat(40), base: 'main', method: 'squash' }],
  ])('POST %s asks %s', async (path, body, op, args) => {
    const c = computer({ ok: true, result: {} });
    await c.route(path, body);
    expect(c.asked).toEqual([{ op, args }]);
  });

  it.each([
    ['git', 'session.details', { sessionId: 's1', section: 'git' }],
    ['change-counts', 'session.details', { sessionId: 's1', section: 'change-counts' }],
    ['repository', 'session.details', { sessionId: 's1', section: 'repository' }],
    ['usage', 'session.details', { sessionId: 's1', section: 'usage' }],
    ['pull-requests?refresh=1', 'session.details', { sessionId: 's1', section: 'pull-requests', refresh: true }],
    ['context', 'session.context', { sessionId: 's1' }],
    ['files?path=src&folder=f1', 'session.files', { sessionId: 's1', path: 'src', folder: 'f1' }],
    ['file?path=src%2Fa.ts', 'session.file', { sessionId: 's1', path: 'src/a.ts' }],
    ['document?path=README.md', 'session.document', { sessionId: 's1', path: 'README.md' }],
    ['document-place?path=README.md', 'session.documentPlace', { sessionId: 's1', path: 'README.md' }],
    ['raw?path=shot.png', 'session.raw', { sessionId: 's1', path: 'shot.png' }],
    ['review', 'session.reviewOf', { sessionId: 's1' }],
    ['commands/c1/output', 'command.output', { sessionId: 's1', commandId: 'c1' }],
  ])('GET %s asks %s', async (path, op, args) => {
    const c = computer({ ok: true, result: { type: 'text/markdown', data: '' } });
    await c.route(path, {}, 'GET');
    expect(c.asked).toEqual([{ op, args }]);
  });

  it.each([
    ['', {}, 'PATCH', 'session.rename', { sessionId: 's1', title: 'Checkout flow' }, { title: ' Checkout flow ' }],
    ['', {}, 'DELETE', 'session.delete', { sessionId: 's1' }, {}],
    ['queue/q1', {}, 'DELETE', 'queue.remove', { sessionId: 's1', messageId: 'q1' }, {}],
    ['tags/release', {}, 'DELETE', 'session.tag', { sessionId: 's1', tag: 'release', on: false }, {}],
  ])('%s %s asks %s', async (path, _none, method, op, args, body) => {
    const c = computer({ ok: true, result: {} });
    await c.route(path, body, method);
    expect(c.asked).toEqual([{ op, args }]);
  });

  it('a file comes back as its bytes, and one too large to bring over says where it is', async () => {
    expect(await computer({ ok: true, result: { type: 'text/markdown', data: Buffer.from('# Hi').toString('base64') } }).route('document?path=a.md', {}, 'GET')).toEqual({ status: 200, type: 'text/markdown', bytes: Buffer.from('# Hi') });
    expect(await computer({ ok: true, result: { type: 'application/pdf', tooLarge: 50_000_000 } }).route('document?path=a.pdf', {}, 'GET')).toEqual({ status: 413, body: { error: 'That file is too large to bring over from Mac mini. It is on Mac mini.' } });
  });

  it('a reply carries the model, effort, fast mode and mode; Bypass is refused before anything is asked', async () => {
    const c = computer({ ok: true, result: { outcome: 'sent' } });
    expect(await c.route('reply', { text: 'go on', model: 'm2', effort: 'high', fast: true, permission: 'auto' })).toEqual({ status: 200, body: { outcome: 'sent' } });
    expect(c.asked).toEqual([{ op: 'session.reply', args: { sessionId: 's1', text: 'go on', model: 'm2', effort: 'high', fast: true, permission: 'auto' } }]);
    const bypass = computer({ ok: true, result: {} });
    expect(await bypass.route('reply', { text: 'go on', permission: 'bypass' })).toEqual({ status: 400, body: { error: BYPASS_FROM_ELSEWHERE } });
    expect(bypass.asked).toEqual([]);
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

  it('archives there, and a failed archive script there comes back as here, with its output, so it can be skipped', async () => {
    expect(await computer({ ok: true, result: {} }).route('archive', { archived: true })).toEqual({ status: 204 });
    const failed = computer({ ok: true, result: { archiveScript: { reason: 'The archive script failed. The session was not archived.', output: 'exit 1' } } });
    expect(await failed.route('archive', { archived: true })).toEqual({ status: 409, body: { error: 'The archive script failed. The session was not archived.', archiveScript: { output: 'exit 1' } } });
    // Its refusal there in its own words, and an unreachable computer named; nothing is held.
    expect(await computer({ ok: false, reached: true, reason: 'It is still working.' }).route('archive', { archived: true })).toEqual({ status: 409, body: { error: 'It is still working.' } });
    expect(await computer({ ok: false, reached: false, reason: '' }).route('archive', { archived: false })).toEqual({ status: 503, body: { error: 'Mac mini cannot be reached, so nothing was done there. Try again when it is back.' } });
  });

  it('a route with no operation is refused with where it runs, asking nothing', async () => {
    for (const [path, method] of [['open-file', 'POST'], ['reveal-file', 'POST'], ['move', 'POST'], ['move-to-project', 'POST'], ['draft-summary', 'POST'], ['asides', 'POST'], ['stop', 'DELETE'], ['context', 'POST'], ['suggestions/g1/explode', 'POST'], ['media/a.png/x', 'GET']] as const) {
      const c = computer({ ok: true, result: {} });
      expect(await c.route(path, {}, method)).toEqual({ status: 409, body: { error: 'This session runs on Mac mini. That can only be done there.' } });
      expect(c.asked).toEqual([]);
    }
  });
});
