// A session's family (@kestrel/server/request-family), derived from what the store holds: the
// workspace, the pushed pull-request lookups and the choices of Settings → Git. Worked out once per
// session per change of those, and an answer that says the same thing keeps its identity, so the
// header's chip does not re-render for nothing.
import { familyOf, type Family } from '@kestrel/server/request-family';
import type { PullRequestLookup } from '@kestrel/server/details';
import type { AttentionPrefs } from '@kestrel/server/request-attention';
import type { Sourced } from '@kestrel/server/sourced';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { useAttentionPrefs } from './attentionPrefs.ts';
import { useApp } from './store.ts';

export type SessionFamily = Family<SessionView>;
interface Held {
  family: SessionFamily | null;
  json: string;
}

let inputs: { workspace: WorkspaceState | null; pullRequests: ReadonlyMap<string, Sourced<PullRequestLookup>>; prefs: AttentionPrefs } | null = null;
let current = new Map<string, Held>();
let previous = new Map<string, Held>();

/** The family of one session, built at most once per change of what it is made from. */
export function familyFor(sessionId: string, workspace: WorkspaceState | null, pullRequests: ReadonlyMap<string, Sourced<PullRequestLookup>>, prefs: AttentionPrefs): SessionFamily | null {
  if (!inputs || inputs.workspace !== workspace || inputs.pullRequests !== pullRequests || inputs.prefs !== prefs) {
    inputs = { workspace, pullRequests, prefs };
    previous = new Map([...previous, ...current]);
    current = new Map();
  }
  const held = current.get(sessionId);
  if (held) return held.family;
  const family = workspace ? familyOf(sessionId, workspace, (id) => pullRequests.get(id), prefs) : null;
  const json = JSON.stringify(family);
  const before = previous.get(sessionId);
  const kept = before && before.json === json ? before : { family, json };
  current.set(sessionId, kept);
  previous.delete(sessionId);
  return kept.family;
}

/** The workstream or delegates a session belongs with, for the chip in its header; null when it has none. */
export function useFamily(sessionId: string): SessionFamily | null {
  const prefs = useAttentionPrefs();
  return useApp((s) => familyFor(sessionId, s.workspace, s.pullRequests, prefs));
}
