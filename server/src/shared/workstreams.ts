// Workstreams: a named piece of work that reaches across projects, as references to the sessions
// doing it. A session stays filed in its own project (or group); a workstream only points at it,
// so nothing moves when one is made, changed or deleted. Shared by the server, which keeps them,
// and the sidebar and the workstream page, which draw them.
import type { Group, Link, Session, TreeNode, Workstream } from '../model.ts';
import { buildTree } from '../tree.ts';
import { fitsGroup, projectOfSession } from './project-groups.ts';
import { parentHears } from './turn-reports.ts';
import { activityAt } from './session-order.ts';
import { statusOf } from './status.ts';

type Placed = Pick<Session, 'landedIn' | 'startedIn'>;

export const WORKSTREAM_NAME_MAX = 80;
export const WORKSTREAM_OBJECTIVE_MAX = 400;

/** The workstream a session is in, or null. A session is in at most one that Kestrel made; the first wins. */
export function workstreamOf<W extends Pick<Workstream, 'sessionIds'>>(workstreams: readonly W[], sessionId: string): W | null {
  return workstreams.find((w) => w.sessionIds.includes(sessionId)) ?? null;
}

/**
 * What a `delegate` does about workstreams. An orchestrator already in one adds its new sessions
 * to it, whatever their projects: further delegation is part of the same work. Otherwise a split
 * that reaches a project other than the orchestrator's own (or whose orchestrator has no project)
 * starts a workstream; one that stays inside the orchestrator's project needs none, since its
 * sessions are all listed together there.
 */
export function delegateWorkstream(orchestrator: Placed, taskProjects: readonly string[], current: Pick<Workstream, 'id'> | null): { join: string } | 'create' | 'none' {
  if (current) return { join: current.id };
  const home = projectOfSession(orchestrator);
  return home !== null && taskProjects.every((projectId) => projectId === home) ? 'none' : 'create';
}

/**
 * The group a session started by another one begins in: its parent's, when that group can hold
 * it (a project's group takes only that project's sessions), else none. A child is never the
 * reason a group is made.
 */
export function childGroupId(parentGroup: Pick<Group, 'id' | 'projectId'> | null, childProject: string): string | null {
  return parentGroup && fitsGroup(parentGroup, { landedIn: null, startedIn: childProject }) ? parentGroup.id : null;
}

/** The workstreams with a session in sight, each listing only the sessions in sight. */
export function visibleWorkstreams(all: readonly Workstream[], shown: ReadonlySet<string>): Workstream[] {
  return all.flatMap((w) => {
    const sessionIds = w.sessionIds.filter((id) => shown.has(id));
    return sessionIds.length === 0 ? [] : [sessionIds.length === w.sessionIds.length ? w : { ...w, sessionIds }];
  });
}

/** A workstream's name as stored: trimmed, single spaces, clipped. Empty when there is nothing left. */
export const workstreamName = (raw: string): string => raw.replace(/\s+/g, ' ').trim().slice(0, WORKSTREAM_NAME_MAX);

/** A workstream's objective as stored: trimmed and clipped. May be empty. */
export const workstreamObjective = (raw: string): string => raw.trim().slice(0, WORKSTREAM_OBJECTIVE_MAX);

/** "3 sessions in 2 projects", for a chip, a tooltip or the page's subtitle. */
export function workstreamSummary(sessions: readonly Placed[]): string {
  const projects = new Set(sessions.map(projectOfSession).filter((p) => p !== null));
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return projects.size === 0 ? count(sessions.length, 'session') : `${count(sessions.length, 'session')} in ${count(projects.size, 'project')}`;
}

/**
 * The quiet line in the orchestrator's conversation when its sessions are connected by a
 * workstream: "Created Invoice export to connect this session with App B · Add export endpoint."
 */
export function workstreamNotice(name: string, created: boolean, started: readonly string[]): string {
  const list = andList(started);
  return created ? `Created the workstream “${name}” to connect this session with ${list}.` : `Added ${list} to the workstream “${name}”.`;
}

/** Work still under way: a session working, or waiting on the user (a question, an approval, a failure). */
export const isOpenWork = (s: Pick<Session, 'state'>): boolean => s.state === 'running' || s.state === 'attention';

/** The lead: the session the work was asked in, which is the first one in the workstream. Null when it has none. */
export const leadOf = (w: Pick<Workstream, 'sessionIds'>): string | null => w.sessionIds[0] ?? null;

/**
 * A delegate its parent is waiting on: still at work (or waiting on the user) in a turn the parent
 * hears about. A turn the user started by writing in the child is theirs (`parentHears`): the
 * parent is not told when it ends, so it is not waiting on it (matt/kestrel#14).
 */
export const awaitedByParent = (child: Pick<Session, 'state' | 'turnByUser'>): boolean => isOpenWork(child) && parentHears({ byUser: child.turnByUser === true });

/**
 * Which sessions of a workstream are waiting on sessions they started: an orchestrator with
 * delegates still at work on what it gave them (`awaitedByParent`). This is all Kestrel knows about
 * who waits on whom; a wait between two sessions neither of which started the other is not recorded.
 */
export function waitingOn(members: readonly Pick<Session, 'id' | 'title' | 'state' | 'turnByUser'>[], links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[]): { sessionId: string; title: string; count: number }[] {
  const byId = new Map(members.map((s) => [s.id, s]));
  const open = (id: string) => {
    const member = byId.get(id);
    return member !== undefined && awaitedByParent(member);
  };
  return members.flatMap((s) => {
    const count = links.filter((l) => l.kind === 'delegate' && l.parentId === s.id && open(l.childId)).length;
    return count > 0 ? [{ sessionId: s.id, title: s.title, count }] : [];
  });
}

/**
 * How a workstream is drawn: its lead, and what is under it. The lead is the session the work was
 * asked in, which delegated the rest and answers for the whole: the first session in the
 * workstream (the orchestrator, when a delegate made it). There is one lead; if it leaves, the
 * next session in line is the lead. Under it are the sessions it started, each with its own, and
 * after them any other member that nothing in the workstream started, at the same level: being
 * in the workstream and having been delegated by the lead are two different things, and no
 * parent is invented for a session that has none here.
 */
export function workstreamShape(workstream: Pick<Workstream, 'sessionIds'>, links: readonly Link[]): { leadId: string | null; under: TreeNode[] } {
  const leadId = leadOf(workstream);
  if (leadId === null) return { leadId, under: [] };
  const roots = buildTree(workstream.sessionIds, links);
  const lead = roots.find((n) => n.sessionId === leadId);
  // The lead may itself sit under another member (it was added first but started by a later one): it still leads.
  if (!lead) return { leadId, under: roots };
  return { leadId, under: [...lead.children, ...roots.filter((n) => n !== lead)] };
}

/** A row of a workstream drawn as a tree: a session and how far it is indented (the lead is 0). */
export interface WorkstreamRow<S> {
  session: S;
  depth: number;
}

type Ranked = Pick<Session, 'id' | 'state' | 'note' | 'updatedAt' | 'lastActivityAt'>;
/** How soon a session wants looking at: waiting on the user or failed first, then working, then the rest. */
const urgency = (s: Ranked): number => {
  const status = statusOf(s);
  return status === 'needs-you' || status === 'failed' ? 0 : status === 'working' ? 1 : 2;
};

/**
 * A workstream as one tree, for its page (Matt, 2026-11-20): the lead first, then under it the
 * sessions it started, each with its own, indented a level each; a member nothing in the
 * workstream started sits at the first level, as in the sidebar (`workstreamShape`). At each level
 * the sessions that need something or are working rise to the top: a session is placed by the
 * most urgent thing in its subtree (waiting on the user or failed, then working, then the rest),
 * and within that by the latest activity in its subtree. Sessions missing from `sessions` (archived,
 * deleted) are left out, with what is under them moving up a level.
 */
export function workstreamRows<S extends Ranked>(workstream: Pick<Workstream, 'sessionIds'>, links: readonly Link[], sessions: readonly S[]): WorkstreamRow<S>[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const { leadId, under } = workstreamShape(workstream, links);
  const lead = leadId ? byId.get(leadId) : undefined;
  const key = (node: TreeNode): { urgency: number; at: number } => {
    const own = byId.get(node.sessionId);
    const kids = node.children.map(key);
    return { urgency: Math.min(own ? urgency(own) : 2, ...kids.map((k) => k.urgency)), at: Math.max(own ? activityAt(own) : 0, ...kids.map((k) => k.at)) };
  };
  const level = (nodes: readonly TreeNode[], depth: number): WorkstreamRow<S>[] =>
    nodes
      .map((node) => ({ node, key: key(node) }))
      .sort((a, b) => a.key.urgency - b.key.urgency || b.key.at - a.key.at || a.node.sessionId.localeCompare(b.node.sessionId))
      .flatMap(({ node }) => {
        const session = byId.get(node.sessionId);
        return session ? [{ session, depth }, ...level(node.children, depth + 1)] : level(node.children, depth);
      });
  return [...(lead ? [{ session: lead, depth: 0 }] : []), ...level(under, lead ? 1 : 0)];
}

/** "1 delegated session", for the lead row's second line; counts everything under the lead. */
export function delegatedText(count: number): string {
  return `${count} delegated session${count === 1 ? '' : 's'}`;
}

// ---- complete, archive, restore (Matt, 2026-11-18) -------------------------------------------
// Completion records the outcome; archiving controls visibility; continuing the work brings it
// back. Neither touches a session: a workstream points, it never holds.

export const isArchived = (w: Pick<Workstream, 'archivedAt'>): boolean => typeof w.archivedAt === 'number';
export const isComplete = (w: Pick<Workstream, 'status'>): boolean => w.status === 'complete';

/** The archived ones, most recently archived first, and the rest in the order given. */
export function splitArchived<W extends Pick<Workstream, 'archivedAt'>>(all: readonly W[]): { active: W[]; archived: W[] } {
  return { active: all.filter((w) => !isArchived(w)), archived: all.filter(isArchived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)) };
}

/**
 * The workstreams the workspace state carries. An active one follows its sessions: it is listed
 * with the sessions in sight, and not at all when none is. An archived one is listed whole
 * whatever became of its sessions, so archiving them too never loses it from Settings → Archived.
 */
export function shownWorkstreams(all: readonly Workstream[], shown: ReadonlySet<string>): { active: Workstream[]; archived: Workstream[] } {
  const { active, archived } = splitArchived(all);
  return { active: visibleWorkstreams(active, shown), archived };
}

/**
 * What a new message from the user in one of its sessions does to a workstream: continuing the
 * conversation resumes the effort. An archived one comes back to the sidebar (`restored`), and a
 * complete one is active again. Null when nothing changes. Opening or reading a session, and an
 * agent's result arriving, never come here: they leave it as it is.
 */
export function afterUserMessage(w: Pick<Workstream, 'status' | 'archivedAt'>): { patch: { status: 'active'; archivedAt: null }; restored: boolean } | null {
  if (!isArchived(w) && !isComplete(w)) return null;
  return { patch: { status: 'active', archivedAt: null }, restored: isArchived(w) };
}

/** Said in the session whose new message brought its workstream back. */
export const RESTORED_NOTICE = 'Workstream restored to active work.';

/** "a, b and c". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "“Export endpoint” (id) and “Download button” (id)", for a reason an agent reads. */
function sessionList(sessions: readonly Pick<Session, 'id' | 'title'>[]): string {
  return andList(sessions.map((s) => `“${s.title}” (${s.id})`));
}

/**
 * Why a workstream may not be archived yet, or null when it may (Matt, 2026-11-19: not until its
 * agents are done). `sessions` are the sessions in sight: one archived by itself is put away and
 * does not hold the workstream back. Archiving still stops nothing; it waits instead, so a
 * stopped, finished or idle-but-unfinished workstream can be archived. One rule for the menu
 * (the item disabled with this as its hint) and the server (refused with it).
 */
export function archiveRefusal(workstream: Pick<Workstream, 'name' | 'sessionIds'>, sessions: readonly Pick<Session, 'id' | 'title' | 'state'>[]): string | null {
  const members = new Set(workstream.sessionIds);
  const open = sessions.filter((s) => members.has(s.id) && isOpenWork(s));
  if (open.length === 0) return null;
  const one = open.length === 1;
  return `“${workstream.name}” can be archived once its sessions are done: ${andList(open.map((s) => `“${s.title}”`))} ${one ? 'is' : 'are'} still working or waiting on you. Answer or stop ${one ? 'it' : 'them'} first.`;
}

/**
 * Why the session `callerId` may not mark its workstream complete (`complete_workstream`), or null
 * when it may. Only the lead answers for the whole, and Complete records that the work finished, so
 * it is refused while any other session in it is still working or waiting on the user.
 */
export function completeRefusal(workstream: Pick<Workstream, 'name' | 'sessionIds'> | null, callerId: string, sessions: readonly Pick<Session, 'id' | 'title' | 'state'>[]): string | null {
  if (!workstream) return 'This session is not in a workstream, so there is nothing to mark complete. Tell the user the task is done instead.';
  const lead = leadOf(workstream);
  if (lead !== callerId) {
    const title = sessions.find((s) => s.id === lead)?.title ?? 'another session';
    return `Only the lead of “${workstream.name}” marks it complete: that is “${title}” (${lead}). Finish your own part and say so; the lead decides when the whole is done.`;
  }
  const open = sessions.filter((s) => s.id !== callerId && workstream.sessionIds.includes(s.id) && isOpenWork(s));
  if (open.length === 0) return null;
  return `Not marked complete: ${sessionList(open)} ${open.length === 1 ? 'is' : 'are'} still working or waiting on the user. Wait until ${open.length === 1 ? 'it finishes' : 'they finish'} (session_status shows where each stands), then call it again; if one is stuck, tell the user.`;
}

/** Said to the lead when its workstream was already complete: nothing changed. */
export const ALREADY_COMPLETE = (name: string): string => `“${name}” is already marked complete. Nothing changed.`;
