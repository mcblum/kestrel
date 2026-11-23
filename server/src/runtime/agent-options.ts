// The options a session's agent runs with (runtime/start-options.ts builds the common part): where
// it works, its Kestrel tools, its sandbox and signing access, and the check every file edit passes
// first (`editVerdict`). Moved out of runtime.ts as it was (0.0.18).
import { guestEditRefusal, hostEditRefusal } from '../shared/worktree-guests.ts';
import { hostSandboxSupport } from '../agents/claude/sandbox-support.ts';
import { resolveEnv } from '../project-env/resolve.ts';
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveReal } from '../agents/claude/confine.ts';
import { kestrelToolName } from '../agents/claude/map.ts';
import type { Intercept, StartOptions, ToolAction } from '../agents/types.ts';
import type { ChildOrigin } from '../delegation.ts';
import type { Project, ProjectFolder, Session, SessionSettings } from '../model.ts';
import { folderOf } from '../shared/project-folders.ts';
import { PROTECTED_FILE_NAMES, protectedRefusal } from '../shared/protected-files.ts';
import { otherProjectHolding, otherProjectRefusal, otherWorktreeHolding, otherWorktreeRefusal, within } from '../shared/project-edits.ts';
import { Refused } from '../workspace.ts';
import type { RuntimeHost } from './host.ts';
import type { Live } from './record.ts';
import { agentStartOptions } from './start-options.ts';

/** The file tools whose target is checked before an edit (Claude's names; Codex's changes are asked as Edit). */
const EDIT_PATH_KEYS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

export type OptionsHost = Pick<RuntimeHost, 'workspace' | 'dataDir' | 'browser' | 'attachments' | 'sandboxAllow' | 'commitSigning' | 'projectEdits' | 'projectEnv' | 'whoDoesWhat' | 'records' | 'mcpAccess' | 'toolHost' | 'checkPlainFolderFree'>;

/**
 * The options an existing session's agent runs with: where it works, its project, its settings.
 * `forTurn`: a turn will run, so a plain folder must not be in use by another session.
 */
export async function optionsFor(host: OptionsHost, session: Session, rec: Live, forTurn = true): Promise<StartOptions> {
  const state = await host.workspace.state();
  const project = state.projects.find((p) => p.id === session.startedIn) ?? null;
  const source = project ? folderOf(project, state.sessions.find((s) => s.id === session.id)?.folderId) : null;
  if (session.worktreeDiscarded) throw new Refused(`The worktree of "${session.title}" was discarded, so it cannot continue. Start a new session for more work.`);
  if (session.worktreePath && !existsSync(session.worktreePath)) throw new Refused(`The worktree ${session.worktreePath} is gone, so this session cannot resume.`);
  // A guest works in its host's worktree (shared/worktree-guests.ts); when that is gone it cannot go on.
  const hostSession = rec.guest ? state.sessions.find((s) => s.id === rec.guest!.hostId) : undefined;
  if (rec.guest && (!hostSession?.worktreePath || hostSession.worktreeDiscarded || !existsSync(hostSession.worktreePath))) throw new Refused(`"${session.title}" worked in another session's worktree, which is gone, so it cannot continue.`);
  const directory = hostSession?.worktreePath ?? session.worktreePath ?? source?.path ?? join(host.dataDir, 'scratch');
  if (forTurn && project && source && !source.isGit) host.checkPlainFolderFree(project, source, state.sessions, session.id);
  // A spawned session has no link to say another session started it: its record does.
  const options = await startOptions(host, session.id, directory, hostSession?.branch ?? session.branch, project, source, rec.settings, rec.spawned ? 'spawn' : undefined);
  // "Allow all outside the sandbox", once chosen in this session, holds for as long as the session does.
  return rec.outsideAllowed ? { ...options, outsideAllowed: true } : options;
}

/** Options for an agent (runtime/start-options.ts), with this session's Kestrel tools. */
export async function startOptions(host: OptionsHost, sessionId: string, directory: string, branch: string | null, project: Project | null, folder: ProjectFolder | null, settings: SessionSettings, origin?: ChildOrigin): Promise<StartOptions> {
  const tools = host.toolHost(sessionId);
  const options = await agentStartOptions(host.workspace, { sessionId, directory, branch, project, folder, settings, origin, tools, browserElement: (ref) => host.browser.elementName(sessionId, ref), attachmentsDir: host.attachments.readableDir(sessionId), who: await host.whoDoesWhat.current() });
  await host.sandboxAllow.entries();
  const signing = options.confineShell ? await host.commitSigning.accessFor(directory) : undefined;
  const { env } = await resolveEnv(await host.projectEnv.all(), project?.id ?? null, folder?.path ?? null);
  // A confined session never reaches Kestrel's own credential store (shared/protected-files.ts).
  const secrets = options.confineShell ? protectedPaths(host.dataDir) : [];
  const intercept = async (action: ToolAction): Promise<Intercept> => {
    const refusal = protectedRefusal(action, secrets, (path) => resolveReal(path, directory), sep);
    return refusal ? { allow: false, message: refusal } : editVerdict(host, sessionId, project?.id ?? null, directory, action);
  };
  const guarded: StartOptions = { ...options, ...(Object.keys(env).length > 0 ? { env } : {}), ...(secrets.length ? { protectedFiles: secrets } : {}), intercept, sandboxAllow: host.sandboxAllow.access(), ...(signing ? { commitSigning: signing } : {}), ...(options.confineShell ? { sandboxSupport: hostSandboxSupport() } : {}) };
  const mcpAccess = host.mcpAccess();
  return mcpAccess ? { ...guarded, kestrelMcp: mcpAccess(sessionId) } : guarded;
}

/** Kestrel's credential files in its data folder, by every spelling a path to them resolves to. */
export function protectedPaths(dataDir: string): string[] {
  const dirs = [...new Set([dataDir, existsSync(dataDir) ? realpathSync(dataDir) : dataDir])];
  return dirs.flatMap((dir) => PROTECTED_FILE_NAMES.map((name) => join(dir, name)));
}

/**
 * Whether a file edit may go ahead: refused, with what to do instead, when the file is inside
 * another session's worktree or another registered project and the user has not switched the
 * rule off (shared/project-edits.ts).
 * Asked by each adapter before an edit runs, in every permission mode. Only file tools carry a
 * path; a shell command cannot be checked this way.
 */
export async function editVerdict(host: Pick<RuntimeHost, 'workspace' | 'projectEdits' | 'records'>, sessionId: string, ownProjectId: string | null, directory: string, action: ToolAction): Promise<Intercept> {
  const key = EDIT_PATH_KEYS[action.tool];
  const target = key ? action.input[key] : undefined;
  if (typeof target !== 'string' || !target) return { allow: true };
  const path = resolveReal(target, directory);
  const state = await host.workspace.state();
  // One session writes in a worktree at a time (shared/worktree-guests.ts). This holds whatever the setting below says.
  const turn = worktreeTurn(host, state.sessions, sessionId, path);
  if (turn) return turn;
  if (!(await host.projectEdits.prefs()).keepInProject) return { allow: true };
  // Another session's worktree comes first: it is nobody's to change but that session's.
  const owner = otherWorktreeHolding(path, state.sessions.filter((s) => s.id !== host.records.get(sessionId)?.guest?.hostId).map((s) => ({ id: s.id, title: s.title, worktreePath: s.worktreePath ? resolveReal(s.worktreePath, s.worktreePath) : null })), sessionId);
  if (owner) return { allow: false, message: otherWorktreeRefusal(path, owner, kestrelToolName('ask_session')) };
  const projects = state.projects.map((p) => ({ id: p.id, name: p.name, folders: p.folders.map((f) => ({ path: resolveReal(f.path, f.path) })) }));
  const other = otherProjectHolding(path, projects, ownProjectId);
  return other ? { allow: false, message: otherProjectRefusal(path, other.name, kestrelToolName('delegate')) } : { allow: true };
}

/**
 * Whose turn it is to write in a shared worktree, for an edit to `path`: a reviewing guest never
 * writes there, a writing guest does (allowed here, ahead of the other-worktree rule), and the host
 * does not while a writing guest of its is at work. Null when the edit is no such case.
 */
function worktreeTurn(host: Pick<RuntimeHost, 'records'>, sessions: readonly Session[], sessionId: string, path: string): Intercept | null {
  const inside = (worktree: string | null): boolean => worktree !== null && within(path, resolveReal(worktree, worktree));
  const guest = host.records.get(sessionId)?.guest;
  if (guest) {
    const hostSession = sessions.find((s) => s.id === guest.hostId);
    if (!hostSession || !inside(hostSession.worktreePath)) return null;
    const refusal = guestEditRefusal(guest, path);
    return refusal ? { allow: false, message: refusal } : null;
  }
  const own = sessions.find((s) => s.id === sessionId);
  if (!own || !inside(own.worktreePath)) return null;
  const writer = sessions.find((s) => s.state === 'running' && host.records.get(s.id)?.guest?.hostId === sessionId && host.records.get(s.id)!.guest!.writes);
  return writer ? { allow: false, message: hostEditRefusal(path, { title: writer.title, id: writer.id, role: host.records.get(writer.id)!.guest!.role }) } : null;
}
