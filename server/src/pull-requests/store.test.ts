import { describe, expect, test } from 'vitest';
import type { PullRequest } from '../shared/details.ts';
import { CHANGING_POLL_MS, OPEN_POLL_MS, WATCHED_POLL_MS } from '../shared/pull-request-poll.ts';
import { ready, unavailable } from '../shared/sourced.ts';
import { PullRequestStore, carryHeadSeen, nextPipelineAsk } from './store.ts';

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

  test('a head commit keeps the time the store first saw it, until the head moves', async () => {
    const h = harness();
    h.tick(1_000);
    h.set(lookup(pr({ headSha: 'a' })));
    await h.store.get('s', 'k', h.load);
    h.tick(5_000);
    h.set(lookup(pr({ headSha: 'a', checks: 'failing' })));
    await h.store.get('s', 'k', h.load, true);
    expect(h.store.peek('s')).toEqual(lookup(pr({ headSha: 'a', checks: 'failing', headSeenAt: 1_000 })));
    h.set(lookup(pr({ headSha: 'b' })));
    await h.store.get('s', 'k', h.load, true);
    expect(h.store.peek('s')).toEqual(lookup(pr({ headSha: 'b', headSeenAt: 6_000 })));
    // Nothing to carry: the answer itself comes back.
    const plain = lookup(pr());
    expect(carryHeadSeen(undefined, plain, 0)).toBe(plain);
  });

  test('current: the held answer while it is fresh, asked again first when it is due or missing', async () => {
    const h = harness();
    expect(await h.store.current('s')).toBeUndefined();
    await h.store.get('s', 'k', h.load);
    expect(await h.store.current('s')).toEqual(lookup(pr()));
    expect(h.asked()).toBe(1);
    h.tick(OPEN_POLL_MS);
    h.set(lookup(pr({ checks: 'failing' })));
    expect(await h.store.current('s')).toEqual(lookup(pr({ checks: 'failing' })));
    expect(h.asked()).toBe(2);
    h.store.due('s');
    await h.store.current('s');
    expect(h.asked()).toBe(3);
  });
});

describe('a watched pipeline after a merge', () => {
  const pipe = (checks: 'running' | 'passing' | 'failing' | 'none') => ready({ sha: 'abc1234', checks });

  test('asked at once, held under its key, again on the tick until it has finished, then never', async () => {
    let clock = 0;
    const store = new PullRequestStore(() => clock);
    let answer = pipe('none');
    let asked = 0;
    const told: string[] = [];
    store.onPipelineChange((id) => told.push(id));
    const load = async () => (asked++, answer);
    store.watchPipeline('s', 'main\nabc1234', load);
    await Promise.resolve();
    await store.tick();
    expect(asked).toBe(1);
    expect(store.pipeline('s', 'main\nabc1234')).toEqual(pipe('none'));
    expect(store.pipeline('s', 'main\nother')).toBeUndefined();
    // The same key again asks nothing new.
    store.watchPipeline('s', 'main\nabc1234', load);
    expect(asked).toBe(1);
    answer = pipe('running');
    clock += CHANGING_POLL_MS;
    await store.tick();
    expect(asked).toBe(2);
    answer = pipe('failing');
    clock += CHANGING_POLL_MS;
    await store.tick();
    expect(store.pipeline('s', 'main\nabc1234')).toEqual(pipe('failing'));
    expect(told).toEqual(['s', 's', 's']);
    clock += CHANGING_POLL_MS * 10;
    await store.tick();
    expect(asked).toBe(3);
    store.unwatchPipeline('s');
    expect(store.pipeline('s', 'main\nabc1234')).toBeUndefined();
  });

  test('its pace: soon while it has not finished, never once it has', () => {
    expect(nextPipelineAsk(pipe('running'), 100)).toBe(100 + CHANGING_POLL_MS);
    expect(nextPipelineAsk(unavailable('offline'), 100)).toBe(100 + CHANGING_POLL_MS);
    expect(nextPipelineAsk(pipe('passing'), 100)).toBeNull();
    expect(nextPipelineAsk(undefined, null)).toBeNull();
  });

  test('a session Autopilot keeps asked about is asked again after a merge', async () => {
    const h = harness();
    h.set(lookup(pr({ state: 'merged' })));
    await h.store.get('s', 'k', h.load);
    h.tick(CHANGING_POLL_MS);
    await h.store.tick();
    expect(h.asked()).toBe(1);
    await h.store.tick(undefined, (id) => id === 's');
    expect(h.asked()).toBe(2);
  });
});
