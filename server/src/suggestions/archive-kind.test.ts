// The offer to archive a review session after the user's approval was posted (archive-kind.ts,
// runtime.ts `approvalPosted`), through a real runtime with a scripted agent: when it is raised, each
// button, the standing answers, the refusal while the session works, Undo, and that the request's
// one review session is brought back rather than a second made.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { ALWAYS_LINE, ARCHIVE_KIND, ARCHIVED_LINE, NEVER_LINE, RESTORED_LINE, SKIPPED_LINE } from '../shared/archive-approved.ts';
import { reviewRequestKey, type ReviewRequest } from '../shared/review-requests.ts';
import { openSuggestions, suggestionsIn } from '../shared/suggestions.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';

const base = { host: 'github' as const, hostName: 'github.com', repository: 'acme/app', number: 12, title: 'Fix the cache', author: 'sam', url: 'https://github.com/acme/app/pull/12', updatedAt: 1, projectId: null };
const request: ReviewRequest = { ...base, key: reviewRequestKey(base) };

function world() {
  const db = memoryPersistence();
  const workspace = new Workspace(db);
  const agents = new FakeAgents();
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-archive-offer-')));
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { suggestions: { settings: db }, reviewPrefs: { settings: db } });
  const dismissed = new Set<string>();
  runtime.useReviewDismissed((key) => dismissed.has(key));
  /** A review session of the request, its turn over. */
  const reviewSession = async () => {
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Review it', title: 'Review: Fix the cache', review: { key: request.key, host: 'github', number: 12, sha: 'a'.repeat(40), url: request.url } });
    await agents.settled();
    await runtime.idle(session.id);
    return session.id;
  };
  const offers = (id: string) => suggestionsIn(runtime.recordOf(id)?.messages ?? []).filter((s) => s.kind === ARCHIVE_KIND);
  const open = (id: string) => openSuggestions(runtime.recordOf(id)?.messages ?? []).find((s) => s.kind === ARCHIVE_KIND);
  const archived = async (id: string) => (await workspace.state()).archived.sessions.some((s) => s.id === id);
  return { workspace, agents, runtime, dismissed, reviewSession, offers, open, archived };
}

describe('the offer to archive a review session after an approval', () => {
  it('is raised once an approval was posted, asking with Archive, Always archive, Not now and Don’t ask again', async () => {
    const w = world();
    const id = await w.reviewSession();
    expect(w.offers(id)).toEqual([]);
    await w.runtime.approvalPosted(id, '#12');
    const card = w.open(id)!;
    expect(card).toMatchObject({ title: 'Archive this review session?', reason: expect.stringContaining('Your approval of #12 was posted') });
    expect(card.buttons.map((b) => b.label)).toEqual(['Archive', 'Always archive', 'Not now', "Don't ask again"]);
    // Asked once: a second approval while it is open does not add another.
    await w.runtime.approvalPosted(id, '#12');
    expect(w.offers(id)).toHaveLength(1);
    // It never makes the session need the user.
    expect((await w.workspace.state()).sessions.find((s) => s.id === id)?.state).toBe('done');
  });

  it('is not raised for a request the user dismissed, nor in a session that reviews nothing', async () => {
    const w = world();
    const id = await w.reviewSession();
    w.dismissed.add(request.key);
    await w.runtime.approvalPosted(id, '#12');
    expect(w.offers(id)).toEqual([]);
    const plain = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'Something else' });
    await w.agents.settled();
    await w.runtime.idle(plain.id);
    await w.runtime.approvalPosted(plain.id, '#12');
    expect(w.offers(plain.id)).toEqual([]);
  });

  it('Archive archives it through the one archive, and Undo on the line brings it back', async () => {
    const w = world();
    const id = await w.reviewSession();
    await w.runtime.approvalPosted(id, '#12');
    const answered = await w.runtime.suggestions.answer(id, w.open(id)!.id, 'archive');
    expect(answered).toMatchObject({ state: 'answered', line: ARCHIVED_LINE, undo: { sessionId: id } });
    expect(await w.archived(id)).toBe(true);
    const undone = await w.runtime.suggestions.undo(id, answered.id);
    expect(undone.line).toBe(RESTORED_LINE);
    expect(undone.undo).toBeUndefined();
    expect(await w.archived(id)).toBe(false);
  });

  it('Not now and the small x keep the session; Don’t ask again stops the offer until it is set back to Ask', async () => {
    const w = world();
    const first = await w.reviewSession();
    await w.runtime.approvalPosted(first, '#12');
    expect(await w.runtime.suggestions.answer(first, w.open(first)!.id, 'skip')).toMatchObject({ state: 'dismissed', line: SKIPPED_LINE });
    const second = await w.reviewSession();
    await w.runtime.approvalPosted(second, '#12');
    expect(await w.runtime.suggestions.dismiss(second, w.open(second)!.id)).toMatchObject({ state: 'dismissed', line: SKIPPED_LINE });
    expect(await w.archived(first)).toBe(false);
    expect(await w.archived(second)).toBe(false);

    const third = await w.reviewSession();
    await w.runtime.approvalPosted(third, '#12');
    expect(await w.runtime.suggestions.answer(third, w.open(third)!.id, 'never')).toMatchObject({ state: 'answered', line: NEVER_LINE });
    expect((await w.runtime.reviewPrefs.current()).afterApproval).toBe('never');
    expect(await w.archived(third)).toBe(false);
    const fourth = await w.reviewSession();
    await w.runtime.approvalPosted(fourth, '#12');
    expect(w.offers(fourth)).toEqual([]);

    await w.runtime.reviewPrefs.set({ afterApproval: 'ask' });
    await w.runtime.approvalPosted(fourth, '#12');
    expect(w.open(fourth)).toBeDefined();
  });

  it('Always archive archives it, and from then on a session is archived without asking, the line keeping Undo', async () => {
    const w = world();
    const first = await w.reviewSession();
    await w.runtime.approvalPosted(first, '#12');
    expect(await w.runtime.suggestions.answer(first, w.open(first)!.id, 'always')).toMatchObject({ line: ALWAYS_LINE, undo: { sessionId: first } });
    expect(await w.archived(first)).toBe(true);
    expect((await w.runtime.reviewPrefs.current()).afterApproval).toBe('always');

    const second = await w.reviewSession();
    await w.runtime.approvalPosted(second, '#12');
    expect(w.open(second)).toBeUndefined();
    const [auto] = w.offers(second);
    expect(auto).toMatchObject({ state: 'answered', auto: true, line: ARCHIVED_LINE, undo: { sessionId: second } });
    expect(await w.archived(second)).toBe(true);
    await w.runtime.suggestions.undo(second, auto!.id);
    expect(await w.archived(second)).toBe(false);
  });

  it('waits while the session is on a turn and offers when the turn ends; a press while it works is refused in the archive’s own words', async () => {
    const w = world();
    const id = await w.reviewSession();
    w.agents.hold = true;
    await w.runtime.reply(id, 'One more look');
    await w.agents.settled();
    expect((await w.workspace.state()).sessions.find((s) => s.id === id)?.state).toBe('running');
    await w.runtime.approvalPosted(id, '#12');
    expect(w.offers(id)).toEqual([]);
    w.agents.turns.at(-1)!.done();
    await w.runtime.idle(id);
    await w.agents.settled();
    for (let i = 0; i < 20 && !w.open(id); i++) await new Promise((r) => setTimeout(r, 5));
    const card = w.open(id)!;
    expect(card).toBeDefined();

    // The user starts another turn before answering: archiving is refused, and the card stays.
    await w.runtime.reply(id, 'And another');
    await w.agents.settled();
    await expect(w.runtime.suggestions.answer(id, card.id, 'archive')).rejects.toThrow(/is still working\. Stop it before archiving/);
    expect(w.open(id)?.id).toBe(card.id);
    expect(await w.archived(id)).toBe(false);
    // "Always" is not stored when the archive was refused.
    await expect(w.runtime.suggestions.answer(id, card.id, 'always')).rejects.toThrow(/still working/);
    expect((await w.runtime.reviewPrefs.current()).afterApproval).toBe('ask');
  });

  it('a request whose review session was archived is not reviewed twice: starting it brings that session back', async () => {
    const w = world();
    const id = await w.reviewSession();
    await w.runtime.approvalPosted(id, '#12');
    await w.runtime.suggestions.answer(id, w.open(id)!.id, 'archive');
    expect(await w.archived(id)).toBe(true);
    const again = await w.runtime.startReview(request);
    expect(again.id).toBe(id);
    expect(await w.archived(id)).toBe(false);
  });
});
