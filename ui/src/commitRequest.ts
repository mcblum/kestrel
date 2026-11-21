// Asking a session's agent to commit its work (@kestrel/server/commit-request), from the Create PR
// menu, the New PR form and the Commit changes button. The request goes through the composer's own
// path (actions.reply), so it is an ordinary message and turn in the conversation. Which sessions
// are waiting for that turn to end is kept here, per session, outside any component (like
// sessionView.ts), so it survives re-renders and switching sessions; not an app restart. The end of
// the turn is read from the app store's session state and messages, then the waiting purpose runs.
import { useSyncExternalStore } from 'react';
import { AGENT_BUSY_REASON, COMMIT_REQUEST, commitRequestEnded, hasOpenCard, isAgentBusy, nextCommitStage, type CommitStage } from '@kestrel/server/commit-request';
import { actions, appStore, useApp, type AppState } from './store.ts';
import { openGeneratedAfterCommit, regenerateAfterCommit } from './newPullRequest.ts';

/** What happens once the commit turn ends: open the Generated form ("Commit and create"), refresh the open form, or nothing more. */
export type CommitPurpose = 'create' | 'form' | 'commit';

interface Wait {
  purpose: CommitPurpose;
  stage: CommitStage;
  /** When the request was sent (ms): its message is stamped with this time or later. */
  since: number;
}

let waits = new Map<string, Wait>();
const listeners = new Set<() => void>();
let unwatch: (() => void) | null = null;

function update(next: Map<string, Wait>) {
  waits = next;
  listeners.forEach((l) => l());
  if (waits.size > 0 && !unwatch) unwatch = appStore.subscribe(step);
  if (waits.size === 0 && unwatch) {
    unwatch();
    unwatch = null;
  }
}

const messagesOf = (s: AppState, id: string) => s.live.get(id)?.messages ?? s.details.get(id)?.messages;

const FINISH: Readonly<Record<CommitPurpose, (sessionId: string) => void>> = {
  create: (id) => void openGeneratedAfterCommit(id),
  form: (id) => void regenerateAfterCommit(id),
  commit: () => {},
};

/** Moves every waiting request on by what the store shows now; a request whose turn ended runs its purpose. */
function step() {
  const s = appStore.get();
  let next: Map<string, Wait> | null = null;
  const ended: [string, CommitPurpose][] = [];
  for (const [id, wait] of waits) {
    const stage = nextCommitStage(wait.stage, s.sessionsById.get(id)?.state, commitRequestEnded(messagesOf(s, id), wait.since));
    if (stage === wait.stage) continue;
    next ??= new Map(waits);
    if (stage === 'ended') {
      next.delete(id);
      ended.push([id, wait.purpose]);
    } else next.set(id, { ...wait, stage });
  }
  if (next) update(next);
  for (const [id, purpose] of ended) FINISH[purpose](id);
}

/** Sends the commit request once (a second press while waiting does nothing); a refused send stops waiting. */
export async function sendCommitRequest(sessionId: string, purpose: CommitPurpose): Promise<void> {
  if (waits.has(sessionId)) return;
  update(new Map(waits).set(sessionId, { purpose, stage: 'sent', since: Date.now() }));
  const sent = await actions.reply(sessionId, COMMIT_REQUEST);
  if (!sent && waits.has(sessionId)) {
    const next = new Map(waits);
    next.delete(sessionId);
    update(next);
  }
}

export interface CommitRequest {
  /** A commit request for this session is waiting for its turn to end. */
  waiting: boolean;
  /** Why it cannot be sent now (the agent is mid-turn); null when it can. */
  blocked: string | null;
  send: (purpose: CommitPurpose) => void;
}

/** Whether this session's agent can be asked to commit now, whether it already was, and the way to ask. */
export function useCommitRequest(sessionId: string): CommitRequest {
  const state = useApp((s) => s.sessionsById.get(sessionId)?.state);
  const answering = useApp((s) => hasOpenCard(messagesOf(s, sessionId)));
  const waiting = useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => waits.has(sessionId),
  );
  return { waiting, blocked: isAgentBusy(state, answering) ? AGENT_BUSY_REASON : null, send: (purpose) => void sendCommitRequest(sessionId, purpose) };
}
