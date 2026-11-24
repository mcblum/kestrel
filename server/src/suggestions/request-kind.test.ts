// The cards about a pull request that needs the user (suggestions/request-kind.ts) through a real
// runtime, raised and withdrawn from the PR store by the watcher (pull-requests/attention-watch.ts):
// one per reason and occurrence, shown only while the session is idle, never for a guest; each reason's
// main button sends the agent a turn; Dismiss; Don't ask again is the Settings → Git choice; a reason
// turned off there is not watched; and a card withdraws itself when its reason no longer holds.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitSettingsRoute } from '../git-settings/api.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { AttentionWatch } from '../pull-requests/attention-watch.ts';
import { PullRequestStore } from '../pull-requests/store.ts';
import { SessionRuntime } from '../runtime.ts';
import type { PullRequest } from '../shared/details.ts';
import { DEFAULT_ATTENTION_PREFS } from '../shared/request-attention.ts';
import { ready } from '../shared/sourced.ts';
import { statusOf } from '../shared/status.ts';
import { openSuggestions, suggestionsIn } from '../shared/suggestions.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { REQUEST_KIND } from './request-kind.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CHANGES = { id: 'PRR_1', reviewers: ['sam'], url: 'https://github.com/o/r/pull/431#pullrequestreview-9', body: 'Not yet.', comments: [{ body: 'Rename this.', path: 'src/a.ts', line: 3, url: 'https://github.com/o/r/pull/431#discussion_r1' }] };
const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({ number: 431, title: 'Polish the sign-in form', state: 'open', checks: 'failing', review: 'none', url: 'https://github.com/o/r/pull/431', headSha: SHA, baseBranch: 'main', failedChecks: [{ name: 'lint', url: 'https://github.com/o/r/actions/runs/1/job/2' }], ...fields });
const passing = { checks: 'passing' as const, failedChecks: undefined };

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-requests-'))));
  const store = new PullRequestStore(() => 0);
  const watch = runtime.watchRequestAttention(store);
  let n = 0;
  /** The store's answer for the session becomes these requests. */
  const answer = async (id: string, prs: PullRequest[]) => {
    await store.get(id, `k${++n}`, async () => ready({ host: 'github' as const, pullRequests: prs }));
    await watch.look();
  };
  const start = async () => {
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Polish the sign-in form' });
    await agents.settled();
    await runtime.idle(session.id);
    return session.id;
  };
  const cards = (id: string) => suggestionsIn(runtime.recordOf(id)?.messages ?? []).filter((s) => s.kind === REQUEST_KIND);
  const open = (id: string) => openSuggestions(runtime.recordOf(id)?.messages ?? []).filter((s) => s.kind === REQUEST_KIND);
  const route = (method: string, body: Record<string, unknown> = {}) => gitSettingsRoute(['api', 'request-attention'], method, async () => body, runtime.gitPrefs);
  return { workspace, agents, runtime, store, watch, answer, start, cards, open, route };
}

describe('the card for failed checks', () => {
  it('names the failed checks with links and offers Fix, Dismiss and Don’t ask again, without touching the session', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    const [card] = w.open(id);
    expect(card).toMatchObject({ title: 'Checks failed on #431: lint', detail: '- [lint](https://github.com/o/r/actions/runs/1/job/2)' });
    expect(card!.buttons.map((b) => b.label)).toEqual(['Fix them', 'Dismiss', 'Don’t ask again']);
    expect(w.agents.turns).toHaveLength(1); // it started nothing
    const row = (await w.workspace.state()).sessions.find((s) => s.id === id)!;
    expect(statusOf(row)).toBe('done');
  });

  it('is shown once per commit, however often the store answers', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    await w.answer(id, [pr({ checks: 'running', failedChecks: undefined })]);
    await w.answer(id, [pr()]); // the same commit failed again
    expect(w.cards(id)).toHaveLength(1);
    await w.answer(id, [pr({ headSha: 'f'.repeat(40) })]);
    expect(w.cards(id).map((c) => c.payload.occurrence)).toEqual([SHA, 'f'.repeat(40)]);
  });

  it('waits while the session works, and comes when the turn ends', async () => {
    const w = await world();
    const id = await w.start();
    w.agents.hold = true;
    await w.runtime.reply(id, 'One more thing');
    await w.agents.settled();
    await w.answer(id, [pr()]);
    expect(w.cards(id)).toHaveLength(0);
    w.agents.turns.at(-1)!.done();
    await w.runtime.idle(id);
    await w.watch.look();
    expect(w.open(id)).toHaveLength(1);
  });

  it('Fix sends the agent a message naming the checks and their logs, as a turn the user started', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    const settled = await w.runtime.suggestions.answer(id, w.open(id)[0]!.id, 'fix');
    expect(settled).toMatchObject({ state: 'answered', line: 'Asked the agent to fix the failed checks on #431' });
    await w.agents.settled();
    await w.runtime.idle(id);
    expect(w.agents.turns).toHaveLength(2);
    expect(w.agents.turns[1]!.text).toContain('- lint: https://github.com/o/r/actions/runs/1/job/2');
  });

  it('Fix on a card whose checks have since passed says so and sends nothing', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    const card = w.open(id)[0]!;
    await w.store.get(id, 'after', async () => ready({ host: 'github' as const, pullRequests: [pr(passing)] }));
    await expect(w.runtime.suggestions.answer(id, card.id, 'fix')).rejects.toThrow(/no longer failing/);
    expect(w.agents.turns).toHaveLength(1);
  });

  it('withdraws itself when the checks pass, or the request is merged', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    await w.answer(id, [pr(passing)]);
    expect(w.cards(id)).toMatchObject([{ state: 'expired', line: 'Checks passed on #431' }]);
    await w.answer(id, [pr({ headSha: 'e'.repeat(40) })]);
    await w.answer(id, [pr({ headSha: 'e'.repeat(40), state: 'merged', failedChecks: undefined })]);
    expect(w.cards(id).at(-1)).toMatchObject({ state: 'expired', line: '#431 was merged' });
  });
});

describe('the card for merge conflicts', () => {
  it('names the target, offers to resolve them, and asks the agent to merge it in here without force-pushing', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr({ ...passing, readiness: 'conflicts' })]);
    const [card] = w.open(id);
    expect(card).toMatchObject({ title: 'Merge conflicts on #431 with main' });
    expect(card!.reason).toMatch(/merge main into this branch here and resolve them, without force-pushing/);
    expect(card!.buttons.map((b) => b.label)).toEqual(['Resolve them', 'Dismiss', 'Don’t ask again']);
    expect(await w.runtime.suggestions.answer(id, card!.id, 'fix')).toMatchObject({ line: 'Asked the agent to resolve the merge conflicts on #431' });
    await w.agents.settled();
    expect(w.agents.turns[1]!.text).toMatch(/merge the remote's `main` into this branch[\s\S]*Do not force-push/);
  });

  it('is one card while it stays conflicted across pushes, and withdraws when resolved', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr({ ...passing, readiness: 'conflicts' })]);
    await w.answer(id, [pr({ ...passing, readiness: 'conflicts', headSha: 'a'.repeat(40) })]);
    expect(w.cards(id)).toHaveLength(1);
    expect(w.open(id)).toHaveLength(1);
    await w.answer(id, [pr({ ...passing, readiness: 'ready', headSha: 'a'.repeat(40) })]);
    expect(w.cards(id)).toMatchObject([{ state: 'expired', line: 'The conflicts on #431 are resolved' }]);
  });
});

describe('the card for requested changes', () => {
  it('names who asked with a link to the review, and gives the agent the comments, to reply to nobody', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr({ ...passing, review: 'changes-requested', changesRequested: CHANGES })]);
    const [card] = w.open(id);
    expect(card).toMatchObject({ title: 'Changes requested on #431 by sam' });
    expect(card!.detail).toBe(`- [The review](${CHANGES.url})\n- [src/a.ts:3](${CHANGES.comments[0]!.url})`);
    expect(card!.buttons.map((b) => b.label)).toEqual(['Address them', 'Dismiss', 'Don’t ask again']);
    await w.runtime.suggestions.answer(id, card!.id, 'fix');
    await w.agents.settled();
    const text = w.agents.turns[1]!.text;
    expect(text).toContain('- src/a.ts:3: Rename this.');
    expect(text).toMatch(/Do not reply on the pull request/);
  });

  it('a newer review asking for changes is a card of its own; the older one withdraws', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr({ ...passing, review: 'changes-requested', changesRequested: CHANGES })]);
    await w.answer(id, [pr({ ...passing, review: 'changes-requested', changesRequested: { ...CHANGES, id: 'PRR_2' } })]);
    expect(w.cards(id)).toMatchObject([{ state: 'expired', line: 'A newer review asks for changes on #431' }, { state: 'open' }]);
  });
});

describe('several reasons, and the choices in Settings → Git', () => {
  it('two reasons at once are two cards, one each', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr({ readiness: 'conflicts' })]);
    expect(w.open(id).map((c) => c.payload.reason)).toEqual(['checks-failed', 'conflicts']);
  });

  it('Dismiss leaves it; Don’t ask again stops that reason’s card only, and is the Settings → Git choice', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    expect(await w.runtime.suggestions.dismiss(id, w.open(id)[0]!.id)).toMatchObject({ state: 'dismissed', line: 'Failed checks on #431 left as they are' });
    await w.answer(id, [pr({ headSha: 'b'.repeat(40) })]);
    expect(await w.runtime.suggestions.answer(id, w.open(id)[0]!.id, 'never')).toMatchObject({ state: 'answered', line: expect.stringContaining('Settings → Git → Pull requests that need you') });
    expect(await w.route('GET')).toEqual({ status: 200, body: { prefs: { ...DEFAULT_ATTENTION_PREFS, 'checks-failed': { watch: true, card: 'never' } } } });
    await w.answer(id, [pr({ headSha: 'c'.repeat(40), readiness: 'conflicts' })]);
    expect(w.open(id).map((c) => c.payload.reason)).toEqual(['conflicts']);
    expect(await w.route('PATCH', { reason: 'checks-failed', card: 'ask' })).toMatchObject({ status: 200 });
    await w.answer(id, [pr({ headSha: 'd'.repeat(40), readiness: 'conflicts' })]);
    expect(w.open(id).map((c) => c.payload.reason)).toEqual(['conflicts', 'checks-failed']);
  });

  it('refuses a change it cannot save, with the reason', async () => {
    const w = await world();
    expect(await w.route('PATCH', { reason: 'mood', watch: false })).toMatchObject({ status: 400, body: { error: expect.stringContaining('reason must be') } });
    expect(await w.route('PATCH', { reason: 'conflicts', card: 'always' })).toMatchObject({ status: 400 });
    expect(await w.route('PATCH', { reason: 'conflicts' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('Nothing to change') } });
  });

  it('a reason turned off is not watched: no card, and the open one withdraws', async () => {
    const w = await world();
    const id = await w.start();
    await w.answer(id, [pr()]);
    expect(await w.route('PATCH', { reason: 'checks-failed', watch: false })).toMatchObject({ status: 200, body: { prefs: { 'checks-failed': { watch: false } } } });
    await w.watch.look();
    expect(w.cards(id)).toMatchObject([{ state: 'expired', line: 'No longer watched: turned off in Settings → Git' }]);
    await w.answer(id, [pr({ headSha: 'b'.repeat(40) })]);
    expect(w.open(id)).toHaveLength(0);
  });

  it('keeps the other Git settings when one of these is saved', async () => {
    const w = await world();
    await w.runtime.gitPrefs.setStartFromLatest(false);
    await w.route('PATCH', { reason: 'conflicts', watch: false });
    expect(await w.runtime.gitPrefs.startFromLatest()).toBe(false);
    await w.runtime.gitPrefs.setStartFromLatest(true);
    expect((await w.runtime.gitPrefs.attention()).conflicts.watch).toBe(false);
  });

  it('goes to the host, never to a guest sharing its worktree', async () => {
    // The store holds a guest's requests under its host (shared/working-tree.ts): the guest is skipped.
    const sessions = [{ id: 'host', state: 'done' as const, note: '' }, { id: 'guest', state: 'done' as const, note: '', hostId: 'host' }];
    const raised: string[] = [];
    const watch = new AttentionWatch({ sessions: async () => sessions, lookup: () => ready({ host: 'github', pullRequests: [pr()] }), prefs: async () => DEFAULT_ATTENTION_PREFS, onChange: () => () => undefined, raise: async (id) => void raised.push(id), withdraw: async () => 0 });
    await watch.look();
    await watch.look();
    expect(raised).toEqual(['host']);
  });
});
