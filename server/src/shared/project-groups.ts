// Groups that belong to a project (Group.projectId): the rules for what may go in one, shared by
// the server, which enforces them, and the sidebar, which decides what a drop means before asking.
// One level only: a group holds sessions, never another group. A group in the Sessions list can
// span projects; a project's group holds only that project's sessions. A Sessions-list group can be
// moved into a project when everything in it belongs there; a project's group never moves out.
import type { Group, Session } from '../model.ts';

type Placed = Pick<Session, 'landedIn' | 'startedIn'>;
type Named = Placed & Pick<Session, 'title'>;

/** The project a session counts as belonging to: where its work landed, else where it started. */
export const projectOfSession = (s: Placed): string | null => s.landedIn ?? s.startedIn;

/** The project a group belongs to, or null for a group in the Sessions list. */
export const projectOfGroup = (g: Pick<Group, 'projectId'>): string | null => g.projectId ?? null;

/** Whether a session can join the group without moving to another project. */
export const fitsGroup = (group: Pick<Group, 'projectId'>, session: Placed): boolean => {
  const project = projectOfGroup(group);
  return project === null || projectOfSession(session) === project;
};

const listOf = (titles: readonly string[], max = 3): string => (titles.length <= max ? titles.map((t) => `“${t}”`).join(', ') : `${titles.slice(0, max).map((t) => `“${t}”`).join(', ')} and ${titles.length - max} more`);

/** Why `session` cannot join `group`, or null when it can. `projectName` names a project by id. */
export function joinRefusal(group: Pick<Group, 'name' | 'projectId'>, session: Named, projectName: (id: string) => string): string | null {
  if (fitsGroup(group, session)) return null;
  return `“${session.title}” belongs to ${projectName(projectOfSession(session) ?? '') || 'no project'}, and “${group.name}” is a group in ${projectName(group.projectId!)}. Move the session to that project first (Move to project…), which starts a new session there with its own worktree.`;
}

/** Why `group` cannot move into `projectId`, or null when it can. `members` are the sessions in it. */
export function moveGroupRefusal(group: Pick<Group, 'name' | 'projectId'>, projectId: string, members: readonly Named[], projectName: (id: string) => string): string | null {
  const from = projectOfGroup(group);
  if (from === projectId) return null;
  if (from !== null) return `“${group.name}” is a group in ${projectName(from)}. A project’s group stays in its project.`;
  const elsewhere = members.filter((s) => projectOfSession(s) !== projectId);
  if (elsewhere.length === 0) return null;
  return `“${group.name}” holds ${listOf(elsewhere.map((s) => s.title))}, which ${elsewhere.length === 1 ? 'belongs' : 'belong'} to another project. A project’s group holds only that project’s sessions: move ${elsewhere.length === 1 ? 'it' : 'them'} out of the group first.`;
}
