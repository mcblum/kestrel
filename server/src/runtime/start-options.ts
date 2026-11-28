// How an agent is started or resumed, kept out of runtime.ts: the options it gets (where it works,
// what it may do, the tools and instruction Kestrel gives it), the one-editor rule for plain
// folders, and what a restart does to sessions that were running.
import type { WhoDoesWhat } from '../shared/who-does-what.ts';
import type { KnowledgeBrief } from '../knowledge/service.ts';
import { kestrelToolName } from '../agents/claude/map.ts';
import { standingInstruction, type InstructionContext } from '../agents/instruction.ts';
import type { InputRequest, StartOptions } from '../agents/types.ts';
import { userMcpServers } from '../claude-config.ts';
import { sessionServers } from '../mcp-servers/session.ts';
import type { McpServerStore } from '../mcp-servers/store.ts';
import type { DiscoveredServer } from '../shared/setup.ts';
import type { ChildOrigin } from '../delegation.ts';
import type { Project, ProjectFolder, Session, SessionSettings } from '../model.ts';
import { folderName, repositoryLabel, resolveStartedFolder } from '../shared/project-folders.ts';
import type { NotClonedRow } from '../shared/project-clone.ts';
import { mostUsedTags } from '../shared/tags.ts';
import { turnUnderWay } from '../shared/turns.ts';
import { CUT_OFF_STEP, cutOffNews, survives } from '../shared/waiting-steps.ts';
import { startLinkOf } from '../tree.ts';
import { Refused, type Workspace } from '../workspace.ts';
import type { Live } from './record.ts';

export interface StartRequestParts {
  sessionId: string;
  directory: string;
  branch: string | null;
  project: Project | null;
  /** The project's directory it works in; null with no project or none yet (it works in scratch then). */
  folder: ProjectFolder | null;
  settings: SessionSettings;
  origin?: ChildOrigin;
  /** The Kestrel tools this session gets (delegation, display, suggestions, browser, simulator). */
  tools: StartOptions['tools'];
  browserElement: StartOptions['browserElement'];
  /** The user's "Who does what" table, for the standing instruction (shared/who-does-what.ts). */
  who?: WhoDoesWhat;
  /** The knowledge base in use, as this session is told of it (knowledge/service.ts `briefFor`); absent or null: none. */
  knowledge?: KnowledgeBrief | null;
  /** The session's attachments folder (attachments/store.ts): always readable. */
  attachmentsDir?: string;
  /** Kestrel's own list of MCP servers (mcp-servers/); absent: only the servers found in the agents' files. */
  mcpServers?: McpServerStore | null;
  /** Reads the servers in the agents' own files; tests pass a stand-in. */
  discover?: (projectPath: string | null) => DiscoveredServer[];
  /** On a worker node, the account's projects it has not cloned (shared/project-clone.ts `notClonedRows`); absent in the app. */
  notCloned?: readonly NotClonedRow[];
  /** A worker node that pushes each session's branch when a turn ends (runtime/node-push.ts). */
  nodePushes?: boolean;
}

/** Options for an agent: where it works, what it may do, and the tools and instruction Kestrel gives it. */
export async function agentStartOptions(workspace: Workspace, req: StartRequestParts): Promise<StartOptions> {
  const { sessionId, directory, branch, project, folder, settings, origin } = req;
  const state = await workspace.state();
  const projects = state.projects.map((p) => ({ name: p.name, folders: p.folders.map((f) => ({ id: f.id, path: f.path, isGit: f.isGit })), defaultFolderId: p.defaultFolderId ?? null }));
  const everyFolder = state.projects.flatMap((p) => p.folders.map((f) => f.path));
  // The project's other directories: readable, and editable under the session's mode like any path outside its folder.
  const siblings = project && folder ? project.folders.filter((f) => f.id !== folder.id) : [];
  const readOnly = settings.permission === 'readonly';
  const workspaceKind: InstructionContext['workspace'] = readOnly ? { kind: 'read-only', noProject: folder === null } : folder === null ? { kind: 'scratch' } : branch ? { kind: 'worktree', branch } : { kind: 'folder' };
  // A session another session started (handoff or delegate) is confined and told so. A fork is not.
  const link = startLinkOf(sessionId, state.links);
  // The user's own Claude Code setup: their instructions and skills, from the project's own setup or
  // the defaults. A session with no project uses the defaults. Its MCP servers, Kestrel's and those
  // found in the agents' files, follow mcp-servers/session.ts: a child gets its starter's, a review of
  // somebody else's pull request the default set.
  const { setup: chosen } = await workspace.projectSetup(project?.id ?? null);
  const servers = await sessionServers(workspace, req.mcpServers ?? null, sessionId, { project, folder }, req.discover ?? userMcpServers);
  const setup = { loadSettings: chosen.loadSettings, inProject: folder !== null, mcpServers: servers.mcpServers, ...(servers.handed.length ? { kestrelServers: servers.handed } : {}) };
  return {
    directory,
    setup,
    model: settings.model || undefined,
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.fast !== undefined ? { fast: settings.fast } : {}),
    tools: req.tools,
    browserElement: req.browserElement,
    permission: settings.permission,
    // A session another session started is held to its own folder, commands included.
    ...(origin ?? link?.kind ? { confineShell: true } : {}),
    // A session with no directory works in a scratch folder and may read every registered project;
    // one in a project with several directories may read the others.
    // Every session may read the files the user attached to its messages.
    readableDirectories: readableFor(readOnly || folder === null ? everyFolder : siblings.map((f) => f.path), req.attachmentsDir),
    instruction: standingInstruction({
      toolName: kestrelToolName,
      projects,
      ...(req.notCloned ? { notCloned: req.notCloned } : {}),
      ...(req.nodePushes ? { nodePushes: true } : {}),
      workspace: workspaceKind,
      origin: origin ?? link?.kind,
      ...(req.who ? { who: req.who } : {}),
      ...(req.knowledge ? { knowledge: req.knowledge } : {}),
      // Most used first: the instruction lists only the first few.
      existingTags: mostUsedTags(state.sessions),
      ...(project && siblings.length ? { siblings: { project: project.name, folders: siblings.map((f) => ({ name: folderName(f), path: f.path })) } } : {}),
    }),
  };
}

/** The folders a session may read besides its own; undefined when there are none. */
function readableFor(folders: string[], attachmentsDir: string | undefined): string[] | undefined {
  const all = attachmentsDir ? [...folders, attachmentsDir] : folders;
  return all.length ? all : undefined;
}

/** A plain directory has no worktree, so two editing sessions in it would trample each other. */
export function assertPlainFolderFree(project: Project, folder: ProjectFolder, sessions: readonly Session[], recordOf: (id: string) => Live | undefined, except?: string): void {
  if (folder.isGit) return;
  for (const s of sessions) {
    if (s.startedIn !== project.id || s.id === except || resolveStartedFolder(project, s)?.id !== folder.id) continue;
    const rec = recordOf(s.id);
    if (rec?.handle?.busy() || rec?.pendingInput.size) throw new Refused(`${repositoryLabel(project, folder)} is a plain folder and "${s.title}" is already editing it. Plain folders allow one editing session at a time; wait for it or stop it.`);
  }
}

/**
 * What an agent is told, with its next turn, about a request the restart left unanswered. Kestrel
 * cannot ask it again: the tool call that was waiting died with the agent's process.
 */
export function lostRequestNews(request: Pick<InputRequest, 'kind' | 'title' | 'tool'>): string {
  if (request.kind === 'question') return `[Kestrel] Kestrel restarted while you were waiting for the user's answer to your question "${request.title}". It was never answered. Ask it again if you still need the answer.`;
  const tool = request.tool ? ` (${request.tool})` : '';
  return `[Kestrel] Kestrel restarted while you were waiting for the user's answer to "${request.title}"${tool}. It was never answered and that action did not run. Ask again if you still need it.`;
}

const CUT_OFF_NEWS = '[Kestrel] Kestrel restarted while you were working, so your last turn was cut off. Check what you had finished before you carry on.';

/** What a session hears when a session it asked for work (`ask_session`) was cut off by a restart. */
export const askCutOffNews = (title: string, id: string): string =>
  `[Kestrel] The session "${title}" (${id}) that you asked was cut off when Kestrel restarted, before it finished the turn you asked it for. The user has to reply to it to resume it; you cannot answer for it. Check its work before relying on it.`;

/**
 * After a restart no agent process exists: running sessions are interrupted and open prompts
 * abandoned. Each agent hears what it lost with its next turn (the stored inbox). One of Kestrel's
 * own cards from a turn that had ended, whose step is stored as waiting, stays open and is taken up
 * when answered (runtime/turns.ts `answerStoredStep`); the session comes back as needing the user.
 * A step found being carried out was cut off part way: its card is closed and it is never run again.
 */
export async function interruptAfterRestart(workspace: Workspace): Promise<number> {
  const state = await workspace.state();
  let n = 0;
  for (const s of state.sessions) {
    if (s.state !== 'running' && s.state !== 'attention') continue;
    const stored = await workspace.storedDetail(s.id);
    if (!stored || stored.agentSessionId === undefined) continue; // fake data, not a real session
    const ended = s.state === 'attention' && !turnUnderWay(stored.messages);
    const steps = stored.steps ?? [];
    const open = stored.messages.flatMap((m) => (m.input && !m.input.resolved ? [m.input] : []));
    // Waiting on the user with its turn done and no card a restart would close (a review's findings,
    // a failure): nothing was lost, so it stays as it was, card, note and all (Matt, 2026-11-24).
    if (ended && open.length === 0) continue;
    const kept = new Set(ended ? open.filter((i) => i.kestrel === true && survives(steps, i.id)).map((i) => i.id) : []);
    const cutOff = new Set(open.filter((i) => i.kestrel === true && steps.some((st) => st.requestId === i.id && st.status === 'taking')).map((i) => i.id));
    const closing = (id: string): string => (cutOff.has(id) ? CUT_OFF_STEP : 'Interrupted by restart');
    const messages = stored.messages.map((m) => (m.input && !m.input.resolved && !kept.has(m.input.id) ? { ...m, input: { ...m.input, resolved: closing(m.input.id) } } : { ...m, streaming: false }));
    const lost = open.flatMap((i) => (kept.has(i.id) ? [] : [cutOff.has(i.id) ? cutOffNews({ tool: i.tool ?? '', title: i.title, detail: i.detail ?? '' }) : lostRequestNews(i)]));
    const news = lost.length ? lost : s.state === 'running' ? [CUT_OFF_NEWS] : [];
    await workspace.setDetail(s.id, { messages, steps: steps.filter((st) => kept.has(st.requestId)), ...(news.length ? { inbox: [...(stored.inbox ?? []), ...news] } : {}), askers: [] });
    // Its cards are still there to answer: it needs the user, as before the restart.
    const first = open.find((i) => kept.has(i.id));
    if (first) {
      await workspace.setState(s.id, 'attention', `Needs you · ${first.title}`);
      continue;
    }
    // Whoever asked it for work (`ask_session`) is waiting to hear how that turn ended: it did not.
    for (const askerId of stored.askers ?? []) {
      const asker = await workspace.storedDetail(askerId);
      if (asker) await workspace.setDetail(askerId, { inbox: [...(asker.inbox ?? []), askCutOffNews(s.title, s.id)] });
    }
    await workspace.setState(s.id, 'interrupted', 'Interrupted · server restarted. Reply to resume.');
    n++;
  }
  return n;
}
