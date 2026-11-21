// Sessions that share a worktree (shared/worktree-guests.ts, delegation.ts): a role's part done in
// the asking session's worktree with one writer at a time, the hand-back, and a review in rounds.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { findingsText, guestEditRefusal, handBackText, reviewEndNotice, reviewForRequest, sanitizeGuest, verdictOf, writerRefusal } from './shared/worktree-guests.ts';
import { cleanWhoDoesWhat, noReviewerReason, pickReviewer, reviewersOf, type WhoDoesWhat } from './shared/who-does-what.ts';
import { FakeAgents, until, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const who: WhoDoesWhat = {
  presets: [
    { id: 'astra', name: 'Astra', agent: 'codex', model: 'gpt-6.2-astra', effort: 'high', fast: false },
    { id: 'critic', name: 'Critic', agent: 'codex', model: 'gpt-6.2', effort: '', fast: false },
  ],
  roles: { design: 'astra', build: null, review: 'critic' },
  instruction: '',
};

describe('the rule in words', () => {
  it('lets a writing guest write and never a reviewer', () => {
    expect(guestEditRefusal({ hostId: 'h', role: 'design', writes: true }, '/wt/a.css')).toBeNull();
    expect(guestEditRefusal({ hostId: 'h', role: 'review', writes: false }, '/wt/a.css')).toMatch(/a reviewer does not change files/);
    expect(sanitizeGuest({ hostId: 'h', role: 'review', writes: true })).toEqual({ hostId: 'h', role: 'review', writes: false });
    expect(sanitizeGuest({ hostId: 'h', role: 'boss' })).toBeNull();
  });

  it('allows one writer in a worktree at a time', () => {
    expect(writerRefusal(null, 1)).toBeNull();
    expect(writerRefusal(null, 2)).toMatch(/One session writes in a worktree at a time/);
    expect(writerRefusal({ title: 'Inputs', role: 'design' }, 1)).toBe('"Inputs" is doing the Design part in this worktree now, and one session writes here at a time. Start the next part after it hands back.');
    expect(writerRefusal({ title: 'Inputs', role: 'design' }, 0)).toBeNull(); // a reviewer may read meanwhile
  });

  it('routes what is left after a design: to Build when the user gave Build to someone, else to the host', () => {
    const guest = { title: 'Inputs', id: 'g1', role: 'design' as const, runner: 'Astra (Codex · gpt-6.2-astra · High)' };
    expect(handBackText(guest, 'Built TextInput.', null, 'your delegate tool')).toContain('carry on with it yourself now, from what was made');
    expect(handBackText(guest, 'Built TextInput.', '"Deep" (Claude · opus)', 'your delegate tool')).toContain('the user has given Build work to "Deep" (Claude · opus): call your delegate tool with a task for what is left, role "build"');
    expect(handBackText(guest, 'Built TextInput.', null, 'x')).toContain('Its last message: Built TextInput.');
  });

  it('reads the reviewer’s verdict, and says how a review ended', () => {
    expect(verdictOf('1. a bug\n\nVERDICT: FIX FIRST')).toBe('findings');
    expect(verdictOf('All good.\nVERDICT: NOTHING TO FIX')).toBe('clean');
    expect(verdictOf('no verdict line at all')).toBe('findings');
    expect(findingsText({ reviewer: 'Critic', round: 1, rounds: 2 }, '1. a bug')).toContain('Critic looks again (round 2 of 2)');
    expect(findingsText({ reviewer: 'Critic', round: 2, rounds: 2 }, '1. a bug')).toContain('This was the last round');
    expect(reviewEndNotice({ reviewer: 'Critic', round: 1, verdict: 'clean' })).toBe('Critic reviewed this work (1 round) and found nothing that must change before it is merged.');
    expect(reviewEndNotice({ reviewer: 'Critic', round: 2, verdict: 'findings' })).toMatch(/still has findings. They are a warning, not a block/);
    expect(reviewForRequest({ reviewerId: 'r', reviewer: 'Critic', round: 2, rounds: 2, status: 'done', verdict: 'findings', summary: '1. a bug' })).toBe('Reviewed by Critic before opening. Open findings from its last round:\n\n1. a bug');
    expect(reviewForRequest({ reviewerId: 'r', reviewer: 'Critic', round: 1, rounds: 2, status: 'reviewing' })).toBe('');
  });
});

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const claude = new FakeAgents();
  const codex = new FakeAgents();
  /** Comments Kestrel posted to a pull request: [request number, host, text]. */
  const posted: [number, string, string][] = [];
  const runtime = new SessionRuntime(workspace, { claude: claude.adapter(), codex: codex.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-guests-'))), { requestComment: async (_cwd, number, body, host) => void posted.push([number, host, body]) });
  const project = await runtime.registerProject(makeRepo(), 'app');
  await runtime.whoDoesWhat.set(who);
  const sessions = async () => (await workspace.state()).sessions;
  const notices = (id: string) => runtime.overlay(id)?.messages.filter((m) => m.notice).map((m) => m.text) ?? [];
  const edit = (turn: Turn, file: string) => turn.options.intercept!({ tool: 'Edit', input: { file_path: join(turn.options.directory, file) } });
  const cards = (id: string) => runtime.overlay(id)?.messages.flatMap((m) => (m.suggestion ? [m.suggestion] : [])) ?? [];
  return { workspace, claude, codex, runtime, project, sessions, notices, edit, posted, cards };
}

describe('a design part in the asking session’s worktree', () => {
  it('runs the role’s agent there, lets it write while the host may not, and hands back with what is left', async () => {
    const { claude, codex, runtime, project, sessions, edit } = await world();
    const seen: Record<string, unknown> = {};
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    codex.script = async (turn) => {
      seen.guestDirectory = turn.options.directory;
      seen.guestPrompt = turn.text;
      seen.guestEdit = await edit(turn, 'TextInput.css');
      await held; // the design part is still at work
      turn.emit({ type: 'message', id: 'm1', text: 'Built the TextInput component in ui/TextInput.css.', delta: '', done: true });
    };
    claude.script = async (turn) => {
      if (turn.text === 'Fix the inputs') {
        seen.delegated = await turn.options.tools.delegate({ tasks: [{ project: 'app', brief: 'Restyle the text inputs', role: 'design' }] });
        await until(() => codex.turns.length === 1 && seen.guestEdit !== undefined, 'the design session to be at work');
        seen.hostEdit = await edit(turn, 'App.tsx');
        seen.second = await turn.options.tools.delegate({ tasks: [{ project: 'app', brief: 'Wire it in', role: 'build' }] });
        release();
      } else seen.handBack = turn.text;
    };
    const host = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Fix the inputs', permission: 'auto' });
    await until(() => seen.handBack !== undefined, 'the hand-back');
    const all = await sessions();
    const hostRow = all.find((s) => s.id === host.id)!;
    const guest = all.find((s) => s.id !== host.id && s.agent === 'codex')!;

    expect(seen.guestDirectory).toBe(hostRow.worktreePath); // no worktree of its own
    expect(guest.worktreePath).toBeNull();
    expect(codex.starts[0]!.options).toMatchObject({ model: 'gpt-6.2-astra', effort: 'high' });
    expect(seen.guestPrompt).toMatch(/^You are doing the Design part of the task of the session "Fix the inputs", in its worktree, while it waits/);
    expect(seen.guestPrompt).toMatch(/Restyle the text inputs$/);
    expect((seen.delegated as { text: string }).text).toContain('One of them is working in THIS worktree: change no file here until it hands back');
    expect(seen.guestEdit).toEqual({ allow: true });
    expect(seen.hostEdit).toMatchObject({ allow: false, message: expect.stringContaining('is doing the Design part in this worktree now, and one session writes here at a time') });
    expect((seen.second as { text: string }).text).toContain('is doing the Design part in this worktree now');
    expect(seen.handBack).toContain('[Kestrel] Astra (Codex · gpt-6.2-astra · High) finished the Design part');
    expect(seen.handBack).toContain('Its last message: Built the TextInput component in ui/TextInput.css.');
    expect(seen.handBack).toContain('carry on with it yourself now, from what was made');
  });

  it('gives a role’s task for another project its own worktree, as before', async () => {
    const { claude, codex, runtime, project, sessions } = await world();
    const other = await runtime.registerProject(makeRepo(), 'site');
    let done = false;
    claude.script = async (turn) => {
      if (turn.text === 'go') done = Boolean(await turn.options.tools.delegate({ tasks: [{ project: 'site', brief: 'Restyle', role: 'design' }] }));
    };
    await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'go', permission: 'auto' });
    await until(() => done && codex.starts.length === 1, 'the design session');
    const guest = (await sessions()).find((s) => s.agent === 'codex')!;
    await until(async () => (await sessions()).find((s) => s.id === guest.id)!.worktreePath !== null, 'its worktree');
    expect(guest.startedIn).toBe(other.id);
  });
});

describe('a review of a session’s work', () => {
  it('reads in the author’s worktree, sends its findings as a turn, looks again, and ends with a warning', async () => {
    const { claude, codex, runtime, project, sessions, notices, edit } = await world();
    const reviewer: { directory?: string; edit?: unknown; texts: string[] } = { texts: [] };
    codex.script = async (turn) => {
      reviewer.texts.push(turn.text);
      reviewer.directory = turn.options.directory;
      reviewer.edit ??= await edit(turn, 'App.tsx');
      turn.emit({ type: 'message', id: `r${turn.n}`, text: `1. app.ts:3 still divides by zero (look ${turn.n}).\n\nVERDICT: FIX FIRST`, delta: '', done: true });
    };
    const author: string[] = [];
    claude.script = (turn) => {
      author.push(turn.text);
      if (turn.n > 1) turn.emit({ type: 'message', id: `a${turn.n}`, text: 'Guarded the division.', delta: '', done: true });
    };
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the average', permission: 'auto' });
    await runtime.idle(session.id);

    const started = await runtime.delegation.startReview(session.id);
    expect(started).toMatchObject({ reviewer: 'Critic (Codex · gpt-6.2)', round: 1, rounds: 2, status: 'reviewing' });
    await expect(runtime.delegation.startReview(session.id)).rejects.toThrow('Critic (Codex · gpt-6.2) is already reviewing this work.');
    await until(() => runtime.delegation.reviewOf(session.id)?.status === 'done', 'the review to end');

    const worktree = (await sessions()).find((s) => s.id === session.id)!.worktreePath;
    expect(reviewer.directory).toBe(worktree);
    expect(reviewer.edit).toMatchObject({ allow: false, message: expect.stringContaining('a reviewer does not change files') });
    expect(reviewer.texts[0]).toMatch(/^You are reviewing the work of the session "Add the average"/);
    expect(reviewer.texts[0]).toContain('VERDICT: FIX FIRST');
    expect(codex.starts[0]!.options.permission).toBe('auto');
    // Round 1's findings were the author's next turn; its answer went back for round 2.
    expect(author[1]).toContain('Critic (Codex · gpt-6.2) reviewed your work (round 1 of 2) and found things to fix. Its findings: 1. app.ts:3 still divides by zero (look 1).');
    expect(reviewer.texts[1]).toContain('The author acted on your findings. It says: Guarded the division.');
    expect(reviewer.texts[1]).toContain('Look again (round 2 of 2)');
    expect(author).toHaveLength(2); // the last round's findings are the user's to weigh, not another turn
    expect(runtime.delegation.reviewOf(session.id)).toMatchObject({ round: 2, status: 'done', verdict: 'findings', summary: expect.stringContaining('look 2') });
    expect(notices(session.id).at(-1)).toMatch(/reviewed this work \(2 rounds\) and still has findings. They are a warning, not a block/);
  });

  it('ends after one round when there is nothing to fix', async () => {
    const { codex, runtime, project, notices } = await world();
    codex.script = (turn) => turn.emit({ type: 'message', id: 'r1', text: 'Checked the change and its tests.\nVERDICT: NOTHING TO FIX', delta: '', done: true });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the average', permission: 'auto' });
    await runtime.idle(session.id);
    await runtime.delegation.startReview(session.id);
    await until(() => runtime.delegation.reviewOf(session.id)?.status === 'done', 'the review to end');
    expect(runtime.delegation.reviewOf(session.id)).toMatchObject({ round: 1, verdict: 'clean' });
    expect(notices(session.id).at(-1)).toBe('Critic (Codex · gpt-6.2) reviewed this work (1 round) and found nothing that must change before it is merged.');
  });

  it('is refused, with what to do, when nobody is set to review or the session is still working', async () => {
    const { claude, runtime, project } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the average', permission: 'auto' });
    await runtime.idle(session.id);
    await runtime.whoDoesWhat.set({ ...who, roles: { ...who.roles, review: null } });
    await expect(runtime.delegation.startReview(session.id)).rejects.toThrow('No agent is set to review. Choose one in Settings → Models & roles → Who does what.');
    await runtime.whoDoesWhat.set(who);
    claude.hold = true;
    await runtime.reply(session.id, 'carry on');
    await expect(runtime.delegation.startReview(session.id)).rejects.toThrow(/is still working. Ask for the review when it has finished/);
  });
});

describe('a role started by hand', () => {
  it('runs the typed brief on the role’s agent in this session’s worktree, with no card', async () => {
    const { codex, runtime, project, sessions } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the settings page', permission: 'ask' });
    await runtime.idle(session.id);
    const child = await runtime.delegation.startRole(session.id, 'design', '  Make the form look right  ');
    await until(() => codex.turns.length === 1, 'the design session');
    const worktree = (await sessions()).find((s) => s.id === session.id)!.worktreePath;
    expect(codex.turns[0]!.options.directory).toBe(worktree);
    expect(codex.turns[0]!.text).toMatch(/^You are doing the Design part of the task of the session "Add the settings page"[\s\S]*Make the form look right$/);
    expect(child.agent).toBe('codex');
    expect(runtime.recordOf(child.id)?.guest).toEqual({ hostId: session.id, role: 'design', writes: true });
  });

  it('is refused, with why, for a role with no agent, an empty brief, a review, and a session still working', async () => {
    const { claude, runtime, project } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the settings page', permission: 'auto' });
    await runtime.idle(session.id);
    await expect(runtime.delegation.startRole(session.id, 'build', 'Wire it in')).rejects.toThrow('No agent is set for Build. Choose one in Settings → Models & roles → Who does what.');
    await expect(runtime.delegation.startRole(session.id, 'design', '  ')).rejects.toThrow('Say what the Design part is first.');
    await expect(runtime.delegation.startRole(session.id, 'review', 'Look')).rejects.toThrow('A review is started from the Create pull request form.');
    claude.hold = true;
    await runtime.reply(session.id, 'carry on');
    await expect(runtime.delegation.startRole(session.id, 'design', 'Restyle')).rejects.toThrow(/is still working, and one session writes in a worktree at a time/);
  });
});

describe('a pull request the agent opened itself', () => {
  const link = { host: 'github' as const, number: 12, url: 'https://example.test/pr/12', branch: 'b', state: 'open' as const };

  it('offers a review once, and a started one is posted to the pull request when it ends', async () => {
    const { workspace, codex, runtime, project, cards, posted, notices } = await world();
    codex.script = (turn) => turn.emit({ type: 'message', id: 'r1', text: 'Read it all.\nVERDICT: NOTHING TO FIX', delta: '', done: true });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the average', permission: 'auto' });
    await runtime.idle(session.id);
    await workspace.recordRequests(session.id, [link]);
    await until(() => cards(session.id).length === 1, 'the offer');
    const card = cards(session.id)[0]!;
    expect(card).toMatchObject({ kind: 'review', title: 'Have Critic (Codex · gpt-6.2) review this pull request?', state: 'open' });
    expect(card.buttons.map((b) => b.label)).toEqual(['Start review', 'Not now', "Don't ask again"]);
    // Seen again by a later lookup: not offered twice.
    await workspace.recordRequests(session.id, [link]);
    expect(cards(session.id)).toHaveLength(1);

    await runtime.suggestions.answer(session.id, card.id, 'start');
    await until(() => runtime.delegation.reviewOf(session.id)?.status === 'done', 'the review to end');
    expect(posted).toEqual([[12, 'github', '**Review by Critic (Codex · gpt-6.2)** (1 round, run in Kestrel): nothing that must change before this is merged.']]);
    expect(notices(session.id).at(-1)).toMatch(/found nothing that must change before it is merged\. Posted to #12\.$/);
  });

  it('offers nothing for a request the form made, when nobody reviews, or after "Don’t ask again"', async () => {
    const { workspace, runtime, project, cards } = await world();
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the average', permission: 'auto' });
    await runtime.idle(session.id);
    runtime.noteFormRequest(session.id);
    await workspace.recordRequests(session.id, [link]);
    await runtime.idle(session.id);
    expect(cards(session.id)).toEqual([]);

    await workspace.recordRequests(session.id, [{ ...link, number: 13 }]);
    await until(() => cards(session.id).length === 1, 'the offer');
    await runtime.suggestions.answer(session.id, cards(session.id)[0]!.id, 'never');
    expect((await runtime.whoDoesWhat.current()).reviewOffer).toBe(false);
    await workspace.recordRequests(session.id, [{ ...link, number: 14 }]);
    await runtime.idle(session.id);
    expect(cards(session.id).filter((c) => c.state === 'open')).toEqual([]);
  });

  it('says so when the reviewer runs on the author’s own agent, and still reviews', async () => {
    const { runtime, project, notices } = await world();
    await runtime.whoDoesWhat.set({ ...who, presets: [...who.presets, { id: 'same', name: 'Second look', agent: 'claude', model: 'opus', effort: '', fast: false }], roles: { ...who.roles, review: 'same' } });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the average', permission: 'auto' });
    await runtime.idle(session.id);
    await runtime.delegation.startReview(session.id);
    expect(notices(session.id).at(-1)).toContain('Second look (Claude · opus) runs on Claude, the same agent as this session. For a second opinion from another provider');
  });
});

describe('whoever wrote the code does not review it', () => {
  const astra = who.presets[0]!; // Codex · gpt-6.2-astra
  const critic = who.presets[1]!; // Codex · gpt-6.2
  const opus = { id: 'opus', name: 'Deep', agent: 'claude' as const, model: 'opus', effort: '', fast: false };

  it('picks the first reviewer on another agent, else on another model, else nobody', () => {
    expect(pickReviewer([astra, opus], [{ agent: 'codex', model: 'gpt-6.2-astra' }])).toBe(opus);
    expect(pickReviewer([astra, opus], [{ agent: 'claude', model: 'opus' }])).toBe(astra);
    // Claude asked and Astra did the design part: neither reviews; another Codex model may.
    expect(pickReviewer([astra, critic], [{ agent: 'claude', model: '' }, { agent: 'codex', model: 'gpt-6.2-astra' }])).toBe(critic);
    expect(pickReviewer([astra], [{ agent: 'codex', model: 'gpt-6.2-astra' }])).toBeNull();
    expect(pickReviewer([], [{ agent: 'claude', model: '' }])).toBeNull();
  });

  it('says why nobody can, and what to add', () => {
    expect(noReviewerReason([astra], [{ agent: 'codex', model: 'gpt-6.2-astra' }])).toBe('This work was written by Codex (gpt-6.2-astra), and the only reviewer set, "Astra", is the same. Whoever wrote the code does not review it: add another reviewer, on a different agent or model, in Settings → Models & roles → Who does what.');
    expect(noReviewerReason([], [])).toBe('No agent is set to review. Choose one in Settings → Models & roles → Who does what.');
  });

  it('keeps the reviewers in the user’s order, and reads an older record’s single reviewer', () => {
    const several = cleanWhoDoesWhat({ ...who, presets: [...who.presets, opus], reviewers: ['opus', 'astra', 'gone', 'opus'] }, () => 'x');
    expect(several.reviewers).toEqual(['opus', 'astra']);
    expect(several.roles.review).toBe('opus');
    expect(reviewersOf(several).map((p) => p.name)).toEqual(['Deep', 'Astra']);
    expect(cleanWhoDoesWhat(who, () => 'x').reviewers).toEqual(['critic']);
    expect(reviewersOf({ ...several, modes: { design: 'auto', build: 'auto', review: 'off' } })).toEqual([]);
  });

  it('sends a Codex session’s work to the Claude reviewer, and a Claude session’s to the Codex one', async () => {
    const { runtime, project } = await world();
    await runtime.whoDoesWhat.set({ ...who, presets: [...who.presets, opus], reviewers: ['astra', 'opus'] });
    const byCodex = await runtime.start({ agent: 'codex', projectId: project.id, prompt: 'Build the page', model: 'gpt-6.2-astra', permission: 'auto' });
    await runtime.idle(byCodex.id);
    expect((await runtime.delegation.reviewerFor(byCodex.id)).reviewer?.name).toBe('Deep');
    const byClaude = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Build the page', permission: 'auto' });
    await runtime.idle(byClaude.id);
    expect((await runtime.delegation.reviewerFor(byClaude.id)).reviewer?.name).toBe('Astra');
    expect((await runtime.delegation.startReview(byCodex.id)).reviewer).toBe('Deep (Claude · opus)');
  });

  it('counts a design part done in the worktree as written by its agent, and refuses when every reviewer wrote some', async () => {
    const { codex, runtime, project } = await world();
    await runtime.whoDoesWhat.set({ ...who, reviewers: ['astra'] });
    const session = await runtime.start({ agent: 'claude', projectId: project.id, prompt: 'Add the settings page', permission: 'auto' });
    await runtime.idle(session.id);
    expect((await runtime.delegation.reviewerFor(session.id)).reviewer?.name).toBe('Astra'); // Claude wrote it all so far
    await runtime.delegation.startRole(session.id, 'design', 'Make the form look right');
    await until(() => codex.turns.length === 1, 'the design part');
    await runtime.idle(session.id);
    const answer = await runtime.delegation.reviewerFor(session.id);
    expect(answer.reviewer).toBeNull();
    expect(answer.reason).toContain('This work was written by Claude and Codex (gpt-6.2-astra), and the only reviewer set, "Astra", is the same.');
    await expect(runtime.delegation.startReview(session.id)).rejects.toThrow(/Whoever wrote the code does not review it/);
    // With a second reviewer on another model, that one is used.
    await runtime.whoDoesWhat.set({ ...who, reviewers: ['astra', 'critic'] });
    expect((await runtime.delegation.reviewerFor(session.id)).reviewer?.name).toBe('Critic');
  });
});

