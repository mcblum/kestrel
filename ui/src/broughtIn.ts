// The open requests of the sessions each session brought in (@kestrel/server/brought-in-requests),
// derived once from what the store holds: the workspace, the pushed pull-request lookups and the
// choices of Settings → Git. Built again only when one of those changes, and an entry that says the
// same thing keeps its identity, so a header or row that shows it does not re-render for nothing.
import { broughtInByLead, type BroughtInRequests } from '@kestrel/server/brought-in-requests';
import type { PullRequestLookup } from '@kestrel/server/details';
import type { AttentionPrefs } from '@kestrel/server/request-attention';
import type { Sourced } from '@kestrel/server/sourced';
import type { WorkspaceState } from '@kestrel/server/model';
import { useAttentionPrefs } from './attentionPrefs.ts';
import { useApp } from './store.ts';

type Index = ReadonlyMap<string, BroughtInRequests>;
const NONE: Index = new Map();

let last: { workspace: WorkspaceState | null; pullRequests: ReadonlyMap<string, Sourced<PullRequestLookup>>; prefs: AttentionPrefs; index: Index; json: ReadonlyMap<string, string> } | null = null;

/** The roll-up of every session, built once per change of what it is made from. */
export function broughtInIndex(workspace: WorkspaceState | null, pullRequests: ReadonlyMap<string, Sourced<PullRequestLookup>>, prefs: AttentionPrefs): Index {
  if (last && last.workspace === workspace && last.pullRequests === pullRequests && last.prefs === prefs) return last.index;
  const built = workspace ? broughtInByLead(workspace, (id) => pullRequests.get(id), prefs) : NONE;
  const index = new Map<string, BroughtInRequests>();
  const json = new Map<string, string>();
  for (const [id, rollup] of built) {
    const text = JSON.stringify(rollup);
    const before = last?.json.get(id) === text ? last.index.get(id) : undefined;
    index.set(id, before ?? rollup);
    json.set(id, text);
  }
  last = { workspace, pullRequests, prefs, index, json };
  return index;
}

/** What a session brought in that is still open, or undefined when nothing is. */
export function useBroughtIn(sessionId: string | null | undefined): BroughtInRequests | undefined {
  const prefs = useAttentionPrefs();
  return useApp((s) => (sessionId ? broughtInIndex(s.workspace, s.pullRequests, prefs).get(sessionId) : undefined));
}
