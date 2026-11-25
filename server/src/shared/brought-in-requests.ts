// The open pull or merge requests of the sessions a session brought in (Matt, 2026-11-24: "the top
// session doesn't say 3 PRs"). A workstream's lead, or any session that delegated, shows them under its
// own request: in its header's family chip (request-family.ts), on its workstream's top row, on the workstream's page and in its hover card. They only show:
// each request still notifies and raises its card on its own session, once (shared/notifications.ts,
// suggestions/request-kind.ts), never on the session that brought it in.
//
// Who counts: the sessions it started, by `delegate` links all the way down (tree.ts `subtreeIds`), and,
// for a workstream's lead, every other session of that workstream. A guest works in its host's worktree
// and shares its request, so each worktree is counted once, by its owner (working-tree.ts); a guest of
// the session itself shares the session's own request and is not counted. Merged and closed requests
// are left out: what is counted is what is still open. What needs the user is the one rule the row
// mark uses (`requestAttention`), and those come first, then the rest worst first by status colour.
//
// Built once for every session per change of the workspace, the pushed lookups or the preferences
// (`broughtInByLead`); views read their session's entry, never compute it per row.
import { pullRequestStatus, type PullRequest, type PullRequestLookup } from './details.ts';
import { hostTerms, type HostKind } from './host-terms.ts';
import { DEFAULT_ATTENTION_PREFS, requestAttention, type AttentionPrefs, type AttentionReason } from './request-attention.ts';
import type { RequestTone } from './row-slot.ts';
import type { Sourced } from './sourced.ts';
import { leadOf } from './workstreams.ts';
import { worktreeOwnerId } from './working-tree.ts';
import { isChildLink, subtreeIds } from '../tree.ts';
import type { Link, Session, Workstream } from '../model.ts';

export interface BroughtInRequest {
  /** The session whose request it is: the worktree's owner. */
  sessionId: string;
  sessionTitle: string;
  host: HostKind;
  pr: PullRequest;
  /** What it says beside the request: what needs the user, else its status ("Checks running"). */
  label: string;
  tone: RequestTone;
  /** It needs the user (checks failed, conflicts, changes requested), by the row mark's own rule. */
  needsYou: boolean;
  /** Why it needs the user, when it does; empty otherwise. */
  reasons: readonly AttentionReason[];
}

export interface BroughtInRequests {
  /** Needs the user first, then by colour: red, amber, green, grey. Never empty. */
  requests: BroughtInRequest[];
  /** Whose words to use for the count ("PRs" or "MRs"): the first request's host. */
  host: HostKind;
  /** How many of them need the user. */
  needsYou: number;
}

export type BroughtInSession = Pick<Session, 'id'> & Partial<Pick<Session, 'title' | 'hostId'>>;
export interface BroughtInState {
  sessions: readonly BroughtInSession[];
  links: readonly Link[];
  workstreams: readonly Pick<Workstream, 'sessionIds'>[];
}
export type Lookup = Sourced<PullRequestLookup> | undefined | null;

/** Each reason in the status words the request pill uses, so a list stays short: "Checks failed · Merge conflicts". */
const REASON_WORDS: Readonly<Record<AttentionReason, string>> = { 'checks-failed': 'Checks failed', conflicts: 'Merge conflicts', 'changes-requested': 'Changes requested' };

const TONE_RANK: Readonly<Record<RequestTone, number>> = { red: 0, amber: 1, green: 2, purple: 3, muted: 4 };
const isOpen = (pr: PullRequest) => pr.state === 'open' || pr.state === 'draft';

/** The sessions a session brought in: its delegate subtree and, where it leads a workstream, that workstream's other sessions. Itself never. */
export function broughtInIds(sessionId: string, state: Pick<BroughtInState, 'links' | 'workstreams'>): string[] {
  const out = new Set(subtreeIds(sessionId, state.links as Link[]));
  for (const w of state.workstreams) if (leadOf(w) === sessionId) for (const id of w.sessionIds) out.add(id);
  out.delete(sessionId);
  return [...out];
}

/** One worktree owner's open and draft requests, in the words and colours the pill uses. Pure. */
export function openRequestsOf(owner: string, title: string, lookup: Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): BroughtInRequest[] {
  if (!lookup || lookup.state !== 'ready') return [];
  const needs = requestAttention(lookup, prefs);
  return lookup.value.pullRequests.filter(isOpen).map((pr) => {
    const status = pullRequestStatus(pr);
    const needsYou = needs !== null && needs.number === pr.number;
    const reasons = needsYou ? needs.reasons.map((d) => d.reason) : [];
    return { sessionId: owner, sessionTitle: title, host: lookup.value.host, pr, label: needsYou ? reasons.map((r) => REASON_WORDS[r]).join(' · ') : status.label, tone: needsYou ? 'red' : status.tone, needsYou, reasons };
  });
}

/** Needs the user first, then by colour, then in the order given. */
export function rankRequests(requests: readonly BroughtInRequest[]): BroughtInRequest[] {
  return requests.map((r, i) => ({ r, i })).sort((a, b) => Number(b.r.needsYou) - Number(a.r.needsYou) || TONE_RANK[a.r.tone] - TONE_RANK[b.r.tone] || a.i - b.i).map(({ r }) => r);
}

/** One session's roll-up; null when nothing it brought in has an open request. Pure. */
export function broughtInRequests(sessionId: string, state: BroughtInState, lookupOf: (sessionId: string) => Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS, byId: ReadonlyMap<string, BroughtInSession> = new Map(state.sessions.map((s) => [s.id, s]))): BroughtInRequests | null {
  const self = byId.get(sessionId);
  const ownOwner = self ? worktreeOwnerId(self) : sessionId;
  const owners: string[] = [];
  for (const id of broughtInIds(sessionId, state)) {
    const s = byId.get(id);
    if (!s) continue;
    const owner = worktreeOwnerId(s);
    if (owner !== ownOwner && !owners.includes(owner)) owners.push(owner);
  }
  const requests = owners.flatMap((owner) => openRequestsOf(owner, byId.get(owner)?.title ?? '', lookupOf(owner), prefs));
  if (requests.length === 0) return null;
  // Stable: within one rank, the order the sessions were brought in.
  const ranked = rankRequests(requests);
  return { requests: ranked, host: ranked[0]!.host, needsYou: ranked.filter((r) => r.needsYou).length };
}

/** Which sessions brought others in: those with a delegate child, and every workstream's lead. */
function bringers(state: Pick<BroughtInState, 'links' | 'workstreams'>): Set<string> {
  const out = new Set<string>();
  for (const l of state.links) if (isChildLink(l)) out.add(l.parentId);
  for (const w of state.workstreams) {
    const lead = leadOf(w);
    if (lead !== null && w.sessionIds.length > 1) out.add(lead);
  }
  return out;
}

/** Every session's roll-up, by session id; only those with one are in it. Pure. */
export function broughtInByLead(state: BroughtInState, lookupOf: (sessionId: string) => Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): ReadonlyMap<string, BroughtInRequests> {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const out = new Map<string, BroughtInRequests>();
  for (const id of bringers(state)) {
    if (!byId.has(id)) continue;
    const found = broughtInRequests(id, state, lookupOf, prefs, byId);
    if (found) out.set(id, found);
  }
  return out;
}

/** "3 pull requests from the sessions it brought in, 1 needs you": the count's tooltip and accessible name. */
export function broughtInDescription(rollup: BroughtInRequests): string {
  const terms = hostTerms(rollup.host);
  const n = rollup.requests.length;
  const what = `${n} open ${n === 1 ? terms.long : terms.plural} from the sessions it brought in`;
  return rollup.needsYou > 0 ? `${what}, ${rollup.needsYou} ${rollup.needsYou === 1 ? 'needs' : 'need'} you` : what;
}

/** "3 pull requests in this workstream's sessions, 1 needs you": the sidebar mark's tooltip and accessible name, where it shows only the icon and the number. */
export function workstreamRequestsDescription(rollup: BroughtInRequests): string {
  const terms = hostTerms(rollup.host);
  const n = rollup.requests.length;
  const what = `${n} open ${n === 1 ? terms.long : terms.plural} in this workstream’s sessions`;
  return rollup.needsYou > 0 ? `${what}, ${rollup.needsYou} ${rollup.needsYou === 1 ? 'needs' : 'need'} you` : what;
}
