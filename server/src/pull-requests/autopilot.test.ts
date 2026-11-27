import { afterEach, describe, expect, test } from 'vitest';
import { CHECKS_SETTLE_MS, DEFAULT_AUTOPILOT_PREFS, type AutopilotPrefs, type AutopilotRecord } from '../shared/autopilot.ts';
import type { PullRequest, PullRequestLookup } from '../shared/details.ts';
import { DEFAULT_NOTIFY, requestNotifyEvents } from '../shared/notifications.ts';
import { DEFAULT_ATTENTION_PREFS } from '../shared/request-attention.ts';
import type { Sourced } from '../shared/sourced.ts';
import { autopilotKind } from '../suggestions/autopilot-kind.ts';
import { autopilotChange, setAutopilot } from './autopilot-api.ts';
import { Autopilot, USER_TOOK_OVER, type AutopilotSession } from './autopilot.ts';

const SHA = (n: number) => String(n).repeat(40).slice(0, 40);
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: 'Polish the form', state: 'open', checks: 'passing', review: 'none', url: 'https://github.com/o/r/pull/7', headSha: SHA(1), baseBranch: 'main', headBranch: 'feat', readiness: 'ready', ...over }) as PullRequest;
const ready = (p: PullRequest): Sourced<PullRequestLookup> => ({ state: 'ready', value: { host: 'github', pullRequests: [p] } }) as Sourced<PullRequestLookup>;

/** An Autopilot over a fake session, store and clock. */
function harness(prefs: AutopilotPrefs = DEFAULT_AUTOPILOT_PREFS, current?: (sessionId: string) => Promise<Sourced<PullRequestLookup> | undefined>) {
  let now = 1_000_000_000;
  const session: AutopilotSession = { id: 's1', state: 'done', note: '', title: 'Polish', worktreePath: '/wt' };
  let lookup: Sourced<PullRequestLookup> | undefined = ready(pr());
  const sent: string[] = [];
  const notices: string[] = [];
  const merged: number[] = [];
  let foreign = false;
  const autopilot = new Autopilot({
    sessions: async () => [session],
    lookup: () => lookup,
    ...(current ? { current } : {}),
    attention: async () => DEFAULT_ATTENTION_PREFS,
    prefs: async () => prefs,
    save: async (_id, record) => {
      session.autopilot = record ?? undefined;
    },
    send: async (_id, text) => sent.push(text),
    merge: async (_id, p) => {
      merged.push(p.number);
    },
    notice: (_id, text) => notices.push(text),
    madeHere: async () => !foreign,
    onChange: () => () => undefined,
    now: () => now,
    lookMs: 1_000_000,
    everyMs: 1_000_000,
  });
  return {
    autopilot,
    session,
    sent,
    notices,
    merged,
    setLookup: (l: Sourced<PullRequestLookup> | undefined) => (lookup = l),
    tick: (ms: number) => (now += ms),
    now: () => now,
    foreignPush: () => (foreign = true),
  };
}

let live: Autopilot[] = [];
afterEach(() => {
  live.forEach((a) => a.stop());
  live = [];
});
const make = (prefs?: AutopilotPrefs, current?: (sessionId: string) => Promise<Sourced<PullRequestLookup> | undefined>) => {
  const h = harness(prefs, current);
  live.push(h.autopilot);
  return h;
};

describe('the watcher', () => {
  test('turned on before a request is opened, it waits and starts on the first one; a guest is refused', async () => {
    const h = make();
    h.setLookup(ready(pr({ state: 'merged' })));
    const armed = await h.autopilot.turnOn('s1', true);
    expect(armed).toMatchObject({ waiting: true, merge: true, number: 0 });
    expect(h.autopilot.isOn('s1')).toBe(false);
    expect(h.autopilot.anyOn()).toBe(true);
    // A message from the user does not end the wait: the work before the request is theirs.
    await h.autopilot.userSpoke('s1');
    expect(h.session.autopilot?.waiting).toBe(true);
    h.setLookup(ready(pr({ number: 8 })));
    await h.autopilot.look();
    expect(h.session.autopilot).toMatchObject({ number: 8, merge: true });
    expect(h.session.autopilot?.waiting).toBeUndefined();
    expect(h.autopilot.isOn('s1')).toBe(true);
    h.session.hostId = 'host';
    await expect(h.autopilot.turnOn('s1', false)).rejects.toThrow(/host session/);
  });

  test('a waiting one can be turned off, and its Merge when green changed', async () => {
    const h = make();
    h.setLookup(undefined);
    await setAutopilot(h.autopilot, 's1', { on: true });
    expect(await setAutopilot(h.autopilot, 's1', { on: true, merge: true })).toMatchObject({ waiting: true, merge: true });
    await setAutopilot(h.autopilot, 's1', { on: false });
    expect(h.session.autopilot?.stopped).toBeDefined();
    expect(h.autopilot.anyOn()).toBe(false);
  });

  test('before the store answers, the number the caller knows is used', async () => {
    const h = make();
    h.setLookup(undefined);
    const record = await h.autopilot.turnOn('s1', true, 12);
    expect(record).toMatchObject({ number: 12, merge: true, rounds: 0 });
    expect(h.autopilot.isOn('s1')).toBe(true);
  });

  test('failed checks send a round as a turn; merge when green merges once', async () => {
    const h = make();
    await h.autopilot.turnOn('s1', true);
    h.setLookup(ready(pr({ checks: 'failing', failedChecks: [{ name: 'lint', url: 'https://ci/lint' }], readiness: 'blocked' } as Partial<PullRequest>)));
    await h.autopilot.look();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/^Autopilot, round 1 of 3/);
    // The agent pushed a fix and its checks passed.
    h.tick(60_000);
    h.setLookup(ready(pr({ headSha: SHA(2) })));
    await h.autopilot.look();
    h.tick(CHECKS_SETTLE_MS);
    await h.autopilot.look();
    await h.autopilot.look();
    expect(h.merged).toEqual([7]);
    expect(h.notices.at(-1)).toMatch(/merged #7/);
  });

  test('a person pushing stops it with a notice; the user speaking turns it off', async () => {
    const h = make();
    await h.autopilot.turnOn('s1', false);
    h.foreignPush();
    h.setLookup(ready(pr({ headSha: SHA(3) })));
    await h.autopilot.look();
    expect(h.autopilot.isOn('s1')).toBe(false);
    expect(h.session.autopilot?.stopped).toMatchObject({ notify: true, why: expect.stringMatching(/someone else pushed/) });

    const g = make();
    await g.autopilot.turnOn('s1', false);
    await g.autopilot.userSpoke('s1');
    expect(g.autopilot.isOn('s1')).toBe(false);
    expect(g.session.autopilot?.stopped).toMatchObject({ why: USER_TOOK_OVER, notify: false });
  });

  test('a merge the host refuses stops it and says why', async () => {
    const h = make();
    const autopilot = new Autopilot({
      sessions: async () => [h.session],
      lookup: () => ready(pr()),
      attention: async () => DEFAULT_ATTENTION_PREFS,
      prefs: async () => DEFAULT_AUTOPILOT_PREFS,
      save: async (_id, record) => {
        h.session.autopilot = record ?? undefined;
      },
      send: async () => undefined,
      merge: async () => {
        throw new Error('Base branch is protected');
      },
      notice: (_id, text) => h.notices.push(text),
      madeHere: async () => true,
      onChange: () => () => undefined,
      now: () => 2_000_000_000,
      lookMs: 1_000_000,
      everyMs: 1_000_000,
    });
    live.push(autopilot);
    h.session.autopilot = { ...(await h.autopilot.turnOn('s1', true)), head: { sha: SHA(1), at: 0 } };
    await autopilot.look();
    expect(h.session.autopilot?.stopped?.why).toMatch(/could not merge #7: Base branch is protected/);
  });
});

describe('turned on, it starts on what the request already needs (issue 82)', () => {
  /** The request as the store has held it for a while: its head commit was first seen ten minutes ago. */
  const standing = (h: ReturnType<typeof make>, over: Partial<PullRequest>) => h.setLookup(ready(pr({ headSeenAt: h.now() - 10 * 60_000, ...over } as Partial<PullRequest>)));
  /** Turned on, and the look that turning on asks for. */
  const turnOn = async (h: ReturnType<typeof make>, merge = false) => {
    await h.autopilot.turnOn('s1', merge);
    await h.autopilot.look();
  };

  test('failed checks: the first round at once', async () => {
    const h = make();
    standing(h, { checks: 'failing', failedChecks: [{ name: 'lint' }], readiness: 'blocked' } as Partial<PullRequest>);
    await turnOn(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/^Autopilot, round 1 of 3[\s\S]*The checks failed/);
  });

  test('merge conflicts: the first round at once', async () => {
    const h = make();
    standing(h, { readiness: 'conflicts' });
    await turnOn(h);
    expect(h.sent[0]).toMatch(/has merge conflicts with `main`/);
  });

  test('changes requested: the first round at once', async () => {
    const h = make();
    standing(h, { review: 'changes-requested', changesRequested: { id: 'R1', reviewers: ['sam'], comments: [{ body: 'Rename it.' }] } } as Partial<PullRequest>);
    await turnOn(h);
    expect(h.sent[0]).toMatch(/sam asked for changes/);
  });

  test('a branch the host requires to catch up: the round that merges the base in, at once', async () => {
    const h = make();
    standing(h, { readiness: 'behind' });
    await turnOn(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/is behind `main`, and the host will not merge it/);
  });

  test('ready to merge with Merge when green: merged at once; without it, said green once', async () => {
    const h = make();
    standing(h, {});
    await turnOn(h, true);
    expect(h.merged).toEqual([7]);

    const g = make();
    standing(g, {});
    await turnOn(g);
    await g.autopilot.look();
    expect(g.merged).toEqual([]);
    expect(g.notices.filter((n) => /is green/.test(n))).toHaveLength(1);
  });

  test('a request opened just now still gives its checks time to start before it merges', async () => {
    const h = make();
    standing(h, { headSeenAt: h.now() } as Partial<PullRequest>);
    await turnOn(h, true);
    expect(h.merged).toEqual([]);
    h.tick(CHECKS_SETTLE_MS);
    await h.autopilot.look();
    expect(h.merged).toEqual([7]);
  });

  test('a session on a turn is left to finish it: the round comes when the turn ends', async () => {
    const h = make();
    standing(h, { checks: 'failing', failedChecks: [{ name: 'lint' }] } as Partial<PullRequest>);
    h.session.state = 'running';
    await turnOn(h);
    expect(h.sent).toEqual([]);
    h.session.state = 'done';
    await h.autopilot.look();
    expect(h.sent).toHaveLength(1);
  });

  test('a stale copy is asked again first, through the store, and the step runs on the new answer', async () => {
    const asked: string[] = [];
    let fresh: Sourced<PullRequestLookup> | undefined;
    const h = make(DEFAULT_AUTOPILOT_PREFS, async (id) => {
      asked.push(id);
      // The store's own refresh replaces what it holds: what the watcher reads from then on.
      h.setLookup(fresh);
      return fresh;
    });
    standing(h, { checks: 'running' });
    fresh = ready(pr({ checks: 'failing', failedChecks: [{ name: 'test' }], headSeenAt: h.now() - 60_000 } as Partial<PullRequest>));
    await turnOn(h);
    expect(asked).toEqual(['s1']);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/- test/);
  });
});

describe('the route and the phone', () => {
  test('a change is checked strictly', () => {
    expect(autopilotChange({})).toMatch(/on: true or false/);
    expect(autopilotChange({ on: true, merge: 'yes' })).toMatch(/true or false/);
    expect(autopilotChange({ on: true, merge: true })).toEqual({ on: true, merge: true });
  });

  test('on, Merge when green while on, off', async () => {
    const h = make();
    expect(await setAutopilot(h.autopilot, 's1', { on: true })).toMatchObject({ merge: false });
    expect(await setAutopilot(h.autopilot, 's1', { on: true, merge: true })).toMatchObject({ merge: true });
    expect(await setAutopilot(h.autopilot, 's1', { on: false })).toBeNull();
    expect(h.autopilot.isOn('s1')).toBe(false);
    await expect(setAutopilot(null, 's1', { on: true })).rejects.toThrow(/not running yet/);
  });
});

describe('the offer card', () => {
  const ctx = (messages: unknown[] = []) => ({ sessionId: 's1', messages, workspace: {} }) as never;
  const kind = (prefs: Partial<AutopilotPrefs> = {}, calls: string[] = []) =>
    autopilotKind({
      prefs: async () => ({ ...DEFAULT_AUTOPILOT_PREFS, ...prefs }),
      turnOn: async (_id, merge, number) => calls.push(`on ${merge} ${number}`),
      stopOffering: async () => calls.push('never'),
      asks: async () => true,
    });

  test('shows Turn on with the merge checkbox, folded the second way to press it', async () => {
    const proposal = await kind({ merge: true }).propose(ctx(), { host: 'github', number: 7 });
    expect(proposal.type).toBe('show');
    const draft = proposal.type === 'show' ? proposal.draft : null;
    expect(draft?.title).toMatch(/#7/);
    expect(draft?.reason).toMatch(/up to 3 rounds[\s\S]*Manual/);
    expect(draft?.buttons[0]).toMatchObject({ id: 'on', toggle: { id: 'on-merge', checked: true } });
    expect(draft?.buttons.find((b) => b.id === 'on-merge')?.folded).toBe(true);
  });

  test('skipped when the offer is off or was made', async () => {
    expect((await kind({ offer: false }).propose(ctx(), { host: 'github', number: 7 })).type).toBe('skip');
    const shown = [{ suggestion: { kind: 'autopilot', payload: { number: 7 } } }];
    expect((await kind().propose(ctx(shown), { host: 'github', number: 7 })).type).toBe('skip');
  });

  test('its buttons', async () => {
    const calls: string[] = [];
    const k = kind({}, calls);
    const suggestion = { payload: { host: 'gitlab', number: 9 } } as never;
    expect((await k.press(ctx(), suggestion, 'on-merge')).line).toMatch(/!9, and merges it/);
    expect((await k.press(ctx(), suggestion, 'later')).state).toBe('dismissed');
    await k.press(ctx(), suggestion, 'never');
    expect(calls).toEqual(['on true 9', 'never']);
  });
});

describe('notifications', () => {
  const AWAY = { focused: false, openSessionId: null };
  const failing = new Map([['s1', ready(pr({ checks: 'failing', failedChecks: [{ name: 'lint', url: 'u' }], readiness: 'blocked' } as Partial<PullRequest>))]]);
  const on: AutopilotRecord = { number: 7, merge: false, rounds: 0, maxRounds: 3, roundMinutes: 60, handled: [] };
  const s = (autopilot?: AutopilotRecord) => ({ id: 's1', title: 'Polish', state: 'done' as const, note: '', ...(autopilot ? { autopilot } : {}) });

  test('nothing while Autopilot is on; its stop is told once', () => {
    const first = requestNotifyEvents(null, [s(on)], new Map(), DEFAULT_ATTENTION_PREFS, DEFAULT_NOTIFY, AWAY);
    const quiet = requestNotifyEvents({ ...first.seen, answered: new Set(['s1']) }, [s(on)], failing, DEFAULT_ATTENTION_PREFS, DEFAULT_NOTIFY, AWAY);
    expect(quiet.events).toEqual([]);
    const stopped = { ...on, stopped: { at: 5, why: 'Autopilot disengaged. #7 after 3 rounds', notify: true } };
    const told = requestNotifyEvents(quiet.seen, [s(stopped)], failing, DEFAULT_ATTENTION_PREFS, DEFAULT_NOTIFY, AWAY);
    expect(told.events).toEqual([{ kind: 'pull-request', sessionId: 's1', title: 'Polish', body: 'Autopilot disengaged. #7 after 3 rounds' }]);
    expect(requestNotifyEvents(told.seen, [s(stopped)], failing, DEFAULT_ATTENTION_PREFS, DEFAULT_NOTIFY, AWAY).events).toEqual([]);
  });
});
