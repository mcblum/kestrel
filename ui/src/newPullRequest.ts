// What the New PR form does with the server: asks for its pre-fill (and how many earlier commits the
// request carries) when "Manually" or "Generated" is chosen, or again once the agent has committed
// (commitRequest.ts), and creates the pull request. Every step lands in the session's document store
// (sessionView.ts), so the form shows it wherever the user has gone meanwhile.
import { pullRequestNumberOf, type NewPullRequestMode, type PullRequestDraft } from '@kestrel/server/session-documents';
import { appStore, call } from './store.ts';
import { formAutopilot, heldAutopilotPrefs } from './autopilotPrefs.ts';
import {
  chooseNewPullRequestFor,
  closeSessionDocument,
  createdNewPullRequestIn,
  creatingNewPullRequestIn,
  failedNewPullRequestIn,
  newPullRequestIn,
  preparedNewPullRequestIn,
  regenerateNewPullRequestFor,
} from './sessionView.ts';

const path = (sessionId: string, action: string) => `/api/sessions/${encodeURIComponent(sessionId)}/${action}`;
const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Kestrel could not reach its server.');
const isText = (v: unknown): v is string => typeof v === 'string';

/** Sessions whose new pull request has no number in its address: opened from the next lookup instead. */
const awaitingLookup = new Set<string>();

/** Whether the next pull request lookup should open the new pull request's tab (once). */
export function takeAwaitingLookup(sessionId: string): boolean {
  return awaitingLookup.delete(sessionId);
}

/** Sessions whose New PR form was just chosen from the menu: its title field takes focus once it can. */
const focusRequests = new Set<string>();

/** Whether the form should take focus now (once per choice from the menu). */
export function takeFocusRequest(sessionId: string): boolean {
  return focusRequests.delete(sessionId);
}

/** "Manually" or "Generated" from the Create PR menu: opens or selects the New PR tab, and asks for its pre-fill when needed. */
export async function chooseNewPullRequest(sessionId: string, mode: NewPullRequestMode): Promise<void> {
  focusRequests.add(sessionId);
  const request = chooseNewPullRequestFor(sessionId, mode);
  if (request !== null) await prepare(sessionId, mode, request);
}

/** "Commit and create", once the commit turn ended: the Generated form opens, or an open one untyped in is written again. */
export async function openGeneratedAfterCommit(sessionId: string): Promise<void> {
  focusRequests.add(sessionId);
  const request = chooseNewPullRequestFor(sessionId, 'generated') ?? regenerateNewPullRequestFor(sessionId);
  if (request !== null) await prepare(sessionId, 'generated', request);
}

/** "Commit them" in the form, once the commit turn ended: the generated text comes again only where the user typed none. */
export async function regenerateAfterCommit(sessionId: string): Promise<void> {
  const request = regenerateNewPullRequestFor(sessionId);
  if (request !== null) await prepare(sessionId, 'generated', request);
}

/** Asks the server for the form's pre-fill, as request `request`; the answer or the reason lands in the form. */
async function prepare(sessionId: string, mode: NewPullRequestMode, request: number): Promise<void> {
  try {
    const answer = await call<Partial<PullRequestDraft> & { inherited?: unknown }>(path(sessionId, 'pr-prepare'), { method: 'POST', body: JSON.stringify({ generated: mode === 'generated' }) });
    const { title, body, base, inherited } = answer ?? {};
    if (!isText(title) || !isText(body) || !isText(base)) throw new Error('Kestrel’s server gave an answer the form cannot read.');
    const carried = typeof inherited === 'number' && Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
    preparedNewPullRequestIn(sessionId, request, { prefill: { title, body, base }, inherited: carried });
  } catch (error) {
    const what = mode === 'generated' ? 'write a title and description' : 'find the default branch';
    preparedNewPullRequestIn(sessionId, request, { error: `Could not ${what}: ${reasonOf(error)}` });
  }
}

/**
 * Sends the form. On success the pull request lookup is asked again (`refresh`), the New PR tab
 * closes and the new pull request's page opens. On failure the reason shows in the form.
 */
export async function createNewPullRequest(sessionId: string, refresh: () => void): Promise<void> {
  const doc = newPullRequestIn(sessionId);
  if (!doc || doc.phase !== 'editing') return;
  creatingNewPullRequestIn(sessionId);
  try {
    const answer = await call<{ url?: unknown }>(path(sessionId, 'pr-create'), { method: 'POST', body: JSON.stringify({ ...doc.form, autopilot: formAutopilot(doc.form, heldAutopilotPrefs(), appStore.get().sessionsById.get(sessionId)?.autopilot) }) });
    const number = isText(answer?.url) ? pullRequestNumberOf(answer.url) : null;
    refresh();
    if (number !== null) return createdNewPullRequestIn(sessionId, number);
    awaitingLookup.add(sessionId);
    closeSessionDocument(sessionId, doc.id);
  } catch (error) {
    failedNewPullRequestIn(sessionId, reasonOf(error));
  }
}
