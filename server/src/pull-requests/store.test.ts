import { describe, expect, test } from 'vitest';
import type { PullRequest } from '../shared/details.ts';
import { CHANGING_POLL_MS, OPEN_POLL_MS, WATCHED_POLL_MS } from '../shared/pull-request-poll.ts';
import { ready, unavailable } from '../shared/sourced.ts';
import { PullRequestStore } from './store.ts';

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: 'Docs', url: 'https://example.com/7', state: 'open', checks: 'passing', review: 'none', readiness: 'ready', ...over });
const lookup = (...pullRequests: PullRequest[]) => ready({ host: 'github' as const, pullRequests });

function harness() {
  let clock = 0;
  const store = new PullRequestStore(() => clock);
  const heard: [string, unknown][] = [];
  store.onChange((id, value) => heard.push([id, value]));
  let answer = lookup(pr());
  let asked = 0;
  const load = async () => {
    asked++;
    return answer;
  };
  return { store, heard, load, asked: () => asked, set: (a: typeof answer) => (answer = a), tick: (ms: number) => (clock += ms) };
}

describe('PullRequestStore', () => {
  test('keeps an answer however old while the key is the same', async () => {
    const h = harness();
    await h.store.get('s', 'k', h.load);
    h.tick(60 * 60_000);
    await h.store.get('s', 'k', h.load);
    expect(h.asked()).toBe(1);
  });

  test('a new key or refresh asks again; the old answer stays until the new one is in', async () => {
    const h = harness();
    await h.store.get('s', 'k', h.load);
    h.set(lookup(pr({ number: 8 })));
    const pending = h.store.get('s', 'k2', h.load);
    expect(h.store.peek('s')).toEqual(lookup(pr()));
    await pending;
    expect(h.store.peek('s')).toEqual(lookup(pr({ number: 8 })));
    await h.store.get('s', 'k2', h.load, true);
    expect(h.asked()).toBe(3);
  });

  test('a new branch asks again, and sessions are kept apart', async () => {
    const h = harness();
    await h.store.get('s1', 'repo\na', h.load);
    await h.store.get('s1', 'repo\nb', h.load);
    await h.store.get('s2', 'repo\nb', h.load);
    expect(h.asked()).toBe(3);
  });

  test('a question on its way is shared', async () => {
    const h = harness();
    await Promise.all([h.store.get('s', 'k', h.load), h.store.get('s', 'k', h.load)]);
    expect(h.asked()).toBe(1);
  });

  test('listeners hear only real changes, and the same answer keeps its identity', async () => {
    const h = harness();
    const first = await h.store.get('s', 'k', h.load);
    const again = await h.store.get('s', 'k', h.load, true);
    expect(again).toBe(first);
    expect(h.heard).toHaveLength(1);
    h.set(lookup(pr({ checks: 'failing' })));
    await h.store.get('s', 'k', h.load, true);
    expect(h.heard).toHaveLength(2);
  });

  test('the background asks again at the pace the answer calls for, and never once it is merged', async () => {
    const h = harness();
    h.set(lookup(pr({ checks: 'running' })));
    await h.store.get('s', 'k', h.load);
    h.tick(CHANGING_POLL_MS - 1);
    await h.store.tick();
    expect(h.asked()).toBe(1);
    h.tick(1);
    h.set(lookup(pr()));
    await h.store.tick();
    expect(h.asked()).toBe(2);
    h.tick(OPEN_POLL_MS);
    h.set(lookup(pr({ state: 'merged' })));
    await h.store.tick();
    h.tick(24 * 60 * 60_000);
    await h.store.tick();
    expect(h.asked()).toBe(3);
  });

  test('due asks again on the next tick', async () => {
    const h = harness();
    await h.store.get('s', 'k', h.load);
    h.store.due('s');
    await h.store.tick();
    expect(h.asked()).toBe(2);
  });

  test('a failing lookup is an answer with its reason, not an error', async () => {
    const h = harness();
    expect(await h.store.get('s', 'k', async () => Promise.reject(new Error('gh timed out')))).toEqual(unavailable('gh timed out'));
  });

  test('forgetting a session tells listeners it is gone', async () => {
    const h = harness();
    await h.store.get('s', 'k', h.load);
    h.store.forget('s');
    expect(h.heard.at(-1)).toEqual(['s', null]);
    expect(h.store.all()).toEqual({});
  });

  test('asks about a session a window has open every few seconds, and leaves the others to their pace', async () => {
    const h = harness();
    await h.store.get('open', 'k', h.load);
    await h.store.get('closed', 'k', h.load);
    const before = h.asked();
    h.tick(WATCHED_POLL_MS);
    await h.store.tick((id) => id === 'open');
    expect(h.asked()).toBe(before + 1);
    await h.store.tick((id) => id === 'open');
    expect(h.asked()).toBe(before + 1);
  });
});
