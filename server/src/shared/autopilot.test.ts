import { describe, expect, test } from 'vitest';
import { ALWAYS_WARNING, autopilotLabel, autopilotStep, CHECKS_SETTLE_MS, checkAutopilotChange, DEFAULT_AUTOPILOT_PREFS, NO_PUSH_GRACE_MS, newRecord, sanitizeAutopilotPrefs, type AutopilotRecord, type StepInput } from './autopilot.ts';
import type { PullRequest, PullRequestLookup } from './details.ts';
import { DEFAULT_ATTENTION_PREFS } from './request-attention.ts';
import type { Sourced } from './sourced.ts';

const SHA = (n: number) => `${String(n).repeat(40)}`.slice(0, 40);
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: 'Polish the form', state: 'open', checks: 'passing', review: 'none', url: 'https://github.com/o/r/pull/7', headSha: SHA(1), baseBranch: 'main', headBranch: 'feat', readiness: 'ready', ...over }) as PullRequest;
const lookup = (p: PullRequest): Sourced<PullRequestLookup> => ({ state: 'ready', value: { host: 'github', pullRequests: [p] } }) as Sourced<PullRequestLookup>;
const failing = (head: number, names = ['lint']) => pr({ headSha: SHA(head), checks: 'failing', failedChecks: names.map((name) => ({ name, url: `https://ci/${name}` })), readiness: 'blocked' });

const T0 = 1_000_000_000;
const start = (merge = false, rounds = 3): AutopilotRecord => ({ ...newRecord(7, merge, { ...DEFAULT_AUTOPILOT_PREFS, rounds }), head: { sha: SHA(1), at: T0 - CHECKS_SETTLE_MS * 2 } });
const step = (record: AutopilotRecord, p: PullRequest, over: Partial<StepInput> = {}) => autopilotStep({ record, lookup: lookup(p), attention: DEFAULT_ATTENTION_PREFS, idle: true, failed: false, now: T0, ...over });

describe('settings', () => {
  test('defaults: offered, never always, 3 rounds of an hour', () => {
    expect(sanitizeAutopilotPrefs(undefined)).toEqual({ offer: true, always: false, merge: false, rounds: 3, roundMinutes: 60 });
    expect(sanitizeAutopilotPrefs({ rounds: 99, roundMinutes: 5 })).toMatchObject({ rounds: 3, roundMinutes: 60 });
  });

  test('Always is stored only once its warning is confirmed', () => {
    expect(checkAutopilotChange({ always: true })).toEqual({ ok: false, reason: `Confirm first: ${ALWAYS_WARNING}` });
    expect(checkAutopilotChange({ always: true, confirmed: true })).toEqual({ ok: true, change: { always: true } });
    expect(checkAutopilotChange({ always: false })).toEqual({ ok: true, change: { always: false } });
  });

  test.each([
    [{ rounds: 0 }, /from 1 to 10/],
    [{ roundMinutes: 5 }, /10 minutes to 24 hours/],
    [{ merge: 'yes' }, /true or false/],
    [{ colour: 'red' }, /no setting called colour/],
    [{}, /Nothing to change/],
  ])('refuses %j with the reason', (raw, reason) => {
    const checked = checkAutopilotChange(raw);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.reason).toMatch(reason);
  });
});

describe('a round', () => {
  test('failed checks start a round with the fix message, and say which round', () => {
    const { record, act } = step(start(), failing(1));
    expect(act.type).toBe('round');
    expect(act.type === 'round' && act.message).toMatch(/^Autopilot, round 1 of 3: #7/);
    expect(act.type === 'round' && act.message).toContain('https://ci/lint');
    expect(record.round).toMatchObject({ startedAt: T0, head: SHA(1), failed: ['lint'] });
    expect(record.rounds).toBe(1);
  });

  test('conflicts and requested changes are rounds too, all reasons in one message', () => {
    const p = pr({ readiness: 'conflicts', review: 'changes-requested', changesRequested: { id: 'r1', reviewers: ['sam'], comments: [] } as never });
    const { act } = step(start(), p);
    expect(act.type === 'round' && act.message).toMatch(/merge conflicts with `main`[\s\S]*sam asked for changes/);
  });

  test('nothing while the agent works; the round ends once it pushed and the checks reported', () => {
    let { record } = step(start(), failing(1));
    expect(step(record, failing(1), { idle: false, now: T0 + 1000 }).act).toEqual({ type: 'none' });
    // Pushed, checks running: still the round.
    ({ record } = step(record, pr({ headSha: SHA(2), checks: 'running' }), { now: T0 + 60_000 }));
    expect(record.round).toBeDefined();
    // Passed and settled: the round is over, and it says green once.
    const done = step(record, pr({ headSha: SHA(2) }), { now: T0 + 60_000 + CHECKS_SETTLE_MS });
    expect(done.record.round).toBeUndefined();
    expect(done.act).toEqual({ type: 'green', line: '#7 is green: ready to merge' });
    expect(step(done.record, pr({ headSha: SHA(2) }), { now: T0 + 200_000 }).act).toEqual({ type: 'none' });
  });

  test('merges when green, only when ticked and only once the new commit had time for its checks to start', () => {
    const fresh = { ...start(true), head: { sha: SHA(1), at: T0 } };
    expect(step(fresh, pr(), { now: T0 + 1000 }).act).toEqual({ type: 'none' });
    expect(step(fresh, pr(), { now: T0 + CHECKS_SETTLE_MS }).act).toMatchObject({ type: 'merge', pr: { number: 7 } });
    expect(step(start(true), pr({ state: 'draft' })).act).toEqual({ type: 'none' });
    expect(step(start(true), pr({ review: 'review-required', readiness: 'blocked' })).act).toEqual({ type: 'none' });
  });
});

describe('when it stops', () => {
  test('rounds used up: it stops and names what still fails', () => {
    let record = start(false, 1);
    ({ record } = step(record, failing(1)));
    const { act, record: after } = step(record, failing(2, ['test']), { now: T0 + 1000 });
    expect(act).toMatchObject({ type: 'stop', stop: { why: 'Autopilot stopped on #7 after 1 round: checks failed on #7: test', notify: true } });
    expect(after.stopped).toBeDefined();
    expect(step(after, failing(3)).act).toEqual({ type: 'none' });
  });

  test('the same checks failing again is an impasse', () => {
    const { record } = step(start(), failing(1, ['lint', 'test']));
    expect(step(record, failing(2, ['test', 'lint']), { now: T0 + 1000 }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/same checks failed again after round 1 \(lint, test\)/) } });
  });

  test('a round that pushed nothing stops after the grace', () => {
    let { record } = step(start(), failing(1));
    ({ record } = step(record, failing(1), { now: T0 + 1000 }));
    expect(record.round?.idleSince).toBe(T0 + 1000);
    expect(step(record, failing(1), { now: T0 + 1000 + NO_PUSH_GRACE_MS }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/pushed nothing in round 1/) } });
  });

  test('a conflict still there after its round', () => {
    const conflicted = (head: number) => pr({ headSha: SHA(head), readiness: 'conflicts', conflictsSince: SHA(1) });
    let { record } = step(start(), conflicted(1));
    ({ record } = step(record, conflicted(2), { now: T0 + CHECKS_SETTLE_MS * 2 }));
    expect(step(record, conflicted(2), { now: T0 + CHECKS_SETTLE_MS * 3 }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/merge conflicts are still there/) } });
  });

  test('over the time limit, a failed turn, or a person pushing', () => {
    const { record } = step(start(), failing(1));
    expect(step(record, failing(1), { idle: false, now: T0 + 61 * 60_000 }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/time limit of 1 hour/) } });
    expect(step(record, failing(1), { failed: true, now: T0 + 1000 }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/failed or was stopped/) } });
    expect(step(start(), pr({ headSha: SHA(5) }), { foreignPush: true }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/someone else pushed/) } });
  });

  test('merged or closed ends it without telling', () => {
    expect(step(start(), pr({ state: 'merged' })).act).toEqual({ type: 'stop', stop: { at: T0, why: '#7 was merged', notify: false } });
    expect(step(start(), pr({ state: 'closed' })).act).toMatchObject({ stop: { notify: false } });
  });

  test('a reason the user does not watch is not acted on', () => {
    const attention = { ...DEFAULT_ATTENTION_PREFS, 'checks-failed': { watch: false, card: 'ask' as const } };
    expect(step(start(), failing(1), { attention }).act).toEqual({ type: 'none' });
  });
});

describe('the control’s words', () => {
  test('each state is said in words', () => {
    const on = newRecord(7, false, DEFAULT_AUTOPILOT_PREFS);
    expect(autopilotLabel(undefined)).toBe('Autopilot off');
    expect(autopilotLabel(on)).toBe('Autopilot');
    expect(autopilotLabel({ ...on, merge: true, waiting: true })).toBe('Autopilot · merge · waiting');
    expect(autopilotLabel({ ...on, rounds: 1, round: { startedAt: 0, head: 'a', failed: [] } })).toBe('Autopilot · round 1 of 3');
    expect(autopilotLabel({ ...on, stopped: { at: 0, why: 'x', notify: true } })).toBe('Autopilot stopped');
    expect(autopilotLabel({ ...on, stopped: { at: 0, why: 'x', notify: false } })).toBe('Autopilot off');
  });
});
