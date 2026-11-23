// The documents open inside each session (Conversation, pull request pages, the New PR form, files): one
// small store per session, independent of the app's session tabs. The rules are pure and live in
// @kestrel/server/session-documents; this file only keeps the state and tells React it changed.
import { useSyncExternalStore } from 'react';
import type { PullRequest } from '@kestrel/server/details';
import {
  INITIAL_DOCUMENTS,
  chooseNewPullRequest,
  closeDocument,
  confirmCreate,
  editNewPullRequest,
  fileDocument,
  leaveConfirmCreate,
  newPullRequestCreated,
  newPullRequestCreating,
  newPullRequestFailed,
  newPullRequestOf,
  newPullRequestPrepared,
  openDocument,
  pullRequestDocument,
  regenerateNewPullRequest,
  type NewPullRequestDocument,
  type NewPullRequestMode,
  type PullRequestDraft,
  type SessionDocuments,
} from '@kestrel/server/session-documents';

export type { SessionDocument, SessionDocuments } from '@kestrel/server/session-documents';

let views = new Map<string, SessionDocuments>();
const listeners = new Set<() => void>();
const current = (id: string) => views.get(id) ?? INITIAL_DOCUMENTS;
function update(id: string, state: SessionDocuments) {
  if (state === current(id)) return;
  views = new Map(views).set(id, state);
  listeners.forEach((l) => l());
}

export function openPullRequest(id: string, pr: Pick<PullRequest, 'number'>) {
  update(id, openDocument(current(id), pullRequestDocument(pr.number)));
}
/** Opens a Markdown or PDF file in a tab of the session (or selects the tab it is already in). */
export function openSessionFile(id: string, path: string) {
  update(id, openDocument(current(id), fileDocument(path)));
}
export function selectSessionDocument(id: string, documentId: string) {
  const state = current(id);
  if (state.tabs.some((t) => t.id === documentId)) update(id, { ...state, activeId: documentId });
}
export function closeSessionDocument(id: string, documentId: string) {
  update(id, closeDocument(current(id), documentId));
}
/** Only a successful lookup may remove a no-longer-associated PR, never a transient error. */
export function reconcilePullRequests(id: string, prs: readonly PullRequest[]) {
  let state = current(id);
  for (const tab of state.tabs) if (tab.kind === 'pull-request' && !prs.some((pr) => pr.number === tab.number)) state = closeDocument(state, tab.id);
  update(id, state);
}
export function useSessionDocuments(id: string): SessionDocuments {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current(id),
  );
}

/** Every prepare request gets its own number, so a late answer to an older one is ignored. */
let requests = 0;

/** Opens (or selects) the New PR tab. Returns the request number to prepare with, or null when nothing needs asking. */
export function chooseNewPullRequestFor(id: string, mode: NewPullRequestMode): number | null {
  requests += 1;
  const next = chooseNewPullRequest(current(id), mode, requests);
  update(id, next.state);
  return next.prepare ? requests : null;
}
/** Asks for the generated text again after a commit, where the user typed none. Returns the request number, or null when nothing needs asking. */
export function regenerateNewPullRequestFor(id: string): number | null {
  requests += 1;
  const next = regenerateNewPullRequest(current(id), requests);
  update(id, next.state);
  return next.prepare ? requests : null;
}
export const confirmCreateIn = (id: string) => update(id, confirmCreate(current(id)));
export const leaveConfirmCreateIn = (id: string) => update(id, leaveConfirmCreate(current(id)));
export const newPullRequestIn = (id: string): NewPullRequestDocument | undefined => newPullRequestOf(current(id));
export const editNewPullRequestIn = (id: string, patch: Partial<PullRequestDraft>) => update(id, editNewPullRequest(current(id), patch));
export const preparedNewPullRequestIn = (id: string, request: number, answer: Parameters<typeof newPullRequestPrepared>[2]) => update(id, newPullRequestPrepared(current(id), request, answer));
export const creatingNewPullRequestIn = (id: string) => update(id, newPullRequestCreating(current(id)));
export const failedNewPullRequestIn = (id: string, error: string) => update(id, newPullRequestFailed(current(id), error));
export const createdNewPullRequestIn = (id: string, number: number) => update(id, newPullRequestCreated(current(id), number));
