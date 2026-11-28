import { describe, expect, test } from 'vitest';
import { ALWAYS_WARNING, AUTOPILOT_DISENGAGED, CONTROLS_YOURS, asRecord, autopilotMenu, autopilotText, carriedOver, isAtWork, isDisengagedLine, autopilotLabel, autopilotStep, CHECKS_SETTLE_MS, checkAutopilotChange, DEFAULT_AUTOPILOT_PREFS, NO_PUSH_GRACE_MS, newRecord, recordFor, sanitizeAutopilotPrefs, type AutopilotRecord, type StepInput } from './autopilot.ts';
import type { BasePipeline, PullRequest, PullRequestLookup } from './details.ts';
import { DEFAULT_ATTENTION_PREFS } from './request-attention.ts';
import type { Sourced } from './sourced.ts';

const SHA = (n: number) => `${String(n).repeat(40)}`.slice(0, 40);
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 7, title: 'Polish the form', state: 'open', checks: 'passing', review: 'none', url: 'https://github.com/o/r/pull/7', headSha: SHA(1), baseBranch: 'main', headBranch: 'feat', readiness: 'ready', ...over }) as PullRequest;
const lookup = (p: PullRequest): Sourced<PullRequestLookup> => ({ state: 'ready', value: { host: 'github', pullRequests: [p] } }) as Sourced<PullRequestLookup>;
const failing = (head: number, names = ['lint']) => pr({ headSha: SHA(head), checks: 'failing', failedChecks: names.map((name) => ({ name, url: `https://ci/${name}` })), readiness: 'blocked' });

const T0 = 1_000_000_000;
const start = (merge = false, rounds = 3, watch = false): AutopilotRecord => ({ ...newRecord(7, { merge, watch }, { ...DEFAULT_AUTOPILOT_PREFS, rounds }), head: { sha: SHA(1), at: T0 - CHECKS_SETTLE_MS * 2 } });
const step = (record: AutopilotRecord, p: PullRequest, over: Partial<StepInput> = {}) => autopilotStep({ record, lookup: lookup(p), attention: DEFAULT_ATTENTION_PREFS, idle: true, failed: false, now: T0, ...over });

describe('settings', () => {
  test('defaults: offered, never always, 3 rounds of an hour', () => {
    expect(sanitizeAutopilotPrefs(undefined)).toEqual({ offer: true, always: false, merge: false, rounds: 3, roundMinutes: 60, watch: false, watchMinutes: 60 });
    expect(sanitizeAutopilotPrefs({ rounds: 99, roundMinutes: 5 })).toMatchObject({ rounds: 3, roundMinutes: 60 });
    // Stored before the watch existed: watch off, its limit the default.
    expect(sanitizeAutopilotPrefs({ offer: true, always: false, merge: true, rounds: 2, roundMinutes: 30 })).toMatchObject({ merge: true, watch: false, watchMinutes: 60 });
    expect(sanitizeAutopilotPrefs({ watch: true, watchMinutes: 1440 })).toMatchObject({ watch: true, watchMinutes: 1440 });
    expect(sanitizeAutopilotPrefs({ watch: 'yes', watchMinutes: 1441 })).toMatchObject({ watch: false, watchMinutes: 60 });
  });

  test('the watch and its own time limit are checked like the rest', () => {
    expect(checkAutopilotChange({ watch: true, watchMinutes: 120 })).toEqual({ ok: true, change: { watch: true, watchMinutes: 120 } });
    const refused = checkAutopilotChange({ watchMinutes: 5 });
    expect(!refused.ok && refused.reason).toMatch(/pipeline watch's time limit must be from 10 minutes to 24 hours/);
    expect(ALWAYS_WARNING).toMatch(/fixes it in a new pull request/);
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

describe('a branch behind its base', () => {
  const behind = (head: number, over: Partial<PullRequest> = {}) => pr({ headSha: SHA(head), readiness: 'behind', ...over });

  test('starts a round that merges the base in, without a force-push', () => {
    const { record, act } = step(start(), behind(1));
    expect(act.type === 'round' && act.message).toMatch(/^Autopilot, round 1 of 3: #7[\s\S]*is behind `main`[\s\S]*merge the remote's `main` into this branch[\s\S]*Do not force-push/);
    expect(record.round).toMatchObject({ head: SHA(1), failed: [] });
    expect(record.rounds).toBe(1);
  });

  test('waits while a review is still required, checks run, or the new commit is settling', () => {
    expect(step(start(), behind(1, { review: 'review-required' })).act).toEqual({ type: 'none' });
    expect(step(start(), behind(1, { checks: 'running' })).act).toEqual({ type: 'none' });
    expect(step({ ...start(), head: { sha: SHA(1), at: T0 - 1000 } }, behind(1)).act).toEqual({ type: 'none' });
  });

  test('behind again after its round is another round; out of rounds it stops and says so', () => {
    let { record } = step(start(false, 1), behind(1));
    ({ record } = step(record, pr({ headSha: SHA(2), checks: 'running' }), { now: T0 + 60_000 }));
    const again = step(record, behind(2), { now: T0 + 60_000 + CHECKS_SETTLE_MS });
    expect(again.act).toMatchObject({ type: 'stop', stop: { why: `${AUTOPILOT_DISENGAGED} #7 after 1 round: its branch is behind main`, notify: true } });
  });

  test('a round that pushed nothing stops', () => {
    const { record } = step(start(), behind(1));
    const waited = step(record, behind(1), { now: T0 + 1000 });
    expect(step(waited.record, behind(1), { now: T0 + 1000 + NO_PUSH_GRACE_MS }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/pushed nothing in round 1/) } });
  });
});

describe('when it stops', () => {
  test('a failure reported just after the push is not believed until the new commit\'s checks settle', () => {
    // The host still answers with the last commit's failed checks for a moment after a push.
    const { record } = step(start(true), failing(1, ['test']));
    const stale = step(record, failing(2, ['test']), { now: T0 + 1000 });
    expect(stale.act).toEqual({ type: 'none' });
    expect(stale.record.stopped).toBeUndefined();
    const running = step(stale.record, pr({ headSha: SHA(2), checks: 'running' }), { now: T0 + 20_000 });
    expect(running.act).toEqual({ type: 'none' });
    expect(step(running.record, pr({ headSha: SHA(2), checks: 'passing', readiness: 'ready' }), { now: T0 + 1000 + CHECKS_SETTLE_MS }).act).toMatchObject({ type: 'merge' });
  });

  test('rounds used up: it stops and names what still fails', () => {
    let record = start(false, 1);
    ({ record } = step(record, failing(1)));
    ({ record } = step(record, failing(2, ['test']), { now: T0 + 1000 }));
    const { act, record: after } = step(record, failing(2, ['test']), { now: T0 + 1000 + CHECKS_SETTLE_MS });
    expect(act).toMatchObject({ type: 'stop', stop: { why: 'Autopilot disengaged. #7 after 1 round: checks failed on #7: test', notify: true } });
    expect(after.stopped).toBeDefined();
    expect(step(after, failing(3)).act).toEqual({ type: 'none' });
  });

  test('the same checks failing again is an impasse', () => {
    const { record } = step(start(), failing(1, ['lint', 'test']));
    const pushed = step(record, failing(2, ['test', 'lint']), { now: T0 + 1000 });
    expect(pushed.act).toEqual({ type: 'none' });
    expect(step(pushed.record, failing(2, ['test', 'lint']), { now: T0 + 1000 + CHECKS_SETTLE_MS }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/same checks failed again after round 1 \(lint, test\)/) } });
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
    const on = newRecord(7, { merge: false, watch: false }, DEFAULT_AUTOPILOT_PREFS);
    expect(autopilotLabel(undefined)).toBe('Autopilot off');
    expect(autopilotLabel(on)).toBe('Autopilot');
    expect(autopilotLabel({ ...on, merge: true, waiting: true })).toBe('Autopilot · merge · waiting');
    expect(autopilotLabel({ ...on, rounds: 1, round: { startedAt: 0, head: 'a', failed: [] } })).toBe('Autopilot · round 1 of 3');
    expect(autopilotLabel({ ...on, stopped: { at: 0, why: 'x', notify: true } })).toBe('Autopilot stopped');
    expect(autopilotLabel({ ...on, stopped: { at: 0, why: 'x', notify: false } })).toBe('Autopilot off');
    expect(autopilotLabel({ ...on, merge: true, watch: true })).toBe('Autopilot · merge · watch');
    expect(autopilotLabel({ ...on, watch: true, watching: { host: 'github', request: '#7', base: 'main', sha: 'a', since: 0 } })).toBe('Autopilot · watching main');
    expect(autopilotText({ ...on, watch: true, watching: { host: 'github', request: '#431', base: 'main', sha: 'a', since: 0 } })).toBe('On: watching the main pipeline after #431');
  });

  test('the menu has a third switch for the watch, named by the target branch, while it is on', () => {
    const on = newRecord(7, { merge: false, watch: false }, DEFAULT_AUTOPILOT_PREFS);
    expect(autopilotMenu('s1', null, 'main').map((i) => i.id)).toEqual(['autopilot']);
    const items = autopilotMenu('s1', on, 'main');
    expect(items.find((i) => i.id === 'autopilot-watch')).toMatchObject({ label: 'Watch the main pipeline after merging', checked: false, action: { type: 'set-autopilot', on: true, watch: true } });
    expect(autopilotMenu('s1', on).find((i) => i.id === 'autopilot-watch')?.label).toBe('Watch the target branch’s pipeline after merging');
  });
});

describe('watching the target branch\'s pipeline after the merge', () => {
  const MERGE = SHA(9);
  const merged = (over: Partial<PullRequest> = {}) => pr({ state: 'merged', mergeSha: MERGE, ...over });
  const pipeline = (checks: BasePipeline['checks'], failed: string[] = [], sha = MERGE): StepInput['pipeline'] => ({ state: 'ready', value: { sha, checks, ...(failed.length ? { failedChecks: failed.map((name) => ({ name, url: `https://ci/${name}` })) } : {}), url: 'https://ci/pipeline' } });
  /** Merged with watch on, seen at T0: the record watching. */
  const watching = (rounds = 3, record: AutopilotRecord = start(false, rounds, true)) => {
    const seen = step(record, merged());
    expect(seen.act).toMatchObject({ type: 'watch', watching: { host: 'github', request: '#7', base: 'main', sha: MERGE, since: T0 } });
    return seen.record;
  };

  test('without watch, a merge ends it quietly as before', () => {
    expect(step(start(), merged()).act).toEqual({ type: 'stop', stop: { at: T0, why: '#7 was merged', notify: false } });
  });

  test('with watch, a merge by anyone starts watching the commit it made, during a round too', () => {
    const record = watching();
    expect(record.stopped).toBeUndefined();
    expect(isAtWork(record)).toBe(true);
    const during = step({ ...start(false, 3, true), rounds: 1, round: { startedAt: T0, head: SHA(1), failed: [] } }, merged());
    expect(during.record.round).toBeUndefined();
    expect(during.act.type).toBe('watch');
    // A fast-forward with no merge commit named: the head commit.
    expect(step(start(false, 3, true), pr({ state: 'merged' })).act).toMatchObject({ type: 'watch', watching: { sha: SHA(1) } });
  });

  test('passed: one line, and it ends quietly', () => {
    const { act, record } = step(watching(), merged(), { pipeline: pipeline('passing'), now: T0 + 60_000 });
    expect(act).toEqual({ type: 'end', line: 'Autopilot: the main pipeline passed after #7.' });
    expect(record.stopped).toMatchObject({ notify: false });
    expect(record.watching).toBeUndefined();
  });

  test('an answer about another commit, or one still running, is waited on', () => {
    const record = watching();
    expect(step(record, merged(), { pipeline: pipeline('passing', [], SHA(8)), now: T0 + 60_000 }).act).toEqual({ type: 'none' });
    expect(step(record, merged(), { pipeline: pipeline('running'), now: T0 + 60_000 }).act).toEqual({ type: 'none' });
    expect(step(record, merged(), { pipeline: { state: 'unavailable', reason: 'gh is not signed in' }, now: T0 + CHECKS_SETTLE_MS * 2 }).act).toEqual({ type: 'none' });
  });

  test('no pipeline within the settle time: ends quietly with a line', () => {
    const record = watching();
    expect(step(record, merged(), { pipeline: pipeline('none'), now: T0 + 1000 }).act).toEqual({ type: 'none' });
    expect(step(record, merged(), { pipeline: pipeline('none'), now: T0 + CHECKS_SETTLE_MS }).act).toEqual({ type: 'end', line: 'Autopilot: no pipeline ran on main after #7, so there was nothing to watch.' });
  });

  test('running past its own time limit: stops and tells the user', () => {
    const record = { ...watching(), watchMinutes: 30 };
    const { act } = step(record, merged(), { pipeline: pipeline('running'), now: T0 + 31 * 60_000 });
    expect(act).toMatchObject({ type: 'stop', stop: { why: `${AUTOPILOT_DISENGAGED} The main pipeline after #7 did not finish within 30 minutes`, notify: true } });
  });

  test('failed: a round that fixes it in a new request, then it waits for that request', () => {
    const { act, record } = step(watching(), merged(), { pipeline: pipeline('failing', ['test', 'lint']), now: T0 + 60_000 });
    expect(act.type).toBe('round');
    const message = act.type === 'round' ? act.message : '';
    expect(message).toMatch(/^Autopilot, round 1 of 3: the pipeline on `main` failed at commit 99999999, after #7 was merged/);
    expect(message).toContain('- lint: https://ci/lint');
    expect(message).toContain('- The whole pipeline: https://ci/pipeline');
    expect(message).toMatch(/merge the remote's `main` into this branch \(a merge, not a rebase; never force-push, and never push to `main` itself\)/);
    expect(message).toMatch(/open a new pull request into `main` whose description says it fixes the `main` pipeline after #7/);
    expect(record).toMatchObject({ waiting: true, number: 0, rounds: 1, watch: true, fixing: { request: '#7', base: 'main' }, pipelineFailed: ['lint', 'test'], round: { startedAt: T0 + 60_000, head: '', failed: ['lint', 'test'] } });
    expect(record.watching).toBeUndefined();
    expect(autopilotLabel(record)).toBe('Autopilot · watch · round 1 of 3');
    expect(autopilotText(record)).toMatch(/round 1 of 3 under way, fixing the main pipeline after #7/);
  });

  test('a failure waits for a turn already under way to end', () => {
    expect(step(watching(), merged(), { pipeline: pipeline('failing', ['lint']), idle: false, now: T0 + 60_000 }).act).toEqual({ type: 'none' });
  });

  test('a failure with no rounds left stops it, naming the failed jobs', () => {
    const record = { ...watching(1), rounds: 1 };
    expect(step(record, merged(), { pipeline: pipeline('failing', ['lint']), now: T0 + 60_000 }).act).toMatchObject({ type: 'stop', stop: { why: `${AUTOPILOT_DISENGAGED} The main pipeline failed after #7 (lint), and all 1 round is used`, notify: true } });
  });

  test('waiting for the new request: no request within the grace is the impasse; a failed turn or the time limit stop it', () => {
    const { record } = step(watching(), merged(), { pipeline: pipeline('failing', ['lint']), now: T0 + 60_000 });
    // The lookup still holds only the merged request.
    expect(step(record, merged(), { idle: false, now: T0 + 70_000 }).act).toEqual({ type: 'none' });
    const idle = step(record, merged(), { now: T0 + 120_000 });
    expect(idle.record.round?.idleSince).toBe(T0 + 120_000);
    expect(step(idle.record, merged(), { now: T0 + 120_000 + NO_PUSH_GRACE_MS }).act).toMatchObject({ type: 'stop', stop: { why: `${AUTOPILOT_DISENGAGED} The agent opened no request to fix the main pipeline after #7 in round 1`, notify: true } });
    expect(step(record, merged(), { failed: true, now: T0 + 70_000 }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/turn in round 1, fixing the main pipeline after #7, failed or was stopped/) } });
    expect(step(record, merged(), { idle: false, now: T0 + 62 * 60_000 }).act).toMatchObject({ type: 'stop', stop: { why: expect.stringMatching(/Round 1, fixing the main pipeline after #7, went over its time limit of 1 hour/) } });
  });

  test('the new request carries the round on: it is looked after as any, merges, and its own pipeline is watched', () => {
    const { record: waiting } = step(watching(), merged(), { pipeline: pipeline('failing', ['lint']), now: T0 + 60_000 });
    const fresh = recordFor(pr({ number: 8, headSha: SHA(2), headSeenAt: T0 + 100_000 }), 8, { merge: true, watch: true }, DEFAULT_AUTOPILOT_PREFS, T0 + 100_000);
    const next = carriedOver(waiting, fresh);
    expect(next).toMatchObject({ number: 8, merge: true, watch: true, rounds: 1, pipelineFailed: ['lint'], round: { head: '' } });
    expect(next.waiting).toBeUndefined();
    const eight = (over: Partial<PullRequest> = {}) => ({ state: 'ready', value: { host: 'github', pullRequests: [pr({ number: 8, headSha: SHA(2), ...over }), merged()] } }) as Sourced<PullRequestLookup>;
    const at = (record: AutopilotRecord, over: Partial<PullRequest>, more: Partial<StepInput>) => autopilotStep({ record, lookup: eight(over), attention: DEFAULT_ATTENTION_PREFS, idle: true, failed: false, now: T0, ...more });
    // Its checks settle green: the round is over, and it merges.
    const settled = at(next, {}, { now: T0 + 100_000 + CHECKS_SETTLE_MS });
    expect(settled.record.round).toBeUndefined();
    expect(settled.act).toMatchObject({ type: 'merge', pr: { number: 8 } });
    // Merged: its own pipeline is watched; the same job failing again there stops it.
    const watched = at(settled.record, { state: 'merged', mergeSha: SHA(5) }, { now: T0 + 400_000 });
    expect(watched.act).toMatchObject({ type: 'watch', watching: { request: '#8', sha: SHA(5) } });
    const again = at(watched.record, { state: 'merged', mergeSha: SHA(5) }, { pipeline: pipeline('failing', ['lint'], SHA(5)), now: T0 + 500_000 });
    expect(again.act).toMatchObject({ type: 'stop', stop: { why: `${AUTOPILOT_DISENGAGED} The same jobs failed again on main after #8 (lint)`, notify: true } });
  });

  test('a record from before the watch reads back with it off', () => {
    const old = { number: 7, merge: true, rounds: 0, maxRounds: 3, roundMinutes: 60, handled: [] };
    expect(asRecord(old)).toMatchObject({ watch: false, watchMinutes: 60 });
  });
});

describe('the line that says Autopilot gave a request back', () => {
  test('is known by how it begins, and nothing else is', () => {
    expect(isDisengagedLine(`${AUTOPILOT_DISENGAGED} #7: the agent pushed nothing in round 2. ${CONTROLS_YOURS}`)).toBe(true);
    expect(isDisengagedLine('Autopilot merged #7.')).toBe(false);
    expect(isDisengagedLine('Could not start the agent.')).toBe(false);
  });
});
