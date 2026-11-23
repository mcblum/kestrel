// The documents inside one session (Conversation, a pull request's page, the New PR form, a Markdown
// or PDF file opened from the conversation or the Files pane), as pure
// state changes. The UI keeps one of these per session (ui/src/sessionView.ts) and only calls these
// functions, so the rules are tested here. Every function returns a new value and leaves its input
// alone. The New PR draft lives here, not in a component, so it survives switching tabs and sessions,
// with how many earlier commits the request carries from the branch the session started on (and the
// form's note about them, `inheritedNote`).
// A tab's shown name follows the repository's host (`documentTitle`): "PR #12" on GitHub, "MR !12" on GitLab.
// With uncommitted changes, Create first asks in place (`pressCreate`, `confirming`), and a commit
// made from the form may re-run the generated text only where the user typed none (`mayRegenerate`).
import { hostTerms, requestLabel, type HostKind, type HostTerms } from './host-terms.ts';
import { fileNameOf } from './viewable-files.ts';

export type NewPullRequestMode = 'manual' | 'generated';

/** What the New PR form holds. */
export interface PullRequestDraft {
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

/** Where the New PR form is: asking the server for its pre-fill, being edited, or being created. */
export type NewPullRequestPhase = 'preparing' | 'editing' | 'creating';

export interface NewPullRequestDocument {
  id: typeof NEW_PR_ID;
  kind: 'new-pull-request';
  title: string;
  mode: NewPullRequestMode;
  form: PullRequestDraft;
  /** The user has typed in the form: nothing may replace their text from here on. */
  touched: boolean;
  /** The user has typed in the title or the description. Absent means no. */
  textTouched?: boolean;
  /** Create was pressed with uncommitted changes: the button row asks what to do instead. Absent means no. */
  confirming?: boolean;
  phase: NewPullRequestPhase;
  /** Why preparing or creating failed, said in the form. */
  error: string | null;
  /** Which prepare request the form is waiting for: an answer to an older one is ignored. */
  request: number;
  /** Commits the request carries from the branch the session started on; absent until the server says. */
  inherited?: number;
}

export type SessionDocument =
  | { id: 'conversation'; kind: 'conversation'; title: string }
  | NewPullRequestDocument
  | { id: string; kind: 'pull-request'; number: number; title: string }
  /** A file Kestrel shows itself (shared/viewable-files.ts): `path` as it was given, absolute or from the session's folder. */
  | { id: string; kind: 'file'; path: string; title: string };

export interface SessionDocuments {
  tabs: readonly SessionDocument[];
  activeId: string;
}

export const CONVERSATION_ID = 'conversation';
export const NEW_PR_ID = 'new-pr';
export const NEW_PR_TAB_TITLE = 'New PR';

export const INITIAL_DOCUMENTS: SessionDocuments = { tabs: [{ id: CONVERSATION_ID, kind: 'conversation', title: 'Conversation' }], activeId: CONVERSATION_ID };

export const EMPTY_DRAFT: PullRequestDraft = { title: '', body: '', base: '', draft: false };

/** Opens `document` (or replaces the tab with its id) and selects it. */
export function openDocument(state: SessionDocuments, document: SessionDocument): SessionDocuments {
  const found = state.tabs.some((t) => t.id === document.id);
  return { tabs: found ? state.tabs.map((t) => (t.id === document.id ? document : t)) : [...state.tabs, document], activeId: document.id };
}

/** Closes a tab; the one before it is selected when it was the selected one. Conversation stays. */
export function closeDocument(state: SessionDocuments, id: string): SessionDocuments {
  if (id === CONVERSATION_ID) return state;
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return state;
  return { tabs: state.tabs.filter((t) => t.id !== id), activeId: state.activeId === id ? state.tabs[Math.max(0, index - 1)]!.id : state.activeId };
}

/** The name a tab shows, in the host's words; Conversation is always Conversation. */
export function documentTitle(doc: SessionDocument, terms: HostTerms): string {
  if (doc.kind === 'pull-request') return requestLabel(terms, doc.number);
  if (doc.kind === 'new-pull-request') return `New ${terms.short}`;
  return doc.title;
}

export const pullRequestDocument = (number: number): SessionDocument => ({ id: `pr-${number}`, kind: 'pull-request', number, title: `PR #${number}` });

/** A file's tab: one per path, named for the file, so opening the same file again selects its tab. */
export const fileDocument = (path: string): SessionDocument => ({ id: `file:${path}`, kind: 'file', path, title: fileNameOf(path) });

export function newPullRequestOf(state: SessionDocuments): NewPullRequestDocument | undefined {
  return state.tabs.find((t): t is NewPullRequestDocument => t.kind === 'new-pull-request');
}

/** Replaces the New PR tab in place (keeps which tab is selected); no tab, no change. */
function withNewPullRequest(state: SessionDocuments, change: (doc: NewPullRequestDocument) => NewPullRequestDocument): SessionDocuments {
  const doc = newPullRequestOf(state);
  if (!doc) return state;
  const next = change(doc);
  return next === doc ? state : { ...state, tabs: state.tabs.map((t) => (t === doc ? next : t)) };
}

/**
 * "Manually" or "Generated" chosen from the Create PR menu. With no New PR tab, one opens, waiting
 * for its pre-fill. With one open it is selected; it is asked for again in the new mode only when
 * the user has typed nothing and the mode differs. Typed text is never thrown away. `prepare` says
 * whether the caller must ask the server (with `request` as the request's number).
 */
export function chooseNewPullRequest(state: SessionDocuments, mode: NewPullRequestMode, request: number): { state: SessionDocuments; prepare: boolean } {
  const doc = newPullRequestOf(state);
  if (!doc) {
    const fresh: NewPullRequestDocument = { id: NEW_PR_ID, kind: 'new-pull-request', title: NEW_PR_TAB_TITLE, mode, form: EMPTY_DRAFT, touched: false, phase: 'preparing', error: null, request };
    return { state: openDocument(state, fresh), prepare: true };
  }
  const selected = { ...state, activeId: doc.id };
  if (doc.touched || doc.mode === mode || doc.phase === 'creating') return { state: selected, prepare: false };
  // Untouched: the base found earlier is kept, everything else comes again in the new mode.
  const again: NewPullRequestDocument = { ...doc, mode, form: { ...EMPTY_DRAFT, base: doc.form.base }, phase: 'preparing', error: null, request };
  return { state: withNewPullRequest(selected, () => again), prepare: true };
}

/** The user typed in the form. */
export function editNewPullRequest(state: SessionDocuments, patch: Partial<PullRequestDraft>): SessionDocuments {
  const text = patch.title !== undefined || patch.body !== undefined;
  return withNewPullRequest(state, (doc) => ({ ...doc, form: { ...doc.form, ...patch }, touched: true, ...(text || doc.textTouched ? { textTouched: true } : {}) }));
}

/** Whether the generated text may be asked for again (after a commit): a Generated form, ready, whose title and description the user has not typed in. */
export const mayRegenerate = (doc: NewPullRequestDocument | undefined): boolean => doc !== undefined && doc.mode === 'generated' && doc.phase === 'editing' && doc.textTouched !== true;

/**
 * Asks for the generated text again (a commit was just made), as request `request`. Only where
 * `mayRegenerate`: the base and the draft box are kept, the title and description come again.
 * `prepare` says whether the caller must ask the server.
 */
export function regenerateNewPullRequest(state: SessionDocuments, request: number): { state: SessionDocuments; prepare: boolean } {
  if (!mayRegenerate(newPullRequestOf(state))) return { state, prepare: false };
  const next = withNewPullRequest(state, (doc) => ({ ...doc, form: { ...doc.form, title: '', body: '' }, phase: 'preparing', error: null, confirming: false, request }));
  return { state: next, prepare: true };
}

/** What pressing Create (or Cmd+Enter) does: nothing while it cannot, ask first while changes are uncommitted, else create. Pure. */
export function pressCreate(doc: NewPullRequestDocument, uncommitted: boolean): 'none' | 'confirm' | 'create' {
  if (!canCreate(doc)) return 'none';
  return uncommitted ? 'confirm' : 'create';
}

/** The button row turns into the question about uncommitted changes. */
export function confirmCreate(state: SessionDocuments): SessionDocuments {
  return withNewPullRequest(state, (doc) => (doc.confirming || doc.phase !== 'editing' ? doc : { ...doc, confirming: true }));
}

/** Back to the normal button row: Cancel, Escape, "Commit them first" or "Create without them". */
export function leaveConfirmCreate(state: SessionDocuments): SessionDocuments {
  return withNewPullRequest(state, (doc) => (doc.confirming ? { ...doc, confirming: false } : doc));
}

/**
 * The server's pre-fill for request `request`. Each field is filled only where the form is still
 * empty, so nothing typed meanwhile (the base, in manual mode) is lost. An answer to an older
 * request, or after the tab closed, changes nothing.
 */
export function newPullRequestPrepared(state: SessionDocuments, request: number, answer: { prefill: Omit<PullRequestDraft, 'draft'>; inherited?: number } | { error: string }): SessionDocuments {
  return withNewPullRequest(state, (doc) => {
    if (doc.request !== request || doc.phase !== 'preparing') return doc;
    if ('error' in answer) return { ...doc, phase: 'editing', error: answer.error };
    const fill = (current: string, offered: string) => (current === '' ? offered : current);
    const form = { ...doc.form, title: fill(doc.form.title, answer.prefill.title), body: fill(doc.form.body, answer.prefill.body), base: fill(doc.form.base, answer.prefill.base) };
    return { ...doc, form, phase: 'editing', error: null, inherited: answer.inherited ?? 0 };
  });
}

/** The form's note about commits carried from the branch the session started on; null when there are none. Pure. */
export function inheritedNote(count: number | undefined): string | null {
  if (!count || count < 1) return null;
  return `Also carries ${count} earlier ${count === 1 ? 'commit' : 'commits'} from the branch this session started on.`;
}

/** "Create pull request" pressed: the form waits, and an earlier error is cleared. */
export function newPullRequestCreating(state: SessionDocuments): SessionDocuments {
  return withNewPullRequest(state, (doc) => (doc.phase === 'creating' ? doc : { ...doc, phase: 'creating', error: null, confirming: false }));
}

/** Creating failed: the reason goes in the form and every word typed stays. */
export function newPullRequestFailed(state: SessionDocuments, error: string): SessionDocuments {
  return withNewPullRequest(state, (doc) => ({ ...doc, phase: 'editing', error }));
}

/** Created: the New PR tab closes and the new pull request's page opens in its place. */
export function newPullRequestCreated(state: SessionDocuments, number: number): SessionDocuments {
  return openDocument(closeDocument(state, NEW_PR_ID), pullRequestDocument(number));
}

/** The number at the end of a pull request's web address (GitHub `…/pull/412`, GitLab `…/-/merge_requests/12`), or null. */
export function pullRequestNumberOf(url: string): number | null {
  const match = /\/(?:pull|-\/merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url.trim());
  return match ? Number(match[1]) : null;
}

/** Whether Cmd+Enter or the button may send the form: not while it is being prepared or created. What is missing is said by the server's answer. */
export const canCreate = (doc: NewPullRequestDocument): boolean => doc.phase === 'editing';

/** The Create PR button's menu, in order: an id that is the mode, and its label. */
export const CREATE_PR_MENU: readonly { id: NewPullRequestMode; label: string }[] = [
  { id: 'manual', label: 'Manually' },
  { id: 'generated', label: 'Generated' },
];

/** The mode a Create PR menu item stands for, or null for any other id. */
export const newPullRequestModeOf = (id: string): NewPullRequestMode | null => CREATE_PR_MENU.find((item) => item.id === id)?.id ?? null;

/**
 * Whether the session bar offers Create PR: the session has a branch, its pull requests were
 * looked up, and none of them is open or a draft. A merged or closed one does not stop it, unless
 * the newest one is merged and the branch has nothing since: its tip is the commit that was merged
 * and no file is uncommitted. Then there is nothing to make a request from. The same goes for a
 * session that has changed nothing at all: no commit beyond its base and no uncommitted file
 * (Matt, 2026-11-18). While the branch's state is not known, it is offered.
 */
type RequestLookup = { state: string; value?: { pullRequests: readonly { state: string; number?: number; headSha?: string }[] } };
type BranchState = { state: string; value?: { head?: string; uncommitted: number; /** Commits beyond the base. Absent from an older server. */ ahead?: number } };

export function offersCreatePullRequest(hasBranch: boolean, lookup: RequestLookup, git?: BranchState): boolean {
  if (!hasBranch || lookup.state !== 'ready') return false;
  const requests = lookup.value?.pullRequests ?? [];
  if (requests.some((pr) => pr.state === 'open' || pr.state === 'draft')) return false;
  const newest = requests.reduce<(typeof requests)[number] | undefined>((a, b) => (a && (a.number ?? 0) >= (b.number ?? 0) ? a : b), undefined);
  const branch = git?.state === 'ready' ? git.value : undefined;
  const mergedAsIs = newest?.state === 'merged' && newest.headSha !== undefined && branch?.head === newest.headSha && branch.uncommitted === 0;
  const unchanged = branch !== undefined && branch.ahead === 0 && branch.uncommitted === 0;
  return !mergedAsIs && !unchanged;
}

/** What the session bar puts beside the pull request chip: nothing, Create, or a way to the request under review. */
export type RequestButton = { kind: 'create' } | { kind: 'view'; url: string; label: string; title: string } | null;

/**
 * The one button beside a session's pull request chip. A session reviewing somebody else's request
 * never offers Create (Matt, 2026-11-21): its branch is Kestrel's copy of their commit, which reads
 * as ahead of its base and is never pushed. It offers the request itself on its host instead
 * ("View PR #7", "View MR !12"), even after its worktree is gone. Any other session: `offersCreatePullRequest`.
 */
export function requestButton(session: { review?: { host: HostKind; number: number; url: string }; branch?: string | null; worktreeDiscarded?: boolean }, lookup: RequestLookup, git?: BranchState): RequestButton {
  if (session.review) {
    const terms = hostTerms(session.review.host);
    return { kind: 'view', url: session.review.url, label: `View ${requestLabel(terms, session.review.number)}`, title: `Open this ${terms.long} on ${terms.service}` };
  }
  return !session.worktreeDiscarded && offersCreatePullRequest(Boolean(session.branch), lookup, git) ? { kind: 'create' } : null;
}
