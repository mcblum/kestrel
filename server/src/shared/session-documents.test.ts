// The documents inside a session: opening and closing tabs, and the New PR form's rules (one form,
// typed text never thrown away, late answers ignored, created → the pull request's page).
import { describe, expect, it } from 'vitest';
import { hostTerms } from './host-terms.ts';
import {
  CREATE_PR_MENU,
  INITIAL_DOCUMENTS,
  NEW_PR_ID,
  canCreate,
  chooseNewPullRequest,
  closeDocument,
  confirmCreate,
  leaveConfirmCreate,
  mayRegenerate,
  pressCreate,
  regenerateNewPullRequest,
  editNewPullRequest,
  inheritedNote,
  newPullRequestCreated,
  newPullRequestCreating,
  newPullRequestFailed,
  newPullRequestOf,
  newPullRequestModeOf,
  newPullRequestPrepared,
  offersCreatePullRequest,
  requestButton,
  openDocument,
  pullRequestNumberOf,
  documentTitle,
  type SessionDocument,
  type SessionDocuments,
} from './session-documents.ts';

const pr: SessionDocument = { id: 'pr-307', kind: 'pull-request', number: 307, title: 'PR #307' };
const prefill = { title: 'Make search instant', body: '## Summary\n\n- Cache', base: 'main' };
const form = (state: SessionDocuments) => newPullRequestOf(state)!.form;

describe('documents within a session', () => {
  it('starts with only the conversation', () => {
    expect(INITIAL_DOCUMENTS.tabs.map((t) => t.id)).toEqual(['conversation']);
  });
  it('opens and reselects a document without duplicate tabs', () => {
    const opened = openDocument(INITIAL_DOCUMENTS, pr);
    const again = openDocument(opened, pr);
    expect(again.tabs).toHaveLength(2);
    expect(again.activeId).toBe('pr-307');
  });
  it('returns to the previous tab when closing the active document', () => {
    expect(closeDocument(openDocument(INITIAL_DOCUMENTS, pr), pr.id)).toEqual(INITIAL_DOCUMENTS);
  });
  it('keeps the active tab when closing another document and protects Conversation', () => {
    const opened = openDocument(openDocument(INITIAL_DOCUMENTS, pr), { ...pr, id: 'pr-308', number: 308 });
    expect(closeDocument(opened, 'pr-307').activeId).toBe('pr-308');
    expect(closeDocument(opened, 'conversation')).toBe(opened);
  });
});

describe('the New PR form', () => {
  it('opens next to Conversation, selected, blank and waiting for its pre-fill', () => {
    const { state, prepare } = chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 1);
    expect(prepare).toBe(true);
    expect(state.tabs.map((t) => t.id)).toEqual(['conversation', NEW_PR_ID]);
    expect(state.activeId).toBe(NEW_PR_ID);
    expect(newPullRequestOf(state)).toMatchObject({ title: 'New PR', mode: 'generated', phase: 'preparing', touched: false, form: { title: '', body: '', base: '', draft: false } });
    expect(canCreate(newPullRequestOf(state)!)).toBe(false);
    expect(INITIAL_DOCUMENTS.tabs).toHaveLength(1);
  });

  it('fills in the pre-fill, and ignores an answer to an older request', () => {
    const { state } = chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 2);
    expect(newPullRequestPrepared(state, 1, { prefill })).toBe(state);
    const ready = newPullRequestPrepared(state, 2, { prefill });
    expect(form(ready)).toEqual({ ...prefill, draft: false });
    expect(newPullRequestOf(ready)!.phase).toBe('editing');
    expect(canCreate(newPullRequestOf(ready)!)).toBe(true);
  });

  it('keeps how many inherited commits the server counted (0 when it did not say)', () => {
    const { state } = chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1);
    expect(newPullRequestOf(newPullRequestPrepared(state, 1, { prefill, inherited: 3 }))!.inherited).toBe(3);
    expect(newPullRequestOf(newPullRequestPrepared(state, 1, { prefill }))!.inherited).toBe(0);
  });

  it('notes inherited commits only when there are some, singular or plural', () => {
    expect(inheritedNote(undefined)).toBeNull();
    expect(inheritedNote(0)).toBeNull();
    expect(inheritedNote(1)).toBe('Also carries 1 earlier commit from the branch this session started on.');
    expect(inheritedNote(4)).toBe('Also carries 4 earlier commits from the branch this session started on.');
  });

  it('keeps what was typed while the base was being looked up (manual)', () => {
    const { state } = chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1);
    const typed = editNewPullRequest(state, { title: 'Mine', base: 'develop' });
    expect(form(newPullRequestPrepared(typed, 1, { prefill: { title: '', body: '', base: 'main' } }))).toEqual({ title: 'Mine', body: '', base: 'develop', draft: false });
  });

  it('says why preparing failed and leaves the form open to fill in by hand', () => {
    const { state } = chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 1);
    const failed = newPullRequestPrepared(state, 1, { error: 'gh is not signed in' });
    expect(newPullRequestOf(failed)).toMatchObject({ phase: 'editing', error: 'gh is not signed in', form: { base: '' } });
    expect(canCreate(newPullRequestOf(failed)!)).toBe(true);
  });

  it('only selects an open form when the same mode is chosen again', () => {
    const opened = newPullRequestPrepared(chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1).state, 1, { prefill: { title: '', body: '', base: 'main' } });
    const away = { ...opened, activeId: 'conversation' };
    const again = chooseNewPullRequest(away, 'manual', 2);
    expect(again.prepare).toBe(false);
    expect(again.state.activeId).toBe(NEW_PR_ID);
    expect(again.state.tabs).toBe(away.tabs);
  });

  it('asks again in the new mode when the form is untouched, keeping the base', () => {
    const opened = newPullRequestPrepared(chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1).state, 1, { prefill: { title: '', body: '', base: 'main' } });
    const switched = chooseNewPullRequest(opened, 'generated', 2);
    expect(switched.prepare).toBe(true);
    expect(newPullRequestOf(switched.state)).toMatchObject({ mode: 'generated', phase: 'preparing', request: 2, form: { title: '', body: '', base: 'main' } });
    expect(switched.state.tabs.filter((t) => t.kind === 'new-pull-request')).toHaveLength(1);
  });

  it('never throws away typed text when the other mode is chosen', () => {
    const opened = chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1).state;
    const typed = editNewPullRequest(opened, { body: 'Half a description' });
    const chosen = chooseNewPullRequest(typed, 'generated', 2);
    expect(chosen.prepare).toBe(false);
    expect(newPullRequestOf(chosen.state)).toMatchObject({ mode: 'manual', touched: true, form: { body: 'Half a description' } });
  });

  it('keeps the text when creating fails, and waits while creating', () => {
    const ready = editNewPullRequest(newPullRequestPrepared(chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 1).state, 1, { prefill }), { draft: true });
    const creating = newPullRequestCreating(ready);
    expect(newPullRequestOf(creating)).toMatchObject({ phase: 'creating', error: null });
    expect(canCreate(newPullRequestOf(creating)!)).toBe(false);
    expect(chooseNewPullRequest(creating, 'manual', 2).prepare).toBe(false);
    const failed = newPullRequestFailed(creating, 'Enter a valid base branch.');
    expect(newPullRequestOf(failed)).toMatchObject({ phase: 'editing', error: 'Enter a valid base branch.', form: { ...prefill, draft: true } });
  });

  it('closes the form and opens the new pull request when it is created', () => {
    const creating = newPullRequestCreating(newPullRequestPrepared(chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 1).state, 1, { prefill }));
    const created = newPullRequestCreated(creating, 512);
    expect(created.tabs.map((t) => t.id)).toEqual(['conversation', 'pr-512']);
    expect(created.activeId).toBe('pr-512');
  });

  it('closes with Cancel like any other document; edits to a closed form change nothing', () => {
    const { state } = chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1);
    const closed = closeDocument(state, NEW_PR_ID);
    expect(closed.tabs.map((t) => t.id)).toEqual(['conversation']);
    expect(editNewPullRequest(closed, { title: 'x' })).toBe(closed);
    expect(newPullRequestPrepared(closed, 1, { prefill })).toBe(closed);
  });
});

describe('pullRequestNumberOf', () => {
  it('reads the number at the end of a pull request address', () => {
    expect(pullRequestNumberOf('https://github.com/o/r/pull/412')).toBe(412);
    expect(pullRequestNumberOf('https://github.com/o/r/pull/412/files')).toBe(412);
    expect(pullRequestNumberOf(' https://github.com/o/r/pull/7\n')).toBe(7);
    expect(pullRequestNumberOf('https://github.com/o/r/issues/412')).toBeNull();
    expect(pullRequestNumberOf('https://starfish.example.io/group/sub/r/-/merge_requests/12')).toBe(12);
    expect(pullRequestNumberOf('https://gitlab.com/o/r/-/merge_requests/12/diffs')).toBe(12);
    expect(pullRequestNumberOf('https://gitlab.com/o/r/-/issues/12')).toBeNull();
    expect(pullRequestNumberOf('')).toBeNull();
  });
});

describe('the Create PR button and its menu', () => {
  it('is offered for a branch whose lookup found no open or draft pull request', () => {
    expect(offersCreatePullRequest(true, { state: 'ready', value: { pullRequests: [] } })).toBe(true);
    expect(offersCreatePullRequest(true, { state: 'ready', value: { pullRequests: [{ state: 'merged' }, { state: 'closed' }] } })).toBe(true);
    expect(offersCreatePullRequest(true, { state: 'ready', value: { pullRequests: [{ state: 'merged' }, { state: 'draft' }] } })).toBe(false);
    expect(offersCreatePullRequest(true, { state: 'ready', value: { pullRequests: [{ state: 'open' }] } })).toBe(false);
    expect(offersCreatePullRequest(true, { state: 'loading' })).toBe(false);
    expect(offersCreatePullRequest(true, { state: 'unavailable' })).toBe(false);
    expect(offersCreatePullRequest(false, { state: 'ready', value: { pullRequests: [] } })).toBe(false);
  });
  it('does not offer it for a session that has changed nothing: no commit beyond its base and no uncommitted file', () => {
    const none = { state: 'ready', value: { pullRequests: [] } };
    const git = (ahead: number, uncommitted: number) => ({ state: 'ready', value: { head: 'abc', ahead, uncommitted } });
    expect(offersCreatePullRequest(true, none, git(0, 0))).toBe(false);
    expect(offersCreatePullRequest(true, none, git(1, 0))).toBe(true); // a commit to make a request from
    expect(offersCreatePullRequest(true, none, git(0, 2))).toBe(true); // uncommitted work, which Create PR asks the agent to commit
    // Not known yet, or a server that does not say how far ahead the branch is: keep offering.
    expect(offersCreatePullRequest(true, none, { state: 'loading' })).toBe(true);
    expect(offersCreatePullRequest(true, none, { state: 'ready', value: { head: 'abc', uncommitted: 0 } })).toBe(true);
    expect(offersCreatePullRequest(true, none)).toBe(true);
  });

  it('does not offer it after a merge when the branch has nothing since', () => {
    const merged = { state: 'ready', value: { pullRequests: [{ state: 'closed', number: 3, headSha: 'old' }, { state: 'merged', number: 7, headSha: 'abc' }] } };
    const branch = (head: string, uncommitted = 0) => ({ state: 'ready', value: { head, uncommitted } });
    expect(offersCreatePullRequest(true, merged, branch('abc'))).toBe(false);
    expect(offersCreatePullRequest(true, merged, branch('def'))).toBe(true); // a commit since the merge
    expect(offersCreatePullRequest(true, merged, branch('abc', 1))).toBe(true); // uncommitted work since
    expect(offersCreatePullRequest(true, merged, { state: 'loading' })).toBe(true); // not known: keep offering
    expect(offersCreatePullRequest(true, merged)).toBe(true);
    expect(offersCreatePullRequest(true, { state: 'ready', value: { pullRequests: [{ state: 'merged', number: 7 }] } }, branch('abc'))).toBe(true); // host gave no commit
  });
  it('has Manually then Generated, each naming its mode', () => {
    expect(CREATE_PR_MENU.map((i) => i.label)).toEqual(['Manually', 'Generated']);
    expect(newPullRequestModeOf('generated')).toBe('generated');
    expect(newPullRequestModeOf('copy-text')).toBeNull();
  });
});

describe('tab names', () => {
  it('follow the host: PR #307 and New PR on GitHub, MR !307 and New MR on GitLab', () => {
    const newPr = newPullRequestOf(chooseNewPullRequest(INITIAL_DOCUMENTS, 'manual', 1).state)!;
    expect(documentTitle(pr, hostTerms('github'))).toBe('PR #307');
    expect(documentTitle(pr, hostTerms('gitlab'))).toBe('MR !307');
    expect(documentTitle(newPr, hostTerms('github'))).toBe('New PR');
    expect(documentTitle(newPr, hostTerms('gitlab'))).toBe('New MR');
    expect(documentTitle(INITIAL_DOCUMENTS.tabs[0]!, hostTerms('gitlab'))).toBe('Conversation');
  });
});

describe('uncommitted changes and the New PR form', () => {
  const ready = (mode: 'manual' | 'generated') => newPullRequestPrepared(chooseNewPullRequest(INITIAL_DOCUMENTS, mode, 1).state, 1, { prefill });
  it('asks first when Create is pressed with uncommitted changes, creates at once without', () => {
    const doc = newPullRequestOf(ready('generated'))!;
    expect(pressCreate(doc, true)).toBe('confirm');
    expect(pressCreate(doc, false)).toBe('create');
    expect(pressCreate(newPullRequestOf(chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 1).state)!, true)).toBe('none');
  });
  it('turns the button row into the question, and back', () => {
    const asking = confirmCreate(ready('generated'));
    expect(newPullRequestOf(asking)!.confirming).toBe(true);
    expect(confirmCreate(asking)).toBe(asking);
    const back = leaveConfirmCreate(asking);
    expect(newPullRequestOf(back)!.confirming).toBe(false);
    expect(leaveConfirmCreate(back)).toBe(back);
  });
  it('never asks while the form is being prepared, and creating ends the question', () => {
    const preparing = chooseNewPullRequest(INITIAL_DOCUMENTS, 'generated', 1).state;
    expect(confirmCreate(preparing)).toBe(preparing);
    expect(newPullRequestOf(newPullRequestCreating(confirmCreate(ready('generated'))))!.confirming).toBe(false);
  });
  it('may regenerate a Generated form whose title and description were not typed in', () => {
    expect(mayRegenerate(newPullRequestOf(ready('generated')))).toBe(true);
    expect(mayRegenerate(newPullRequestOf(ready('manual')))).toBe(false);
    expect(mayRegenerate(newPullRequestOf(editNewPullRequest(ready('generated'), { body: 'mine' })))).toBe(false);
    expect(mayRegenerate(newPullRequestOf(editNewPullRequest(ready('generated'), { draft: true })))).toBe(true);
    expect(mayRegenerate(undefined)).toBe(false);
  });
  it('keeps the typed-in mark once set, whatever is edited after', () => {
    const typed = editNewPullRequest(editNewPullRequest(ready('generated'), { title: 'Mine' }), { base: 'dev' });
    expect(newPullRequestOf(typed)!.textTouched).toBe(true);
  });
  it('regenerates keeping the base and draft box, and leaves typed text alone', () => {
    const drafted = editNewPullRequest(ready('generated'), { draft: true, base: 'dev' });
    const { state, prepare } = regenerateNewPullRequest(drafted, 2);
    expect(prepare).toBe(true);
    expect(newPullRequestOf(state)).toMatchObject({ phase: 'preparing', request: 2, form: { title: '', body: '', base: 'dev', draft: true } });
    const again = newPullRequestPrepared(state, 2, { prefill: { ...prefill, title: 'Now with the commit' } });
    expect(form(again)).toMatchObject({ title: 'Now with the commit', base: 'dev', draft: true });
    const typed = editNewPullRequest(ready('generated'), { title: 'Mine' });
    expect(regenerateNewPullRequest(typed, 3)).toEqual({ state: typed, prepare: false });
  });

  it('a review session never offers Create: its button opens the request under review on its host', () => {
    const none = { state: 'ready', value: { pullRequests: [] } };
    const ahead = { state: 'ready', value: { head: 'abc', ahead: 2, uncommitted: 0 } };
    const review = { host: 'github' as const, number: 7, url: 'https://github.com/acme/app/pull/7' };
    // The same branch, ahead of its base with no request of its own: Create for a session of the user's work.
    expect(requestButton({ branch: 'matt/fix' }, none, ahead)).toEqual({ kind: 'create' });
    expect(requestButton({ branch: 'kestrel-review/fix', review }, none, ahead)).toEqual({ kind: 'view', url: review.url, label: 'View PR #7', title: 'Open this pull request on GitHub' });
    expect(requestButton({ branch: 'kestrel-review/fix', review: { ...review, host: 'gitlab', number: 12 } }, none, ahead)).toMatchObject({ kind: 'view', label: 'View MR !12', title: 'Open this merge request on GitLab' });
    // Whatever is known of the branch, and with its worktree gone.
    expect(requestButton({ branch: null, review, worktreeDiscarded: true }, { state: 'loading' })).toMatchObject({ kind: 'view' });
    expect(requestButton({ branch: 'matt/fix', worktreeDiscarded: true }, none, ahead)).toBeNull();
    expect(requestButton({ branch: null }, none, ahead)).toBeNull();
  });
});

describe('a file in a tab', () => {
  it('opens named for the file, once per path, and closes back to where it was opened from', async () => {
    const { fileDocument } = await import('./session-documents.ts');
    const first = openDocument(INITIAL_DOCUMENTS, fileDocument('/work/out/plan.md'));
    expect(first.tabs.map((t) => documentTitle(t, hostTerms('github')))).toEqual(['Conversation', 'plan.md']);
    expect(first.activeId).toBe('file:/work/out/plan.md');

    const again = openDocument(openDocument(first, fileDocument('report.pdf')), fileDocument('/work/out/plan.md'));
    expect(again.tabs).toHaveLength(3);
    expect(again.activeId).toBe('file:/work/out/plan.md');

    expect(closeDocument(first, 'file:/work/out/plan.md')).toEqual(INITIAL_DOCUMENTS);
  });
});
