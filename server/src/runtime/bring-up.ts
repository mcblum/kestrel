// Bringing a session's agent up: a new session (`startSession`), a child one (`launchChild`), one
// stopped before its agent started (`restartUnstarted`), and one that predates this server run
// (`loadRecord`, then `reattach`). The order of what happens is what the tests and the UI rely on:
// the row and the first message first, then the working folder, then the agent. Moved out of
// runtime.ts as it was (0.0.18).
import { sanitizeGuest, sanitizeReview, type Guest } from '../shared/worktree-guests.ts';
import { sanitizeRoleRun, type RoleRun } from '../shared/who-does-what.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { failureKind, type AgentAdapter, type AgentHandle } from '../agents/types.ts';
import type { DraftRefs } from '../attachments/store.ts';
import type { ChildOrigin } from '../delegation.ts';
import { baseOf, type WorktreeStart } from '../git.ts';
import type { ReviewMark } from '../shared/review-requests.ts';
import { AGENT_LABEL, type Agent, type Project, type ProjectFolder, type Session, type SessionSettings } from '../model.ts';
import { attachmentsLabel } from '../shared/attachments.ts';
import { readUsage } from '../shared/details.ts';
import { effectiveBase, type BaseChoice } from '../shared/start-base.ts';
import { childPermission, DEFAULT_PERMISSION, type PermissionLevel } from '../shared/permissions.ts';
import { afterTurn, EMPTY_QUEUE, type OutgoingPart } from '../shared/queue.ts';
import { titleFrom } from '../title.ts';
import { Refused } from '../workspace.ts';
import { ACTIVITY, type RuntimeHost } from './host.ts';
import { chosenFolder } from './projects.ts';
import { copiedNotice, copyIntoWorktree, resolveEnv } from '../project-env/resolve.ts';
import { runSetup, SetupFailed } from './project-scripts.ts';
import { newRecord, type Live } from './record.ts';
import { Abandoned, prepareWorkdir, type Launch } from './workdir.ts';

export interface StartRequest {
  agent: Agent;
  projectId: string | null;
  /** Which of the project's directories; its default when absent. */
  folderId?: string | null;
  prompt: string;
  model?: string;
  permission?: PermissionLevel;
  /** Reasoning effort and fast mode (SessionSettings); absent leaves them to the model. */
  effort?: string;
  fast?: boolean;
  /** The user picked the agent, model, effort or fast mode for this session themselves, not what new sessions start with: it keeps them when it leads. */
  modelChosen?: boolean;
  groupId?: string | null;
  /** Files attached to the first message, uploaded to this draft (attachments/store.ts). */
  draft?: DraftRefs | null;
  /** Where the worktree starts, as the user answered in the New session box; the project's remembered answer, else as today, when absent. */
  base?: BaseChoice;
  /** Remember `base` for the project, so it is not asked again. */
  rememberBase?: boolean;
  /** The session's title, given: none is generated, and its branch is named from this one. */
  title?: string;
  /** The commit its worktree starts at, and its base, when that is not the project's HEAD (a review: review-requests/start.ts). */
  start?: WorktreeStart;
  /** A review of somebody else's request (shared/review-requests.ts). */
  review?: ReviewMark;
}

export type BringUpHost = Pick<
  RuntimeHost,
  'workspace' | 'adapters' | 'dataDir' | 'records' | 'agents' | 'upkeep' | 'commands' | 'attachments' | 'delegation' | 'titler' | 'gitPrefs' | 'baseRefresh' | 'startBase' | 'projectScripts' | 'projectEnv' | 'gitDefaults' | 'apply' | 'queue' | 'notice' | 'onEvent' | 'endRunning' | 'idle' | 'scratch' | 'checkPlainFolderFree' | 'optionsFor' | 'startOptions'
>;

/**
 * A new session. Its row is stored first, so it shows at once; in a git project the rest (its
 * title, its worktree and branch named from it, the agent) follows in the background, and a
 * failure there leaves the session failed with the reason. Elsewhere the agent is started before
 * this returns, and a failure to start it is thrown too.
 */
export async function startSession(host: BringUpHost, req: StartRequest): Promise<Session> {
  const adapter = host.adapters[req.agent];
  if (!adapter) throw new Refused(`${AGENT_LABEL[req.agent]} is not available in Kestrel. Pick another agent.`);
  const prompt = req.prompt.trim();
  if (!prompt && !req.draft?.ids.length) throw new Refused('Describe the task first.');
  const state = await host.workspace.state();
  const project = req.projectId ? (state.projects.find((p) => p.id === req.projectId) ?? null) : null;
  if (req.projectId && !project) throw new Refused(`No such project: ${req.projectId}`);
  const source = project ? chosenFolder(project, req.folderId) : null;
  if (project && source) host.checkPlainFolderFree(project, source, state.sessions);
  if (source && !existsSync(source.path)) throw new Refused(`${source.path} no longer exists. Remove it from ${project!.name} and add it again.`);
  // A project with no directory yet works like no project at all: a scratch folder, no worktree.
  const folder = source?.path ?? host.scratch();

  if (project && req.base && req.rememberBase) await host.startBase.remember(project.id, req.base);
  const base = project ? effectiveBase(req.base, await host.startBase.remembered(project.id), 'current') : undefined;
  const id = randomUUID();
  const attachments = host.attachments.claim(id, req.draft);
  const title = req.title ?? titleFrom(prompt || attachmentsLabel(attachments)); // files alone: titled by their names
  const session = await host.workspace.addSession({ id, title, agent: req.agent, startedIn: project?.id ?? null, startedFolderId: source?.id ?? null, groupId: req.groupId ?? null, state: 'running', note: 'Starting…', ...(req.review ? { review: req.review } : {}) });
  const settings: SessionSettings = { model: req.model ?? '', permission: req.permission ?? DEFAULT_PERMISSION, ...(req.effort ? { effort: req.effort } : {}), ...(req.fast !== undefined ? { fast: req.fast } : {}) };
  const rec = newRecord({ settings, modelChosen: req.modelChosen === true }, null);
  host.records.set(id, rec);
  host.apply(id, rec, { type: 'user', id: `user-${randomUUID()}`, text: prompt, attachments });
  host.queue(rec, () => host.upkeep.persist(id, rec));
  const launch: Launch = { agent: req.agent, project, source, folder, prompt, attachments, title, generateTitle: req.title === undefined, settings, ...(base ? { base } : {}), ...(req.start ? { start: req.start } : {}) };
  if (source?.isGit) {
    launchInBackground(host, id, rec, launch);
    return session;
  }
  const failed = await bringUp(host, id, rec, adapter, launch);
  if (failed) {
    await host.idle(id);
    throw new Refused(`The session was created but the agent could not be started: ${failed}`);
  }
  return session;
}

/**
 * The rest of starting a session whose row exists: its working folder (runtime/workdir.ts) and its
 * agent. A failure leaves the session failed with the reason, which is also returned (null when
 * it started).
 */
async function bringUp(host: BringUpHost, id: string, rec: Live, adapter: AgentAdapter | undefined, launch: Launch, signal?: AbortSignal): Promise<string | null> {
  const { project, source, prompt, settings } = launch;
  let where = launch.workdir;
  try {
    if (!adapter) throw new Refused(`${AGENT_LABEL[launch.agent]} is not available in Kestrel.`);
    if (source && !existsSync(source.path)) throw new Refused(`${source.path} no longer exists. Remove it from ${project?.name ?? 'the project'} and add it again.`);
    where ??= await prepareWorkdir(
      { titler: host.titler, workspace: host.workspace, worktreesDir: join(host.dataDir, 'worktrees'), branchPrefix: () => host.gitPrefs.prefixForNewBranch(), freshStart: async (repo) => (launch.start ? { start: launch.start, notice: null } : launch.base === 'default' ? host.baseRefresh.startFromDefault(repo, await host.gitDefaults.of(project?.id)) : host.baseRefresh.startFor(repo)), notice: (n) => host.notice(id, n.text, n.level) },
      { sessionId: id, agent: launch.agent, prompt: prompt || attachmentsLabel(launch.attachments ?? []), title: launch.title, generate: launch.generateTitle, repo: source?.isGit ? source.path : null, folder: launch.folder, signal },
    );
    rec.base = where.base;
    // A new worktree gets the project's untracked files first, so the setup script and the agent find them.
    const envSettings = await host.projectEnv.all();
    if (project && source && where.branch && !where.setupDone) {
      const files = await copyIntoWorktree(envSettings, project.id, source.path, where.directory);
      const copied = copiedNotice(files.copied);
      if (copied) host.notice(id, copied, 'info');
      files.problems.forEach((problem) => host.notice(id, problem, 'warning'));
    }
    const environment = await resolveEnv(envSettings, project?.id ?? null, source?.path ?? null);
    if (!where.setupDone) environment.problems.forEach((problem) => host.notice(id, problem, 'warning'));
    const setup = await runSetup(host.projectScripts, { sessionId: id, project, source, where, signal, env: environment.env, emit: (event) => host.onEvent(id, rec, event) });
    if (setup?.status === 'stopped') throw new Abandoned();
    if (setup && setup.status !== 'ok') throw new SetupFailed(setup);
    where = { ...where, setupDone: true };
    const options = await host.startOptions(id, where.directory, where.branch, project, source, settings, launch.origin);
    if (signal?.aborted) throw new Abandoned();
    rec.launching = null;
    host.agents.set(id, launch.agent);
    rec.handle = adapter.start(options, prompt, (event) => host.onEvent(id, rec, event), host.attachments.forAgent(id, launch.attachments));
    return null;
  } catch (error) {
    rec.launching = null;
    if (signal?.aborted) {
      // Stopped while starting: no agent, and the session ends as a stopped turn does. A worktree
      // already made stays on the row (deleting the session removes it); a reply starts the agent there.
      rec.unstarted = { ...launch, workdir: where };
      host.onEvent(id, rec, { type: 'done', reason: 'stopped' });
      return null;
    }
    // The row is already stored: do not leave it "Starting…" forever.
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof SetupFailed) {
      // Its worktree stays, with no agent yet: a reply runs the script again there.
      rec.unstarted = { ...launch, workdir: where };
      host.onEvent(id, rec, { type: 'failed', reason, kind: 'other' });
      return reason;
    }
    host.onEvent(id, rec, { type: 'failed', reason: `The agent could not be started: ${reason}`, kind: failureKind(error) });
    return reason;
  }
}

/** `bringUp` in the background, for a session that gets a worktree; Stop abandons it meanwhile (`stop`). */
function launchInBackground(host: BringUpHost, id: string, rec: Live, launch: Launch): void {
  const abort = new AbortController();
  rec.launchAbort = abort;
  rec.launching = bringUp(host, id, rec, host.adapters[launch.agent], launch, abort.signal).then(() => {
    rec.launching = null;
    rec.launchAbort = null;
  });
}

/** A reply to a session stopped before its agent started: start it now, with its first prompt and the reply. */
export async function restartUnstarted(host: BringUpHost, session: Session, rec: Live, parts: OutgoingPart[]): Promise<void> {
  const launch = rec.unstarted!;
  rec.unstarted = null;
  rec.stopped = false;
  parts.forEach((part) => host.apply(session.id, rec, { type: 'user', id: `user-${randomUUID()}`, ...part }));
  await host.workspace.setState(session.id, 'running', 'Starting…', { ...ACTIVITY, byUser: rec.turnByUser });
  host.delegation.onSessionRunning(session.id);
  launchInBackground(host, session.id, rec, { ...launch, prompt: [launch.prompt, ...parts.map((p) => p.text)].filter(Boolean).join('\n\n'), attachments: [...(launch.attachments ?? []), ...parts.flatMap((p) => p.attachments ?? [])], title: session.title, generateTitle: false, settings: rec.settings });
}

/**
 * Start the agent for a child session whose row already exists (handoff, delegate, spawn): its own
 * worktree (or the plain folder), its parent's level but never Bypass (`childPermission`), and the
 * brief as its first message. Failure is returned, not thrown, so the caller's tool can tell its
 * agent plainly.
 */
export async function launchChild(host: BringUpHost, child: Session, project: Project, source: ProjectFolder | null, prompt: string, origin: ChildOrigin, model: string, parentPermission: PermissionLevel | undefined, speed: Pick<SessionSettings, 'effort' | 'fast'> = {}, hosted?: { guest: Guest; host: Pick<Session, 'worktreePath' | 'branch'> }, roleRun: RoleRun | null = null): Promise<{ ok: true } | { ok: false; reason: string }> {
  // `speed`: the effort and fast mode of the role's preset, when the child was started for a role (shared/who-does-what.ts).
  const settings: SessionSettings = { model, permission: childPermission(parentPermission), ...(speed.effort ? { effort: speed.effort } : {}), ...(speed.fast ? { fast: true } : {}) };
  const rec = newRecord({ settings, spawned: origin === 'spawn', guest: hosted?.guest ?? null, roleRun }, null);
  host.records.set(child.id, rec);
  host.apply(child.id, rec, { type: 'user', id: `user-${randomUUID()}`, text: prompt });
  // Nobody is there to ask where it starts: the project's remembered answer, else the default branch.
  const base = effectiveBase(undefined, await host.startBase.remembered(project.id), 'default');
  // Only a title that fell back to the brief is generated: an explicit one is kept.
  const failed = await bringUp(host, child.id, rec, host.adapters[child.agent], { agent: child.agent, project, source, folder: source?.path ?? host.scratch(), prompt, title: child.title, generateTitle: child.title === titleFrom(prompt), settings, origin, base,
    // A guest has no worktree of its own: it works in its host's, which is already made and set up (shared/worktree-guests.ts).
    ...(hosted?.host.worktreePath ? { workdir: { directory: hosted.host.worktreePath, branch: hosted.host.branch, base: null, setupDone: true } } : {}) });
  if (failed) {
    await host.idle(child.id);
    return { ok: false, reason: `The agent could not be started: ${failed}` };
  }
  host.queue(rec, () => host.upkeep.persist(child.id, rec));
  return { ok: true };
}

/** The live record of a session that predates this server run, loaded from storage; null when it never got an agent. */
export async function loadRecord(host: Pick<RuntimeHost, 'workspace' | 'records' | 'commands'>, session: Session): Promise<Live | null> {
  const stored = await host.workspace.storedDetail(session.id);
  if (!stored || stored.agentSessionId === undefined) return null;
  const base = session.worktreePath && session.branch ? await baseOf(session.worktreePath, session.branch) : null;
  const rec = newRecord({ messages: stored.messages, files: stored.files, agentOutput: stored.agentOutput, kestrelTools: stored.kestrelTools, kestrelMissing: stored.kestrelMissing ?? [], agentSessionId: stored.agentSessionId, settings: stored.settings ?? { model: '', permission: session.startedIn ? DEFAULT_PERMISSION : 'readonly' }, usage: readUsage(stored.usage),
    // Queued before the server last stopped: the turn they waited for is gone, so they wait for the user.
    queue: afterTurn(stored.queue ?? EMPTY_QUEUE, 'stopped') }, base);
  // News that was waiting for its next turn when the server last stopped still is.
  rec.inbox = [...(stored.inbox ?? [])];
  rec.spawned = stored.spawned === true;
  rec.guest = sanitizeGuest(stored.guest);
  rec.review = sanitizeReview(stored.review);
  rec.roleRun = sanitizeRoleRun(stored.roleRun);
  rec.modelChosen = stored.modelChosen === true;
  rec.askers = [...(stored.askers ?? [])];
  rec.outsideAllowed = stored.outsideAllowed === true;
  // The commands its agent listed are offered again before it next runs.
  rec.slashCommands = stored.slashCommands ?? [];
  // So is what its agent ran: the Commands pane shows it again, anything that was running as stopped.
  host.commands.restore(session.id, stored.commands);
  host.records.set(session.id, rec);
  return rec;
}

/** A new agent process for a session that has none, resuming its agent's own conversation. */
export async function reattach(host: BringUpHost, session: Session, rec: Live): Promise<AgentHandle> {
  const adapter = host.adapters[session.agent];
  if (!adapter) throw new Refused(`${AGENT_LABEL[session.agent]} is not available in Kestrel, so this session cannot continue.`);
  if (!rec.agentSessionId) throw new Refused('This session never got far enough to be resumed. Start a new one.');
  const options = await host.optionsFor(session, rec);
  // A new agent process: nothing an earlier one left running is listed any more.
  host.endRunning(session.id);
  host.agents.set(session.id, session.agent);
  return adapter.resume(rec.agentSessionId, options, (event) => host.onEvent(session.id, rec, event));
}
