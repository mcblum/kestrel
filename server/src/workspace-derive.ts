// Pure derivation of the workspace state from the stored collections. Used by `Workspace.state()`.
import type { AutopilotRecord } from './shared/autopilot.ts';
import type { Archived } from './shared/archive.ts';
import { sessionHidden } from './shared/archive.ts';
import { fileSession } from './filing.ts';
import { buildTree } from './tree.ts';
import { resolveStartedFolder } from './shared/project-folders.ts';
import { requestStatesBySession } from './shared/request-state.ts';
import type { Group, Link, LinkKind, Project, Session, SessionRequestLink, SessionView, TagRow, TrailEntry, TreeNode, WorkspaceState } from './model.ts';

const NO_TAGS: readonly string[] = [];

/** Each session's tags, by session id. */
function tagsBySession(rows: readonly TagRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { sessionId, tag } of rows) {
    const list = map.get(sessionId);
    if (list) list.push(tag);
    else map.set(sessionId, [tag]);
  }
  return map;
}

/** Pure: everything the UI needs to draw the workspace, from the stored collections. */
export function deriveState(
  projects: Project[],
  groups: Group[],
  sessions: readonly Session[],
  links: Link[],
  tagRows: readonly TagRow[] = [],
  repoOf?: (worktreePath: string) => string | null,
  requestRows: readonly SessionRequestLink[] = [],
  autopilot: ReadonlyMap<string, AutopilotRecord> = new Map(),
): Omit<WorkspaceState, 'archived' | 'pins' | 'workstreams' | 'archivedWorkstreams'> {
  const tags = tagsBySession(tagRows);
  const requests = requestStatesBySession(requestRows);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  // Index links once; filing each session against the full list would be quadratic.
  const byChild = new Map<string, Link>();
  const handoffParents = new Set<string>();
  for (const l of links) {
    byChild.set(l.childId, l);
    if (l.kind === 'handoff') handoffParents.add(l.parentId);
  }
  const views: SessionView[] = sessions.map((s) => {
    const own: Link[] = [];
    const up = byChild.get(s.id);
    if (up) own.push(up);
    if (handoffParents.has(s.id)) own.push({ id: '', parentId: s.id, childId: '', kind: 'handoff' });
    const folderId = resolveStartedFolder(projectById.get(s.startedIn ?? ''), s, repoOf)?.id ?? null;
    const pilot = autopilot.get(s.id);
    return { ...s, filing: fileSession(s, own), folderId, tags: tags.get(s.id) ?? NO_TAGS, request: requests.get(s.id) ?? null, ...(pilot ? { autopilot: pilot } : {}) };
  });
  const idsByGroup = new Map<string, string[]>();
  for (const s of views) {
    // A sidebar is no row of any list (shared/asides.ts).
    if (s.aside) continue;
    const key = s.groupId ?? 'ungrouped';
    const list = idsByGroup.get(key);
    if (list) list.push(s.id);
    else idsByGroup.set(key, [s.id]);
  }
  const trees: Record<string, TreeNode[]> = { ungrouped: buildTree(idsByGroup.get('ungrouped') ?? [], links) };
  for (const g of groups) trees[g.id] = buildTree(idsByGroup.get(g.id) ?? [], links);
  return { projects, groups, sessions: views, links, trees };
}

/**
 * The state without what is archived. Sessions are filed first (their links to archived
 * sessions still count), then the archived ones are taken out of every list and the trees are
 * rebuilt from what is left.
 */
export function withoutArchived(state: Omit<WorkspaceState, 'archived' | 'pins' | 'workstreams' | 'archivedWorkstreams'>, archived: Archived): Omit<WorkspaceState, 'pins' | 'workstreams' | 'archivedWorkstreams'> {
  if (archived.sessions.length + archived.projects.length + archived.groups.length === 0) return { ...state, archived: { sessions: [], projects: [], groups: [] } };
  const hidden = (s: SessionView) => sessionHidden({ id: s.id, groupId: s.groupId, projectId: s.filing.projectId ?? s.startedIn }, archived);
  const sessions = state.sessions.filter((s) => !hidden(s));
  // A project's groups are out of sight with it.
  const groups = state.groups.filter((g) => !archived.groups.includes(g.id) && !(g.projectId && archived.projects.includes(g.projectId)));
  const projects = state.projects.filter((p) => !archived.projects.includes(p.id));
  const shown = new Set(sessions.map((s) => s.id));
  const links = state.links.filter((l) => shown.has(l.parentId) && shown.has(l.childId));
  const ids = (groupId: string | null) => sessions.filter((s) => s.groupId === groupId && !s.aside).map((s) => s.id);
  const trees: Record<string, TreeNode[]> = { ungrouped: buildTree(ids(null), links) };
  for (const g of groups) trees[g.id] = buildTree(ids(g.id), links);
  return {
    projects,
    groups,
    sessions,
    links,
    trees,
    archived: { sessions: state.sessions.filter(hidden), projects: state.projects.filter((p) => archived.projects.includes(p.id)), groups: state.groups.filter((g) => archived.groups.includes(g.id)) },
  };
}

/** Ancestors (oldest first), the session itself, then its direct children. */
export function trailFor(sessionId: string, state: WorkspaceState): TrailEntry[] {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const projectName = (id: string | null) => state.projects.find((p) => p.id === id)?.name ?? null;
  const chain: { id: string; via: LinkKind | null }[] = [];
  const seen = new Set<string>();
  let current = sessionId;
  for (;;) {
    seen.add(current);
    const up = state.links.find((l) => l.childId === current);
    chain.unshift({ id: current, via: up?.kind ?? null });
    if (!up || seen.has(up.parentId)) break;
    current = up.parentId;
  }
  const children = state.links.filter((l) => l.parentId === sessionId).map((l) => ({ id: l.childId, via: l.kind as LinkKind | null }));
  const entries: TrailEntry[] = [];
  for (const c of [...chain, ...children]) {
    const s = byId.get(c.id);
    if (!s) continue;
    // A parent that changed nothing is filed nowhere, but its trail entry still says where it started.
    const shownProject = s.filing.status === 'hidden' ? s.startedIn : s.filing.projectId;
    entries.push({ sessionId: s.id, title: s.title, agent: s.agent, state: s.state, projectName: projectName(shownProject), filingStatus: s.filing.status, request: s.request, ...(s.stopped ? { stopped: true } : {}), via: c.via, current: s.id === sessionId });
  }
  return entries;
}
