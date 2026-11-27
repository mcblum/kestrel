// The other computers' sessions, put beside this computer's own for a window to draw
// (docs/designs/account-sessions.md, sections 9.1 and 10). Pure: `Workspace.view()` reads the replica
// and calls this once per change.
//
// - A remote session is filed as its own machine filed it: that status travels in its head, with the
//   git evidence only that machine has. Nothing here guesses.
// - Its project is this computer's project of the same repository when there is one (matched by
//   repository key, for display only). A project no folder of this computer is, is listed with its
//   sessions and marked `away`.
// - Every project another computer has is listed (its record, shared/account-projects.ts), once per
//   repository: two computers' clones are one project. A plain folder is listed as its computer's only.
// - A remote session's tree and workstream are as its machine says them in its head (issue 83,
//   shared/account-workstreams.ts): its start link joins `links`, so the sidebar, a workstream's page and the
//   session map draw its tree, and the workstreams other computers hold are listed beside this computer's own,
//   each marked with the computer that holds it.
// - Objects this computer already had keep their identity, so a row that did not change is not redrawn.
import type { Project, SessionView, WorkspaceState } from './model.ts';
import { awayIdOfFolder, awayIdOfRepo, type AccountProject } from './shared/account-projects.ts';
import { remoteLinks, remoteWorkstreams } from './shared/account-workstreams.ts';
import type { AccountHead, Machine } from './shared/machines.ts';
import { buildTree } from './tree.ts';

const NO_TAGS: readonly string[] = [];

/**
 * The id a project only another computer has is listed under: by its repository when it has one, so two machines' clones are one project.
 * No `:` in it: a page's panes are known by `project:<id>` (shared/scope.ts).
 */
export function awayProjectId(head: Pick<AccountHead, 'runsOn' | 'project' | 'repos'>): string | null {
  if (!head.project) return null;
  return head.repos[0] ? awayIdOfRepo(head.repos[0]) : awayIdOfFolder(head.runsOn, head.project.id);
}

function viewOf(head: AccountHead, projectId: string | null): SessionView {
  return {
    id: head.id,
    title: head.title,
    agent: head.agent,
    state: head.state,
    note: head.note,
    startedIn: projectId,
    startedFolderId: null,
    landedIn: head.filing === 'landed' ? projectId : null,
    worktreePath: null,
    branch: head.branch,
    worktreeDiscarded: false,
    groupId: null,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
    lastActivityAt: head.lastActivityAt,
    ...(head.completedAt !== undefined ? { completedAt: head.completedAt } : {}),
    ...(head.stopped ? { stopped: true } : {}),
    ...(head.hostId ? { hostId: head.hostId } : {}),
    runsOn: head.runsOn,
    filing: { projectId: head.filing === 'unscoped' ? null : projectId, status: projectId === null && head.filing !== 'hidden' ? 'unscoped' : head.filing, discarded: false },
    folderId: null,
    tags: NO_TAGS,
    request: head.request,
  };
}

type Elsewhere = NonNullable<Project['elsewhere']>;

/**
 * The projects this computer lists but has no folder of, by the id each is listed under, and where each
 * repository key is listed. One per repository: every computer's record of a repository joins the same one.
 */
class AwayProjects {
  readonly byId = new Map<string, Project & { elsewhere: Elsewhere }>();
  private readonly byKey = new Map<string, string>();

  find(repos: readonly string[]): string | undefined {
    return repos.map((k) => this.byKey.get(k)).find((id) => id !== undefined);
  }

  /** Adds what one computer says of a project: its name (the first said wins), the computer with its id for the project, its repositories, its folders. */
  add(id: string, name: string, machine: Elsewhere['machines'][number] | null, repos: readonly string[], folders: Elsewhere['folders']): void {
    const was = this.byId.get(id);
    const machines = was?.elsewhere.machines ?? [];
    const elsewhere: Elsewhere = {
      machines: machine && !machines.some((m) => m.id === machine.id) ? [...machines, machine] : machines,
      repos: [...new Set([...(was?.elsewhere.repos ?? []), ...repos])],
      folders: was && was.elsewhere.folders.length > 0 ? was.elsewhere.folders : folders,
    };
    this.byId.set(id, { id, name: was?.name || name || 'Project', folders: [], defaultFolderId: null, away: true, elsewhere });
    for (const key of repos) if (!this.byKey.has(key)) this.byKey.set(key, id);
  }
}

/**
 * `state` with the sessions of `heads` added, and every project another computer has that this one does
 * not (`projects`, from their records), with its sessions if any and with none if none. `keys` are this
 * computer's projects' repository keys. With no head and no project it is `state` itself.
 *
 * A computer that has not updated sends no project records: a project of its is still listed from its
 * sessions' heads, as before.
 */
export function withRemote(state: WorkspaceState, heads: readonly AccountHead[], machines: readonly Machine[], keys: ReadonlyMap<string, readonly string[]>, projects: readonly AccountProject[] = []): WorkspaceState {
  if (heads.length === 0 && projects.length === 0) return state;
  const own = new Set([...state.sessions, ...state.archived.sessions].map((s) => s.id));
  const byKey = new Map<string, string>();
  // An archived project still claims its repository: its sessions from elsewhere stay out of sight with it.
  const hiddenProjects = new Set(state.archived.projects.map((p) => p.id));
  for (const project of [...state.projects, ...state.archived.projects]) for (const key of keys.get(project.id) ?? []) if (!byKey.has(key)) byKey.set(key, project.id);
  const local = (repos: readonly string[]) => repos.map((k) => byKey.get(k)).find((id) => id !== undefined);

  const away = new AwayProjects();
  // This computer's projects that other computers have too, and their ids there: where New session may also start them.
  const alsoOn = new Map<string, NonNullable<Project['alsoOn']>>();
  // Records in a stable order, so which computer's name a shared project takes does not change between pushes.
  for (const p of [...projects].sort((a, b) => a.machine.name.localeCompare(b.machine.name) || a.id.localeCompare(b.id))) {
    const mine = local(p.repos);
    if (mine !== undefined) {
      const there = alsoOn.get(mine) ?? [];
      if (!there.some((m) => m.id === p.machine.id)) alsoOn.set(mine, [...there, { id: p.machine.id, name: p.machine.name, projectId: p.id }]);
      continue;
    }
    const id = away.find(p.repos) ?? (p.repos[0] ? awayIdOfRepo(p.repos[0]) : awayIdOfFolder(p.machine.id, p.id));
    away.add(id, p.name, { ...p.machine, projectId: p.id }, p.repos, p.folders);
  }

  const remote: SessionView[] = [];
  const remoteArchived: SessionView[] = [];
  for (const head of heads) {
    // A session this computer has is its own, whatever another machine says.
    if (own.has(head.id)) continue;
    const here = local(head.repos);
    if (here && hiddenProjects.has(here)) continue;
    // A plain folder's sessions go under `machine|<computer>|<project>`, the id its record is listed under too.
    const projectId = here ?? away.find(head.repos) ?? awayProjectId(head);
    const machine = machines.find((m) => m.id === head.runsOn);
    if (!here && projectId && head.project) away.add(projectId, head.project.name, machine ? { ...machine, projectId: head.project.id } : null, head.repos, []);
    (head.archived ? remoteArchived : remote).push(viewOf(head, projectId));
  }
  if (remote.length === 0 && remoteArchived.length === 0 && away.byId.size === 0 && alsoOn.size === 0) return state;
  const sessions = remote.length > 0 ? [...state.sessions, ...remote] : state.sessions;
  const ungrouped = sessions.filter((s) => s.groupId === null && !s.aside).map((s) => s.id);
  const ownProjects = alsoOn.size > 0 ? state.projects.map((p) => (alsoOn.has(p.id) ? { ...p, alsoOn: alsoOn.get(p.id)! } : p)) : state.projects;
  const listed = new Set([...remote, ...remoteArchived].map((s) => s.id));
  const shownHeads = heads.filter((h) => listed.has(h.id));
  const extraLinks = remoteLinks(shownHeads, own);
  const links = extraLinks.length > 0 ? [...state.links, ...extraLinks] : state.links;
  const ownWorkstreams = new Set([...state.workstreams, ...state.archivedWorkstreams].map((w) => w.id));
  const elsewhere = remoteWorkstreams(shownHeads, machines, ownWorkstreams, new Set(sessions.map((s) => s.id)));
  return {
    ...state,
    projects: away.byId.size > 0 ? [...ownProjects, ...away.byId.values()] : ownProjects,
    sessions,
    links,
    trees: remote.length > 0 ? { ...state.trees, ungrouped: buildTree(ungrouped, links) } : state.trees,
    ...(elsewhere.active.length > 0 ? { workstreams: [...state.workstreams, ...elsewhere.active] } : {}),
    ...(elsewhere.archived.length > 0 ? { archivedWorkstreams: [...state.archivedWorkstreams, ...elsewhere.archived] } : {}),
    ...(remoteArchived.length > 0 ? { archived: { ...state.archived, sessions: [...state.archived.sessions, ...remoteArchived] } } : {}),
    machines: machines.filter((m) => remote.some((s) => s.runsOn === m.id) || remoteArchived.some((s) => s.runsOn === m.id)),
  };
}
