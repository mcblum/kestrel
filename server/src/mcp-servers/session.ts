// Which MCP servers a session starts with (docs/designs/mcp-servers.md, section 9, M3 and M9), built
// once at session start (runtime/start-options.ts):
// - a session in a project: the default set as that project has it switched on, and the project's own;
// - a review of somebody else's pull request, or a session with no project: the default set;
// - a session another session started (`handoff`, `delegate`): the same servers as the session the
//   user started, up the chain, whichever project it is in.
// Servers found in the agents' own files follow the same lists, as before; Kestrel's win on a shared name.
import type { Link, Project, ProjectFolder, SessionView } from '../model.ts';
import type { HandedServer } from '../shared/mcp-servers.ts';
import { folderOf } from '../shared/project-folders.ts';
import { enabledServers, type DiscoveredServer, type McpConfig, type ProjectSetup } from '../shared/setup.ts';
import { startLinkOf } from '../tree.ts';
import type { Workspace } from '../workspace.ts';
import type { McpServerStore } from './store.ts';

/** Where a session's servers come from: one project's list, or the default set alone. */
export interface ServerSource {
  /** Null: the default set alone. */
  projectId: string | null;
  /** The project folder whose own files (`.mcp.json`, Claude's per-project servers) are read; null with none. */
  folderPath: string | null;
}

/**
 * The session the user started that `id` descends from by start links (itself when none). Only `handoff` and
 * `delegate` leave a start link; a `spawn` leaves none, so a spawned session is its own starter and gets its
 * own project's servers (M9, Matt, 2026-11-24: an unrelated task). Pure.
 */
export function starterOf(id: string, links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[]): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    seen.add(current);
    const up = startLinkOf(current, links)?.parentId;
    if (!up || seen.has(up)) return current;
    current = up;
  }
}

/**
 * Whose servers: the starter's project, or the default set for a review of somebody else's pull
 * request or no project. `own`: the session's own project and folder, used when it is its own starter
 * (and for a session not yet stored, a draft). Pure.
 */
export function serverSource(sessionId: string, own: { project: Project | null; folder: ProjectFolder | null }, sessions: readonly Pick<SessionView, 'id' | 'startedIn' | 'folderId' | 'review'>[], projects: readonly Project[], links: readonly Pick<Link, 'parentId' | 'childId' | 'kind'>[]): ServerSource {
  const starterId = starterOf(sessionId, links);
  const starter = sessions.find((s) => s.id === starterId);
  if (starter?.review) return { projectId: null, folderPath: null };
  if (starterId === sessionId || !starter) return own.project ? { projectId: own.project.id, folderPath: own.folder?.path ?? null } : { projectId: null, folderPath: null };
  const project = projects.find((p) => p.id === starter.startedIn);
  if (!project) return { projectId: null, folderPath: null };
  return { projectId: project.id, folderPath: folderOf(project, starter.folderId)?.path ?? project.folders[0]?.path ?? null };
}

export interface SessionServers {
  mcpServers: Record<string, McpConfig>;
  /** Kestrel's own servers among them, for the header. */
  handed: HandedServer[];
}

/** The servers a session starts with, values included: for the agent's configuration only. */
export async function sessionServers(workspace: Pick<Workspace, 'state' | 'projectSetup' | 'defaultSetup'>, store: McpServerStore | null, sessionId: string, own: { project: Project | null; folder: ProjectFolder | null }, discover: (projectPath: string | null) => DiscoveredServer[]): Promise<SessionServers> {
  const state = await workspace.state();
  const source = serverSource(sessionId, own, state.sessions, state.projects, state.links);
  const setup: ProjectSetup = source.projectId ? (await workspace.projectSetup(source.projectId)).setup : await workspace.defaultSetup();
  const found = enabledServers(setup, discover(source.folderPath));
  return store ? store.forSession(setup.mcpServers, source.projectId, found) : { mcpServers: found, handed: [] };
}
