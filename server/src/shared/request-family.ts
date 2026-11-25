// A session's family, for the chip in its header's second line (Matt, 2026-11-24): the sessions
// working on the same thing, and what their requests say, in words that read without colour.
//
// Two kinds:
//   - a workstream of more than one session: the same family, and the same chip, on every session of
//     it. Its lead is the session the work was asked in (`leadOf`).
//   - otherwise a session that delegated: itself and every session under it by `delegate` links
//     (tree.ts `subtreeIds`), shown on that session only. It is the lead.
//
// The chip counts the open requests of the sessions the lead brought in (its "child" requests, by
// the one rule in brought-in-requests.ts: a guest's request is its host's, counted once), and names
// what needs the user ("1 failing"). The popover lists the lead first, then the rest one level under
// it, what needs the user first. Pure and browser-safe.
import { DEFAULT_HOST, hostTerms, type HostKind } from './host-terms.ts';
import { DEFAULT_ATTENTION_PREFS, type AttentionPrefs, type AttentionReason } from './request-attention.ts';
import { broughtInRequests, openRequestsOf, rankRequests, type BroughtInRequest, type BroughtInSession, type Lookup } from './brought-in-requests.ts';
import { leadOf, workstreamOf, workstreamRows } from './workstreams.ts';
import { worktreeOwnerId } from './working-tree.ts';
import { statusOf } from './status.ts';
import { subtreeIds } from '../tree.ts';
import type { Link, Session, Workstream } from '../model.ts';

export type FamilySession = BroughtInSession & Pick<Session, 'id' | 'title' | 'state' | 'note' | 'updatedAt' | 'lastActivityAt'>;
export interface FamilyState<S extends FamilySession = FamilySession> {
  sessions: readonly S[];
  links: readonly Link[];
  workstreams: readonly Pick<Workstream, 'id' | 'name' | 'sessionIds'>[];
}

export interface FamilyMember<S> {
  session: S;
  /** The lead is the one row not indented. */
  isLead: boolean;
  /** Its own open request, the one that most wants looking at; null for a guest (its host's) or none. */
  request: BroughtInRequest | null;
}

export interface Family<S> {
  /** The workstream it is, or null for a session's own delegates. */
  workstream: { id: string; name: string } | null;
  leadId: string;
  /** The lead, then the rest, needs-you first. */
  members: FamilyMember<S>[];
  /** The open requests of the sessions the lead brought in, worst first. */
  childRequests: BroughtInRequest[];
  /** Whose words to use: the first child request's host, else GitHub's. */
  host: HostKind;
}

/** What needs the user, in a word or two each, in the order the chip says them. */
const ATTENTION_WORDS: readonly [AttentionReason, string][] = [
  ['checks-failed', 'failing'],
  ['conflicts', 'with conflicts'],
  ['changes-requested', 'changes requested'],
];

/** "1 failing · 1 with conflicts": how many child requests need the user, by reason; empty when none. */
export function attentionWords(requests: readonly BroughtInRequest[]): string[] {
  return ATTENTION_WORDS.flatMap(([reason, words]) => {
    const n = requests.filter((r) => r.reasons.includes(reason)).length;
    return n > 0 ? [`${n} ${words}`] : [];
  });
}

const plural = (n: number, one: string, many: string = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The chip's words after its name (a workstream) or on their own: "2 child PRs · 1 failing", "3 sessions", "3 sessions it started · 2 PRs". */
export function familyCountText(family: Pick<Family<unknown>, 'workstream' | 'members' | 'childRequests' | 'host'>): string {
  const short = hostTerms(family.host).short;
  const n = family.childRequests.length;
  const attention = attentionWords(family.childRequests);
  if (family.workstream) {
    if (n === 0) return plural(family.members.length, 'session');
    return [plural(n, `child ${short}`), ...attention].join(' · ');
  }
  const started = plural(family.members.length - 1, 'session') + ' it started';
  return [started, ...(n > 0 ? [plural(n, short)] : []), ...attention].join(' · ');
}

/** The chip's full words, for its tooltip and accessible name. */
export function familyDescription(family: Pick<Family<unknown>, 'workstream' | 'members' | 'childRequests' | 'host'>): string {
  const count = familyCountText(family);
  return family.workstream ? `Workstream ${family.workstream.name} · ${count}` : count;
}

/** Which sessions are the family of `sessionId`, and who leads; null when it has none. */
function familyIds(sessionId: string, state: Pick<FamilyState, 'links' | 'workstreams'>): { workstream: Family<unknown>['workstream']; leadId: string; ids: string[] } | null {
  const w = workstreamOf(state.workstreams, sessionId);
  const lead = w ? leadOf(w) : null;
  if (w && lead !== null && w.sessionIds.length > 1) return { workstream: { id: w.id, name: w.name }, leadId: lead, ids: w.sessionIds };
  const under = subtreeIds(sessionId, state.links as Link[]).filter((id) => id !== sessionId);
  return under.length > 0 ? { workstream: null, leadId: sessionId, ids: [sessionId, ...under] } : null;
}

/** The family of a session: its workstream, or itself and the sessions it delegated to. Null when it has neither. Pure. */
export function familyOf<S extends FamilySession>(sessionId: string, state: FamilyState<S>, lookupOf: (sessionId: string) => Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): Family<S> | null {
  const found = familyIds(sessionId, state);
  if (!found) return null;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const ownRequest = (s: S): BroughtInRequest | null => (worktreeOwnerId(s) === s.id ? (rankRequests(openRequestsOf(s.id, s.title, lookupOf(s.id), prefs))[0] ?? null) : null);
  // The tree's own order (urgent subtrees first), flattened to one level under the lead.
  const rows = workstreamRows({ sessionIds: [found.leadId, ...found.ids.filter((id) => id !== found.leadId)] }, state.links as Link[], found.ids.flatMap((id) => byId.get(id) ?? []));
  const members = rows.map(({ session }) => ({ session, isLead: session.id === found.leadId, request: ownRequest(session) }));
  const needsYou = (m: FamilyMember<S>) => m.request?.needsYou === true || statusOf(m.session) === 'needs-you' || statusOf(m.session) === 'failed';
  const lead = members.filter((m) => m.isLead);
  const rest = members.filter((m) => !m.isLead);
  const ordered = [...lead, ...rest.filter(needsYou), ...rest.filter((m) => !needsYou(m))];
  const childRequests = broughtInRequests(found.leadId, state, lookupOf, prefs, byId)?.requests ?? [];
  return { workstream: found.workstream, leadId: found.leadId, members: ordered, childRequests, host: childRequests[0]?.host ?? ordered.find((m) => m.request)?.request?.host ?? DEFAULT_HOST };
}
