// The cards about a pull request (shared/request-cards.ts), through a real runtime (issue 78): a delegate
// child's are shown once, on the top of its tree, naming the child, and act on the child when answered
// there; and every such card goes by itself, unanswered, once its request is merged or closed.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { PullRequestStore } from '../pull-requests/store.ts';
import { SessionRuntime } from '../runtime.ts';
import type { PullRequest } from '../shared/details.ts';
import { ready } from '../shared/sourced.ts';
import { openSuggestions, suggestionsIn } from '../shared/suggestions.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { AUTOPILOT_KIND } from './autopilot-kind.ts';
import { REQUEST_KIND } from './request-kind.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({ number: 12, title: 'Part B', state: 'open', checks: 'passing', review: 'none', url: 'https://github.com/o/b/pull/12', headSha: SHA, baseBranch: 'main', ...fields });

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-request-cards-'))));
  const store = new PullRequestStore(() => 0);
  const watch = runtime.watchRequestAttention(store);
  let n = 0;
  const answer = async (id: string, prs: PullRequest[]) => {
    await store.get(id, `k${++n}`, async () => ready({ host: 'github' as const, pullRequests: prs }));
    await watch.look();
  };
  const root = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Ship the feature across two apps' });
  await agents.settled();
  await runtime.idle(root.id);
  const project = await workspace.addProject({ name: 'App B', path: '/nowhere/app-b' });
  const { children } = await workspace.delegate(root.id, [{ projectId: project.id, brief: 'Do part B', title: 'Part B' }]);
  const child = children[0]!.id;
  await workspace.setState(child, 'done', 'Finished');
  const open = (id: string) => openSuggestions(runtime.recordOf(id)?.messages ?? []);
  const all = (id: string) => suggestionsIn(runtime.recordOf(id)?.messages ?? []);
  return { workspace, runtime, store, watch, answer, root: root.id, child, open, all };
}

describe('a delegate child’s cards about its pull request', () => {
  it('are shown once, on the top of the tree, naming the child; the child shows none', async () => {
    const w = await world();
    await w.answer(w.child, [pr({ checks: 'failing', failedChecks: [{ name: 'lint' }] })]);
    const [card] = w.open(w.root);
    expect(card).toMatchObject({ kind: REQUEST_KIND, sessionId: w.root, about: w.child, title: 'Checks failed on #12: lint' });
    expect(card!.reason).toMatch(/^For “Part B”, a session this one started\./);
    expect(w.all(w.child)).toEqual([]);
    // Asked again, it is the same card, not a second one.
    await w.runtime.suggestions.suggest(w.child, { kind: AUTOPILOT_KIND, host: 'github', number: 12 });
    await w.runtime.suggestions.suggest(w.child, { kind: AUTOPILOT_KIND, host: 'github', number: 12 });
    expect(w.open(w.root).filter((s) => s.kind === AUTOPILOT_KIND)).toHaveLength(1);
  });

  it('answered on the top, act on the child: Autopilot is turned on for the child’s request', async () => {
    const w = await world();
    await w.answer(w.child, [pr()]);
    await w.runtime.suggestions.suggest(w.child, { kind: AUTOPILOT_KIND, host: 'github', number: 12 });
    const offer = w.open(w.root).find((s) => s.kind === AUTOPILOT_KIND)!;
    const answered = await w.runtime.suggestions.answer(w.root, offer.id, 'on');
    expect(answered).toMatchObject({ state: 'answered', opens: w.child });
    expect(await w.workspace.autopilot(w.child)).toMatchObject({ number: 12 });
    expect(await w.workspace.autopilot(w.root)).toBeNull();
  });

  it('its Turn on carries the ticked choices: merge and the watch of the target branch\'s pipeline', async () => {
    const w = await world();
    await w.answer(w.child, [pr()]);
    await w.runtime.suggestions.suggest(w.child, { kind: AUTOPILOT_KIND, host: 'github', number: 12, base: 'main' });
    const offer = w.open(w.root).find((s) => s.kind === AUTOPILOT_KIND)!;
    expect(offer.buttons[0]?.toggles?.map((t) => t.label)).toEqual(['Merge it when it is green', 'Watch the main pipeline after merging']);
    // Only the pressed button's own choices may be ticked.
    await expect(w.runtime.suggestions.answer(w.root, offer.id, 'on', undefined, ['deploy'])).rejects.toThrow('That button has no such choice to tick.');
    await expect(w.runtime.suggestions.answer(w.root, offer.id, 'later', undefined, ['watch'])).rejects.toThrow('That button has nothing to tick.');
    const answered = await w.runtime.suggestions.answer(w.root, offer.id, 'on', undefined, ['watch']);
    expect(answered.line).toMatch(/watches the main pipeline after merging/);
    expect(await w.workspace.autopilot(w.child)).toMatchObject({ number: 12, merge: false, watch: true });
  });
});

describe('a card about a request that was merged or closed', () => {
  it('goes by itself, wherever it is shown, with a line and nothing done', async () => {
    const w = await world();
    await w.answer(w.child, [pr({ checks: 'failing', failedChecks: [{ name: 'lint' }] })]);
    await w.runtime.suggestions.suggest(w.child, { kind: AUTOPILOT_KIND, host: 'github', number: 12 });
    expect(w.open(w.root)).toHaveLength(2);
    await w.answer(w.child, [pr({ state: 'merged', checks: 'passing' })]);
    expect(w.open(w.root)).toEqual([]);
    expect(w.all(w.root).map((s) => [s.kind, s.state, s.line])).toEqual([
      [REQUEST_KIND, 'expired', '#12 was merged'],
      [AUTOPILOT_KIND, 'expired', '#12 was merged'],
    ]);
    expect(await w.workspace.autopilot(w.child)).toBeNull();
  });

  it('a press on one whose withdrawal was missed (a restart) leaves its line and turns nothing on', async () => {
    const w = await world();
    await w.answer(w.child, [pr()]);
    await w.runtime.suggestions.suggest(w.child, { kind: AUTOPILOT_KIND, host: 'github', number: 12 });
    const offer = w.open(w.root)[0]!;
    // The store learns of the merge with no look between (as after a restart): no withdrawal yet.
    await w.store.get(w.child, 'after', async () => ready({ host: 'github' as const, pullRequests: [pr({ state: 'merged' })] }));
    const pressed = await w.runtime.suggestions.answer(w.root, offer.id, 'on');
    expect(pressed).toMatchObject({ state: 'expired', line: '#12 was merged' });
    expect(await w.workspace.autopilot(w.child)).toBeNull();
  });

  it('a session’s own card goes too, and the offer for a request still open stays', async () => {
    const w = await world();
    await w.answer(w.root, [pr({ number: 3 }), pr({ number: 4 })]);
    await w.runtime.suggestions.suggest(w.root, { kind: AUTOPILOT_KIND, host: 'github', number: 3 });
    await w.runtime.suggestions.suggest(w.root, { kind: AUTOPILOT_KIND, host: 'github', number: 4 });
    await w.answer(w.root, [pr({ number: 3, state: 'closed' }), pr({ number: 4 })]);
    expect(w.open(w.root).map((s) => s.payload.number)).toEqual([4]);
  });
});
