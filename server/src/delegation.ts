// handoff, delegate, spawn, add_project, session_status, complete_workstream and wait_for: what Kestrel's tools do, and how a session
// that delegates hears back. The tool handlers (agents/claude/tools.ts) only translate; the
// rules are here. Everything an agent is told is plain text; a refusal never throws at it.
import { reviewComment, sameAgentNote, clipSummary, findingsText, handOverAgainText, guestIntro, guestWrites, handBackText, nextRoundText, REVIEW_ROUNDS, reviewBrief, reviewEndNotice, verdictOf, writerRefusal, type Guest, type Review } from './shared/worktree-guests.ts';
import { originUrl } from './git.ts';
import { hostTerms } from './shared/host-terms.ts';
import { ALREADY_A_REVIEW, CONVERT_DECLINED, convertAsk, converted, noProjectFor, NOT_A_REQUEST, NOT_FIRST_MESSAGE, parseRequestRef, requestHome } from './review-requests/convert.ts';
import { cannotRunNow, fallbackAsk, fallbackNotice, fallbackTold, modeOfRole, nextRunner, noFallbackLeft, noReviewerReason, NOT_CONNECTED, orchestrateMove, orchestrateNotice, orchestratorsOf, pickReviewer, presetForRole, presetSummary, reviewersOf, ROLE_LABEL, ROLES, runnersOf, takeoverIntro, whenUnavailable, type Author, type ModelPreset, type Role, type RoleRun, type WhoDoesWhat } from './shared/who-does-what.ts';
import { HANDOFF_ARCHIVE_DECLINED, handedOffReason, handoffArchiveAsk, MOVE_DECLINED, moveApproved, moveAsk, movedNotice, movedQuietly, movedTold, moveFailed, projectWorkedIn } from './shared/session-move.ts';
import { ALREADY_ARCHIVED, ARCHIVE_DECLINED, ARCHIVE_REASON_MAX, ARCHIVE_SESSION_KIND, archivedTold, archiveScope, archiveSessionAsk, NOT_STOPPED, notArchivedSelf, selfArchiveLater } from './shared/session-archive.ts';
import { MOVE_KIND } from './suggestions/move-kind.ts';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import type { AgentHandle, InputRequest, KestrelToolHost, ToolResult } from './agents/types.ts';
import { limitMessage } from './limits.ts';
import { AGENT_LABEL, isSelectableAgent, type Agent, type Project, type ProjectFolder, type Session, type SessionState } from './model.ts';
import type { SessionRuntime } from './runtime.ts';
import { expandHome, inspectFolder, projectWithFolder, realDirectory, registerProject, uniqueProjectName } from './runtime/projects.ts';
import { defaultFolder, folderName, projectPath } from './shared/project-folders.ts';
import { isWorking, lastAgentTextOf } from './runtime/record.ts';
import { freshFindings } from './shared/findings.ts';
import { summaryProblem, verdictProblem, type ReviewVerdict } from './shared/review-reply.ts';
import { carryForward, checkEarlier, earlierUnknown, REVIEW_END_NOTE, reviewEndId, roundFindingsText, roundNews, roundNotice, roundVerdict, unstructuredFinding, type ReviewEnd, type RoundFindings } from './shared/round-findings.ts';
import type { PermissionLevel } from './shared/permissions.ts';
import { matchProject, type Match } from './shared/projects.ts';
import { ALREADY_COMPLETE, completeRefusal, isComplete, isOpenWork, workstreamNotice, workstreamOf } from './shared/workstreams.ts';
import { checkWait, waitsOnTarget } from './shared/waits.ts';
import { mayNote, noteRefusal, noteSent, noteText } from './shared/notes.ts';
import { parentHears, turnReports, type ReportRole } from './shared/turn-reports.ts';
import { subtreeIds } from './tree.ts';
import { titleFrom } from './title.ts';
import { checkAgentTitle, checkAgentTitles } from './shared/agent-title.ts';
import { Refused, type Workspace } from './workspace.ts';
import { asStep, inReplay, replaying, type Replay } from './runtime/steps.ts';
import { isStepTool, stepNews, type StepCall, type StepTool, type WaitingStep } from './shared/waiting-steps.ts';

/** How each step's tool is called again, with the arguments the agent gave it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STEP_CALLS: Record<StepTool, (tools: DelegationTools, args: any) => Promise<ToolResult>> = {
  add_project: (t, a) => t.addProject(a),
  handoff: (t, a) => t.handoff(a),
  move_to_project: (t, a) => t.moveToProject(a),
  start_review: (t, a) => t.startReview(a),
  delegate: (t, a) => t.delegate(a),
  spawn: (t, a) => t.spawn(a),
  ask_session: (t, a) => t.askSession(a),
};

/** A step taken up after a restart that no longer asks for anything: why nothing was done. */
const NO_LONGER_ASKS = 'This no longer asks for your approval, so nothing was done on the old answer.';

export type ChildOrigin = 'handoff' | 'delegate' | 'spawn';
/** The tools this file answers; the display tools come from `display.ts`. */
export type DelegationTools = Pick<KestrelToolHost, 'listProjects' | 'addProject' | 'handoff' | 'moveToProject' | 'startReview' | 'delegate' | 'spawn' | 'sessionStatus' | 'askSession' | 'sendNote' | 'completeWorkstream' | 'waitFor' | 'archiveSession'>;
/**
 * How much of a session's last message another session is told. It was 400 characters, which cut
 * every real report short: the asker then asked for a shorter one, again and again (2026-11-18).
 */
export const REPORT_MAX = 6000;
/** How many times a session may ask the same session for work before the user has written to it again. */
export const ASKS_PER_USER_MESSAGE = 3;

/** A session's last message as told to another session: whole when it fits, and saying so when it does not. */
export function reportOf(text: string): string {
  if (text.length <= REPORT_MAX) return text;
  return `${text.slice(0, REPORT_MAX)}\n[Cut here at ${REPORT_MAX} characters. The rest is in that session's conversation; do not ask it to repeat itself, tell the user to open it.]`;
}

/** How a failed turn's detail starts (runtime/events.ts). */
const FAILED = 'failed: ';
/** The modes in which delegate and spawn start sessions without an approval card. */
const NO_CARD_LEVELS: readonly PermissionLevel[] = ['auto', 'bypass'];
const SUMMARY_ASK = (project: string) =>
  `Matt wants to move this work to the project "${project}". Reply with ONLY a self-contained summary for the agent that will continue there: the goal, what you found or did so far, and what is left. No preamble, no tool calls.`;

type Brief = { project: string; folder?: string; brief: string; agent?: string; /** What the part is, as the user reads it in the sidebar (shared/agent-title.ts); the brief titles it when absent. */ title?: string; /** design, build or review: the agent and model the user chose for that kind of work (shared/who-does-what.ts). */ role?: string };
/** What a task runs on: the agent, and the model, effort and fast mode when a role's preset names them. */
type Runner = { agent: Agent; preset: ModelPreset | null; role: Role | null; /** The user set this role to start only after they approve. */ ask: boolean; /** The role's first choice, when it cannot run and the work goes to a later one. */ passed?: ModelPreset | null; /** The role's presets tried so far, the one used last. */ tried?: string[] };
/** A task that runs in its caller's worktree, as its guest (shared/worktree-guests.ts). */
type Hosted = { guest: Guest; host: Session } | null;
type Target = { project: Project; folder: ProjectFolder | null };

/** "Docs", or "Docs · web" for one directory of a project with several. */
const targetName = ({ project, folder }: Target) => (folder && project.folders.length > 1 ? `${project.name} · ${folderName(folder)}` : project.name);

/** What list_projects tells an agent about a project. */
const projectInfo = (p: Project) => ({ name: p.name, path: projectPath(p), isGit: defaultFolder(p)?.isGit ?? false, folders: p.folders.map((f) => ({ name: folderName(f), path: f.path, isGit: f.isGit })) });

/** The title an agent gave a session it starts, checked (shared/agent-title.ts); null when it gave none. Refused with the reason. */
function titleGiven(given: string | undefined): string | null {
  const checked = checkAgentTitle(given);
  if ('refusal' in checked) throw new Refused(checked.refusal);
  return checked.title;
}

/** What the approval card says runs a task: the agent, and the role's preset when there is one. */
const runnerText = (r: Runner): string => (r.preset && r.role ? `${ROLE_LABEL[r.role]}: ${r.preset.name} (${presetSummary(r.preset)})${r.passed ? `, because "${r.passed.name}" ${NOT_CONNECTED}` : ''}` : r.agent);
/** The role's part a child is started for, kept with it so the part can go to the role's next choice. */
const roleRunOf = (r: Runner, brief: string): RoleRun | null => (r.preset && r.role ? { role: r.role, brief, tried: r.tried ?? [r.preset.id] } : null);
/** What a session is sent when it carries on with the same part on another model. */
const CARRY_ON = '[Kestrel] The model you were running on could not go on, so you are now on another one. Carry on with the part you were given from where you stopped: look at what you already changed first.';
/** The effort and fast mode a role's preset names; nothing without one. */
const speedOf = (r: Runner): { effort?: string; fast?: boolean } => (r.preset ? { effort: r.preset.effort, fast: r.preset.fast } : {});

export class Delegation {
  /** The last state of each child its parent was told about: one message per state change. */
  private readonly told = new Map<string, string>();
  /** How many times each session has asked each other session since the user last wrote to it (`asker>target`). */
  private readonly askCount = new Map<string, number>();
  /** What the user approved for a session that can only be done once its turn has ended: moving it into a project, or archiving it after a handoff. Live only. */
  /** Sessions whose agent has asked the user about moving: Kestrel does not ask them again itself. Live only. */
  private readonly moveAsked = new Set<string>();
  private readonly afterTurn = new Map<string, { move: Target & { folder: ProjectFolder } } | { archive: { reason: string } } | { replacedBy: string }>();

  /**
   * `Workspace.delegate`, and a workstream it made is given its colour (Matt, 2026-11-22;
   * `nextWorkstreamColour`). The colour is only a look: failing to store it does not fail the work.
   */
  private async delegateIn(...args: Parameters<Workspace['delegate']>): ReturnType<Workspace['delegate']> {
    const result = await this.ws.delegate(...args);
    if (result.created && result.workstream) {
      const live = (await this.ws.state()).workstreams.map((w) => w.id);
      await this.rt.colours.autoColourWorkstream(result.workstream.id, live).catch((error) => console.error('[kestrel] could not colour the workstream', result.workstream?.id, error));
    }
    return result;
  }

  constructor(
    private readonly rt: SessionRuntime,
    private readonly ws: Workspace,
    /** Kestrel's own data folder (worktrees, scratch, media): never a project. */
    private readonly dataDir: string,
  ) {}

  /** The tools one session is given. Every call runs as that session. */
  hostFor(callerId: string): DelegationTools {
    return {
      listProjects: async () => [...(await this.ws.state()).projects.map(projectInfo), ...((await this.rt.nodeProjects?.rows()) ?? [])],
      addProject: (a) => this.guard(callerId, 'add_project', () => this.addProject(callerId, a), a),
      handoff: (a) => this.guard(callerId, 'handoff', () => this.handoff(callerId, a), a),
      moveToProject: (a) => this.guard(callerId, 'move_to_project', () => this.moveToProject(callerId, a), a),
      startReview: (a) => this.guard(callerId, 'start_review', () => this.convertToReview(callerId, a), a),
      delegate: (a) => this.guard(callerId, 'delegate', () => this.delegate(callerId, a.tasks ?? [], { name: a.name, objective: a.objective }), a),
      spawn: (a) => this.guard(callerId, 'spawn', () => this.spawn(callerId, a), a),
      sessionStatus: (a) => this.guard(callerId, 'session_status', () => this.sessionStatus(callerId, a.id)),
      askSession: (a) => this.guard(callerId, 'ask_session', () => this.askSession(callerId, a), a),
      sendNote: (a) => this.guard(callerId, 'send_note', () => this.sendNote(callerId, a)),
      completeWorkstream: () => this.guard(callerId, 'complete_workstream', () => this.completeWorkstream(callerId)),
      waitFor: (a) => this.guard(callerId, 'wait_for', () => this.waitFor(callerId, a)),
      archiveSession: (a) => this.guard(callerId, 'archive_session', () => this.archiveSession(callerId, a)),
    };
  }

  /**
   * A refusal goes to the agent as the tool result and shows in the conversation. A tool that may
   * wait on one of Kestrel's own cards runs as a step (`args`: what the agent gave it), so the card
   * can be taken up after a restart by making the same call again (`resumeStep`).
   */
  private async guard(callerId: string, tool: string, work: () => Promise<ToolResult>, args?: unknown): Promise<ToolResult> {
    try {
      return await (isStepTool(tool) ? asStep(this.rt.steps, callerId, { kind: 'tool', tool, args: args ?? {} }, work) : work());
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      this.rt.notice(callerId, `Kestrel refused ${tool}: ${error.message}`, 'error');
      return { text: error.message, isError: true };
    }
  }

  /**
   * One of Kestrel's own steps, answered after a restart (runtime/turns.ts `answerCard`): taken up by
   * making the call again with today's state, so every check runs again, and its approval is given
   * the stored answer only when it asks the same thing as the card did. The agent hears the outcome
   * with its next turn. What was refused, or null when it was done (or declined).
   */
  async resumeStep(sessionId: string, step: WaitingStep, approved: boolean): Promise<string | null> {
    const replay: Replay = { card: step.card, approved, reached: false, changed: null };
    if (step.call.kind === 'fallback') return this.resumeFallback(sessionId, step.call, replay);
    const caller = await this.session(sessionId);
    if (!approved) {
      await this.rt.queueNews(caller, stepNews(step.card, { approved: false, refusal: null, result: null }));
      return null;
    }
    const tools = this.hostFor(sessionId);
    const call = STEP_CALLS[step.call.tool];
    const result = await replaying(sessionId, replay, () => call(tools, step.call.kind === 'tool' ? step.call.args : {}));
    const refusal = replay.changed ?? (result.isError ? result.text : replay.reached ? null : `${NO_LONGER_ASKS} ${result.text}`);
    await this.rt.queueNews(caller, stepNews(step.card, { approved, refusal, result: refusal ? null : result.text }));
    return refusal;
  }

  /** A role's fallback, answered after a restart: `passOn` again, for the child as it is now. */
  private async resumeFallback(parentId: string, call: Extract<StepCall, { kind: 'fallback' }>, replay: Replay): Promise<string | null> {
    const state = await this.ws.state();
    const child = state.sessions.find((s) => s.id === call.childId);
    if (!child) return 'The session that could not go on is gone.';
    await this.rt.recordFor(child);
    try {
      const passed = await replaying(parentId, replay, () => this.passOn(child, call.reason, state));
      if (replay.changed) return replay.changed;
      if (passed === true && replay.reached) return null;
      return typeof passed === 'string' ? passed : NO_LONGER_ASKS.trim();
    } catch (error) {
      if (error instanceof Refused) return error.message;
      throw error;
    }
  }

  // ---- resolving what the agent named ------------------------------------------------------

  private async session(id: string): Promise<Session> {
    const s = (await this.ws.state()).sessions.find((x) => x.id === id);
    if (!s) throw new Refused(`No such session: ${id}`);
    return s;
  }

  private async targetFor(name: string, folder?: string): Promise<Target> {
    const found = await this.matchOrClone(name, folder);
    if ('error' in found) throw new Refused(found.error);
    return found;
  }

  /**
   * `match` against this computer's projects; on a worker node, a project of the account it has not cloned is
   * checked and cloned first (project-clone/mirror.ts `cloneNamed`, the one cloner the dispatcher uses), then matched
   * as a project it has (worker-nodes.md 9.3). A refusal to clone is thrown in 9.1's words.
   */
  private async matchOrClone(given: string, folder?: string): Promise<Match<Project>> {
    const found = this.match(given, (await this.ws.state()).projects, folder);
    const mirror = this.rt.nodeProjects;
    if (!('error' in found) || !mirror) return found;
    const cloned = await mirror.cloneNamed(given);
    return cloned ? matchProject(cloned.name, [cloned], folder) : found;
  }

  /** Like `matchProject`, but a folder that exists on disk is named as one that can be added. */
  private match(given: string, projects: readonly Project[], folder?: string): Match<Project> {
    const found = matchProject(given, projects, folder);
    if (!('error' in found)) return found;
    // Only an absolute path counts: a bare name must not be looked up in the server's own cwd.
    const path = expandHome(given.trim());
    const dir = isAbsolute(path) ? realDirectory(path) : null;
    if (!dir) return found;
    // `~/Code/x` or a symlinked path to a registered project is that project.
    const same = projectWithFolder(projects, dir);
    if (same) return matchProject(dir, [same], folder);
    return { error: `${dir} is a folder on this computer but not a Kestrel project yet. Call add_project with that path first, then try again.` };
  }

  private agentFor(caller: Session, given?: string): Agent {
    if (given === undefined || given === '') return caller.agent;
    if (!isSelectableAgent(given)) throw new Refused(`Unknown agent "${given}". Use one of: ${this.rt.availableAgents().join(', ')}.`);
    if (!this.rt.availableAgents().includes(given as Agent)) throw new Refused(`${given} is not connected yet. Available: ${this.rt.availableAgents().join(', ')}.`);
    return given as Agent;
  }

  /**
   * Who runs a task. With a role the user gave a preset, that preset's agent, whichever agent the
   * caller is and whatever `agent` says; a role with no preset is left to `agent`, else the caller's.
   */
  private runnerFor(caller: Session, task: Brief, who: WhoDoesWhat | null): Runner {
    if (!task.role) return { agent: this.agentFor(caller, task.agent), preset: null, role: null, ask: false };
    if (!(ROLES as readonly string[]).includes(task.role)) throw new Refused(`Unknown role "${task.role}". Use one of: ${ROLES.join(', ')}; or leave it out.`);
    const role = task.role as Role;
    const runners = who ? runnersOf(who, role) : [];
    const first = runners[0];
    const ask = who !== null && modeOfRole(who, role) === 'ask';
    if (!who || !first) return { agent: this.agentFor(caller, task.agent), preset: null, role, ask };
    // The first choice whose agent can run now; a later one is said on the card, and asked for unless the user chose otherwise.
    const preset = nextRunner(runners, [], this.rt.availableAgents());
    if (!preset) throw new Refused(`${ROLE_LABEL[role]} work is set to run on "${first.name}" (${presetSummary(first)}), but ${AGENT_LABEL[first.agent]} is not connected${runners.length > 1 ? ', and neither is any of its fallbacks' : ''}. Tell the user; they can connect it or change the role in Settings → Models & roles → Who does what.`);
    const passed = preset.id === first.id ? null : first;
    return { agent: preset.agent, preset, role, ask: ask || (passed !== null && whenUnavailable(who) === 'ask'), passed, tried: runners.slice(0, runners.indexOf(preset) + 1).map((p) => p.id) };
  }

  /** The guest now writing in a host's worktree, if any. */
  private writerIn(hostId: string, sessions: readonly Session[]): { title: string; id: string; role: Role } | null {
    const writer = sessions.find((s) => s.state === 'running' && this.rt.recordOf(s.id)?.guest?.hostId === hostId && this.rt.recordOf(s.id)!.guest!.writes);
    return writer ? { title: writer.title, id: writer.id, role: this.rt.recordOf(writer.id)!.guest!.role } : null;
  }

  /** The model a task's child starts on: its role's preset's, else the caller's when it runs the same agent. */
  private modelOf(callerId: string, caller: Session, runner: Runner): string {
    return runner.preset ? runner.preset.model : this.modelFor(callerId, caller, runner.agent);
  }

  /** A child inherits the caller's model only when it runs the same agent. */
  private modelFor(callerId: string, caller: Session, agent: Agent): string {
    return agent === caller.agent ? (this.rt.recordOf(callerId)?.settings.model ?? '') : '';
  }

  /** A caller in Auto or Bypass mode may start sessions without a card; every other mode asks. */
  private startsWithoutCard(callerId: string): boolean {
    const level = this.rt.recordOf(callerId)?.settings.permission;
    return level !== undefined && NO_CARD_LEVELS.includes(level);
  }

  private async approve(caller: Session, tool: 'delegate' | 'spawn' | 'ask_session' | 'handoff' | 'move_to_project' | 'start_review' | 'archive_session', title: string, lines: string[], allow = 'Start', always = false): Promise<boolean> {
    // `always`: a role the user set to start only after they approve asks whatever the caller's mode.
    // A step taken up after a restart always goes through its card, to be compared with what was approved.
    if (!always && !inReplay() && this.startsWithoutCard(caller.id)) return true;
    const request: InputRequest = {
      id: `${tool}-${randomUUID()}`,
      kind: 'approval',
      tool,
      title,
      detail: lines.join('\n'),
      options: [
        { id: 'allow', label: allow, role: 'allow' },
        { id: 'deny', label: 'Decline', role: 'deny' },
      ],
    };
    return this.rt.requestApproval(caller.id, request);
  }

  // ---- the tools --------------------------------------------------------------------------

  /**
   * move_to_project: a session with no project asks to move itself into one, keeping its
   * conversation (Matt, 2026-11-20). The user is always asked. The move is made when this turn
   * ends (`finishTurn`), since an agent cannot change folders while it runs.
   */
  private async moveToProject(callerId: string, a: { project: string; folder?: string; reason?: string }): Promise<ToolResult> {
    const caller = await this.session(callerId);
    const refusal = this.rt.moveRefusal(caller);
    if (refusal) throw new Refused(refusal);
    const target = await this.targetFor(a.project, a.folder);
    const folder = target.folder ?? defaultFolder(target.project);
    if (!folder) throw new Refused(`${target.project.name} has no folder to work in yet. Tell the user; they can add one on the project's Settings tab.`);
    if (!folder.isGit) this.rt.checkPlainFolderFree(target.project, folder, (await this.ws.state()).sessions);
    const where = targetName({ project: target.project, folder });
    // Asked by the agent: Kestrel does not ask again itself.
    this.moveAsked.add(callerId);
    const { title, detail } = moveAsk(where, a.reason ?? '');
    if (!(await this.approve(caller, 'move_to_project', title, [detail], 'Move it', true))) return { text: MOVE_DECLINED };
    this.setAfterTurn(callerId, { move: { project: target.project, folder } });
    return { text: moveApproved(where) };
  }

  /**
   * Something the user approved is done when the caller's turn ends. When that turn is already over
   * (the card was answered after it: runtime/turns.ts `answerAfterTurn`), it is done now.
   */
  private setAfterTurn(callerId: string, pending: NonNullable<ReturnType<Delegation['afterTurn']['get']>>): void {
    this.afterTurn.set(callerId, pending);
    const rec = this.rt.recordOf(callerId);
    if (rec?.handle?.busy() || rec?.launching) return;
    void this.session(callerId)
      .then((session) => this.finishTurn(session))
      .catch((error: unknown) => this.rt.notice(callerId, `Kestrel could not do what you approved: ${error instanceof Error ? error.message : String(error)}`, 'error'));
  }

  /** What the user approved for after this turn (`afterTurn`): done now that it has ended. True when the session's turn end is not news for anyone else. */
  private async finishTurn(session: Session): Promise<boolean> {
    const pending = this.afterTurn.get(session.id);
    if (!pending) return false;
    this.afterTurn.delete(session.id);
    if ('replacedBy' in pending) {
      // The review session it asked for is running: this one gives way to it (review-requests/convert.ts).
      await this.rt.replaceWith(session.id, pending.replacedBy);
      return true;
    }
    if ('archive' in pending) {
      // The one way a session is archived at the end of its own turn: `handoff` with `archive_self`, and `archive_session` for itself.
      try {
        await this.archiveNow(session.id, session, pending.archive.reason);
      } catch (error) {
        this.rt.notice(session.id, notArchivedSelf(error instanceof Error ? error.message : String(error)), 'warning');
      }
      return false;
    }
    const where = targetName(pending.move);
    try {
      await this.moveNow(session.id, pending.move.project.id, pending.move.folder.id, true);
      return true;
    } catch (error) {
      this.rt.notice(session.id, moveFailed(where, error instanceof Error ? error.message : String(error)), 'error');
      return false;
    }
  }

  /**
   * Move a session with no project into a folder of a project now (it is between turns) and say so.
   * `wake`: the session asked for the move to carry on with its work there, so it is woken in the
   * new folder. Moved by the user (Kestrel's offer), it has nothing to carry on with: it is told with
   * its next turn, not woken to answer a notice. What the user reads once it has moved.
   */
  async moveNow(sessionId: string, projectId: string, folderId: string, wake = false): Promise<string> {
    const project = (await this.ws.state()).projects.find((p) => p.id === projectId);
    const folder = project?.folders.find((f) => f.id === folderId);
    if (!project || !folder) throw new Refused('That project or folder is no longer registered.');
    const where = targetName({ project, folder });
    const moved = await this.rt.moveToProject(sessionId, project, folder);
    const line = movedNotice(where, moved.branch);
    this.rt.notice(sessionId, line, 'info');
    if (wake) await this.rt.reply(sessionId, movedTold(where, moved.directory, moved.branch), {}, { fromAgent: true });
    else {
      const session = (await this.ws.state()).sessions.find((s) => s.id === sessionId);
      if (session) await this.rt.queueNews(session, movedQuietly(where, moved.directory, moved.branch));
    }
    return line;
  }

  /** "Docs · web" for a project and folder by id; null when they are not registered. */
  async whereIs(projectId: unknown, folderId: unknown): Promise<string | null> {
    const project = (await this.ws.state()).projects.find((p) => p.id === projectId);
    const folder = project?.folders.find((f) => f.id === folderId);
    return project && folder ? targetName({ project, folder }) : null;
  }

  /**
   * A session with no project finished a turn in which everything its agent ran and read was in
   * one registered project: Kestrel offers the move itself (suggestions/move-kind.ts), once in a
   * session, so the offer does not depend on the agent thinking to ask. Not when the agent asked
   * in this turn, and not for a session that cannot move.
   */
  private async offerMove(session: Session): Promise<void> {
    if (session.startedIn || this.moveAsked.has(session.id) || this.rt.moveRefusal(session)) return;
    const worked = projectWorkedIn(this.rt.turnWork(session.id), (await this.ws.state()).projects);
    if (worked) await this.rt.suggestions.suggest(session.id, { kind: MOVE_KIND, project: worked.project.id, folder: worked.folder.id });
  }

  /**
   * start_review: the user's first message asked for a review of a pull request. They are asked
   * whether to make this a review session; on a yes one is started for that request and this
   * session is removed when its turn ends (review-requests/convert.ts). Refused, with what to do
   * instead, when the request is in no registered project or the conversation is already under way.
   */
  private async convertToReview(callerId: string, a: { pull_request: string }): Promise<ToolResult> {
    const caller = await this.session(callerId);
    if (caller.review) throw new Refused(ALREADY_A_REVIEW);
    const said = (this.rt.recordOf(callerId)?.messages ?? []).filter((m) => m.author === 'you' && !m.notice).length;
    if (said > 1) throw new Refused(NOT_FIRST_MESSAGE);
    const ref = parseRequestRef(a.pull_request ?? '');
    if (!ref) throw new Refused(NOT_A_REQUEST);
    const home = await requestHome(ref, (await this.ws.state()).projects, caller.startedIn, originUrl);
    const named = ref.repository ? `${ref.repository} #${ref.number}` : `#${ref.number}`;
    if (!home) throw new Refused(noProjectFor(named));
    const request = await this.rt.requestToReview(home, ref.number, ref.url);
    const terms = hostTerms(request.host);
    const ask = convertAsk(`${terms.long} ${terms.sigil}${request.number} in ${request.repository} ("${request.title}")`, home.project.name);
    if (!(await this.approve(caller, 'start_review', ask.title, [ask.detail], 'Make it a review', true))) return { text: CONVERT_DECLINED };
    const review = await this.rt.startReview(request);
    this.setAfterTurn(callerId, { replacedBy: review.id });
    return { text: converted(review.title, review.id) };
  }

  private async handoff(callerId: string, a: { project: string; folder?: string; summary: string; agent?: string; archive_self?: boolean; title?: string }): Promise<ToolResult> {
    const caller = await this.session(callerId);
    const named = titleGiven(a.title);
    const agent = this.agentFor(caller, a.agent);
    const target = await this.targetFor(a.project, a.folder);
    const { project, folder } = target;
    const summary = (a.summary ?? '').trim();
    if (!summary) throw new Refused('handoff needs a summary: everything the new session must know, since it sees nothing else of this conversation.');
    const editing = (this.rt.recordOf(callerId)?.settings.permission ?? 'ask') !== 'readonly';
    const callerFolder = (await this.ws.state()).sessions.find((s) => s.id === callerId)?.folderId ?? null;
    if (editing && project.id === caller.startedIn && (folder?.id ?? null) === callerFolder) throw new Refused(`You are already working in ${targetName(target)}. Do this work yourself; hand off only when it belongs in a different project or directory.`);
    if (folder) this.rt.checkPlainFolderFree(project, folder, (await this.ws.state()).sessions);
    // In the wrong project altogether: the user is asked whether to hand it off and archive this session.
    if (a.archive_self) {
      const ask = handoffArchiveAsk(targetName(target), caller.title);
      if (!(await this.approve(caller, 'handoff', ask.title, [ask.detail], 'Hand off and archive', true))) return { text: HANDOFF_ARCHIVE_DECLINED };
    }
    const child = await this.ws.handoff(callerId, { projectId: project.id, folderId: folder?.id ?? null, summary, agent, title: named ?? titleFrom(summary), markParentDone: false });
    this.noteStarted(callerId, child.id, 'handoff');
    const launched = await this.rt.launchChild(child, project, folder, summary, 'handoff', this.modelFor(callerId, caller, agent), this.modeOf(callerId));
    if (!launched.ok) return { isError: true, text: `The handoff session was created (${child.id}) but could not start: ${launched.reason}` };
    if (a.archive_self) this.setAfterTurn(callerId, { archive: { reason: handedOffReason(targetName(target)) } });
    return { text: `Handed off to ${targetName(target)}: session "${child.title}" (${child.id}) is now working on it in its own worktree. That session owns this work now. Stop working on it here: make no further changes for it, tell the user in one sentence where it went, and end your turn.` };
  }

  private async delegate(callerId: string, tasks: Brief[], named: { name?: string; objective?: string } = {}): Promise<ToolResult> {
    const caller = await this.session(callerId);
    if (tasks.length === 0) throw new Refused(limitMessage.noTasks());
    const limits = await this.ws.limits.current();
    if (tasks.length > limits.maxChildrenPerDelegate) throw new Refused(limitMessage.tooManyTasks(limits, tasks.length));
    const checked = checkAgentTitles(tasks.map((t) => t.title));
    if ('refusal' in checked) throw new Refused(checked.refusal);
    const resolved = await this.resolveTasks(caller, tasks);
    // A review of the work in this worktree is the user's to start: it goes to the one question
    // (suggestions/review-kind.ts), and never starts beside it.
    const ownReview = resolved.find((t) => t.hosted?.guest.role === 'review');
    if (ownReview && resolved.length > 1) throw new Refused('A review of this session\'s work is asked for on its own: call delegate again with only that task, after the others.');
    if (ownReview) return this.rt.reviewAsked(ownReview.hosted!.host.id);
    await this.ws.checkLimits(callerId, tasks.length, { depth: true });
    const lines = resolved.map((t, i) => `• ${checked.titles[i] ? `${checked.titles[i]} · ` : ''}${targetName(t)} · ${runnerText(t)}${t.hosted ? ' · in this session\'s worktree' : ''}\n  ${t.brief}`);
    if (!(await this.approve(caller, 'delegate', `Start ${resolved.length} session${resolved.length === 1 ? '' : 's'}`, lines, 'Start', resolved.some((t) => t.ask)))) {
      return { text: 'The user declined. Nothing was started. Ask what they would like instead, or do the part that belongs here yourself.' };
    }
    const { children, workstream, created } = await this.delegateIn(callerId, resolved.map((t, i) => ({ projectId: t.project.id, folderId: t.folder?.id ?? null, brief: t.brief, agent: t.agent, title: checked.titles[i] ?? titleFrom(t.brief), ...(t.hosted ? { hostId: t.hosted.guest.hostId } : {}) })), named);
    // The user sees, where they are, that the work now has one place to follow it. Nothing moved.
    if (workstream) this.rt.notice(callerId, workstreamNotice(workstream.name, created, children.map((c, i) => `${targetName(resolved[i]!)} · ${c.title}`)), 'info');
    for (const child of children) this.noteStarted(callerId, child.id, 'delegate');
    const results = await Promise.all(children.map((child, i) => this.rt.launchChild(child, resolved[i]!.project, resolved[i]!.folder, resolved[i]!.hosted ? `${guestIntro(resolved[i]!.hosted!.guest.role, resolved[i]!.hosted!.host.title)}\n\n${resolved[i]!.brief}` : resolved[i]!.brief, 'delegate', this.modelOf(callerId, caller, resolved[i]!), this.modeOf(callerId), speedOf(resolved[i]!), resolved[i]!.hosted ?? undefined, roleRunOf(resolved[i]!, resolved[i]!.brief))));
    for (const t of resolved) if (t.passed && t.preset && t.role) this.rt.notice(callerId, fallbackNotice(t.role, t.passed, NOT_CONNECTED, t.preset, false), 'warning');
    await this.lead(callerId, caller);
    const report = children.map((c, i) => ({ id: c.id, title: c.title, project: targetName(resolved[i]!), agent: c.agent, ...(results[i]!.ok ? { started: true } : { started: false, error: (results[i] as { reason: string }).reason }) }));
    return { text: `Started ${children.length} session${children.length === 1 ? '' : 's'}; you are their orchestrator. You will receive a message when each finishes, fails or needs the user. Do not make their changes yourself. Use session_status to check.${resolved.some((t) => t.hosted?.guest.writes) ? ' One of them is working in THIS worktree: change no file here until it hands back, and end your turn once you have nothing else to do; you are woken when it does.' : ''}${workstream ? ` ${created ? 'They and you are now listed together for the user in the workstream' : 'They were added to the workstream'} "${workstream.name}"; no session was moved.` : ''} ${JSON.stringify(report)}` };
  }

  private async spawn(callerId: string, a: Brief): Promise<ToolResult> {
    const caller = await this.session(callerId);
    const named = titleGiven(a.title);
    const [task] = await this.resolveTasks(caller, [a]);
    await this.ws.checkLimits(callerId, 1, { depth: false });
    if (!(await this.approve(caller, 'spawn', 'Start a new session', [`• ${named ? `${named} · ` : ''}${targetName(task!)} · ${runnerText(task!)}\n  ${task!.brief}`]))) return { text: 'The user declined. Nothing was started.' };
    const child = await this.ws.spawn(callerId, { projectId: task!.project.id, folderId: task!.folder?.id ?? null, title: named ?? titleFrom(task!.brief), agent: task!.agent });
    this.noteStarted(callerId, child.id, 'spawn');
    const launched = await this.rt.launchChild(child, task!.project, task!.folder, task!.brief, 'spawn', this.modelOf(callerId, caller, task!), this.modeOf(callerId), speedOf(task!), undefined, roleRunOf(task!, task!.brief), callerId);
    if (!launched.ok) return { isError: true, text: `The session was created (${child.id}) but could not start: ${launched.reason}` };
    return { text: `Started a separate session "${child.title}" (${child.id}) in ${targetName(task!)}. It is not linked to you and you will not hear back from it.` };
  }

  /**
   * Work for a session that already exists, done in its own worktree: the way a file in another
   * session's worktree gets changed. The message is that session's next turn (after the one it is
   * on, when it is busy), and the caller is told when that turn ends. Approved like a spawn.
   */
  private async askSession(callerId: string, a: { session: string; message: string }): Promise<ToolResult> {
    const caller = await this.session(callerId);
    const message = (a.message ?? '').trim();
    if (!message) throw new Refused('Say what the session should do: message is empty.');
    const target = (await this.ws.state()).sessions.find((s) => s.id === a.session);
    if (!target) throw new Refused(`No such session: ${a.session}. Use the id from the refusal that named it, or from session_status.`);
    if (target.id === callerId) throw new Refused('That is this session. Make the change yourself.');
    if (target.worktreeDiscarded) throw new Refused(`The worktree of "${target.title}" was removed, so it can do no more work. Delegate to its project instead.`);
    const { pair, asks } = this.asksOf(callerId, target);
    if (!(await this.approve(caller, 'ask_session', `Ask “${target.title}” to do this`, [message], 'Send'))) return { text: 'The user declined. Nothing was sent. Ask what they would like instead.' };
    const text = `[Kestrel] The session "${caller.title}" (${callerId}) asks you to do this in your worktree, since only you change it:\n\n${message}`;
    const outcome = await this.rt.reply(target.id, text, {}, { fromAgent: true, from: { sessionId: callerId, title: caller.title, body: message, kind: 'work' } });
    this.askCount.set(pair, asks + 1);
    // Kept with the target session (runtime, `addAsker`), so the caller still hears after a restart.
    await this.rt.addAsker(target, callerId);
    return { text: `Sent to "${target.title}" (${target.id})${outcome === 'queued' ? '; it is busy and gets the message when its turn ends' : ''}. It makes the change in its own worktree. You will be told when it finishes that turn; do not make the change yourself.` };
  }

  /**
   * Two agents must not keep each other busy: after a few asks (work and notes alike) the user decides
   * what happens next. The pair's key and how many it has used; refused at the limit.
   */
  private asksOf(callerId: string, target: Session): { pair: string; asks: number } {
    const pair = `${callerId}>${target.id}`;
    const asks = this.askCount.get(pair) ?? 0;
    if (asks >= ASKS_PER_USER_MESSAGE) throw new Refused(`You have sent "${target.title}" ${asks} messages since the user last wrote to you, which is the limit. Do not send it more. Tell the user what you have and what you still need from that session; they can open it or reply to you.`);
    return { pair, asks };
  }

  /**
   * A note for another session (shared/notes.ts): information it needs while it works. Only between
   * sessions of one workstream, or a session and one it started by a link. No card: it changes no
   * file and starts no turn. It goes into the receiver's running turn, or waits for its next one.
   */
  private async sendNote(callerId: string, a: { session: string; note: string }): Promise<ToolResult> {
    const caller = await this.session(callerId);
    const body = (a.note ?? '').trim();
    const state = await this.ws.state();
    const target = state.sessions.find((s) => s.id === a.session);
    if (!target) throw new Refused(`No such session: ${a.session}. Use an id from session_status or from the workstream.`);
    if (target.id === callerId) throw new Refused('That is this session. There is no one to tell.');
    const refusal = noteRefusal(body, mayNote(state, callerId, target.id), target.title);
    if (refusal) throw new Refused(refusal);
    const { pair, asks } = this.asksOf(callerId, target);
    const outcome = await this.rt.note(target.id, noteText(caller.title, callerId, body), { sessionId: callerId, title: caller.title, body, kind: 'note' });
    this.askCount.set(pair, asks + 1);
    return { text: noteSent(outcome, target.title, target.id) };
  }

  /** Register a folder the agent found on disk, once the user says yes. */
  private async addProject(callerId: string, a: { path: string; name?: string }): Promise<ToolResult> {
    await this.session(callerId);
    const projects = (await this.ws.state()).projects;
    const found = await inspectFolder(a.path ?? '', { dataDir: this.dataDir, projects });
    if (found.kind === 'registered') return { text: `Already a project: ${found.project.name}` };
    const name = uniqueProjectName(a.name?.trim().slice(0, 80) || basename(found.path), found.path, projects);
    const request: InputRequest = {
      id: `add_project-${randomUUID()}`,
      kind: 'approval',
      tool: 'add_project',
      title: `Add ${name} as a project?`,
      detail: [found.path, found.isGit ? 'Git repository' : 'Plain folder, no git'].join('\n'),
      options: [
        { id: 'allow', label: 'Add project', role: 'allow' },
        { id: 'deny', label: 'Not now', role: 'deny' },
      ],
    };
    if (!(await this.rt.requestApproval(callerId, request))) return { text: 'The user chose not to add it.' };
    // The same registration the UI's "Add project" uses; it checks the folder again.
    const project = await registerProject(this.ws, found.path, name);
    const added = `Added ${project.name} (${projectPath(project) ?? found.path}). You can now use handoff, delegate or spawn with it.`;
    return { text: found.note ? `${found.note} ${added}` : added };
  }

  /** Match every task's project and agent at once, so the agent can fix all its mistakes in one retry. */
  private async resolveTasks(caller: Session, tasks: Brief[]) {
    const projects = (await this.ws.state()).projects;
    const problems: string[] = [];
    const who = tasks.some((t) => t.role) ? await this.rt.whoDoesWhat.current() : null;
    const out: (Target & { brief: string; hosted: Hosted } & Runner)[] = [];
    // A task with a role, for the caller's own project and directory, runs in the caller's worktree (its host's, when the caller is a guest itself).
    const state0 = await this.ws.state();
    const hostId = this.rt.recordOf(caller.id)?.guest?.hostId ?? caller.id;
    const host = state0.sessions.find((s) => s.id === hostId);
    const hostFolder = host?.folderId ?? null;
    for (const t of tasks) {
      const found = await this.matchOrClone(t.project ?? '', t.folder).catch((error: unknown) => {
        if (error instanceof Refused) return { error: error.message };
        throw error;
      });
      const brief = (t.brief ?? '').trim();
      if ('error' in found) problems.push(found.error);
      else if (!brief) problems.push(`The brief for ${found.project.name} is empty.`);
      else {
        try {
          const runner = this.runnerFor(caller, t, who);
          const here = runner.role !== null && host !== undefined && host.worktreePath !== null && !host.worktreeDiscarded && found.project.id === host.startedIn && (found.folder?.id ?? null) === hostFolder;
          out.push({ project: found.project, folder: found.folder, brief, ...runner, hosted: here ? { guest: { hostId: host.id, role: runner.role!, writes: guestWrites(runner.role!) }, host } : null });
        } catch (error) {
          problems.push((error as Error).message);
        }
      }
    }
    if (problems.length) throw new Refused(problems.join(' '));
    const writer = writerRefusal(this.writerIn(hostId, state0.sessions), out.filter((t) => t.hosted?.guest.writes).length);
    if (writer) throw new Refused(writer);
    const sessions = (await this.ws.state()).sessions;
    for (const t of out) if (t.folder) this.rt.checkPlainFolderFree(t.project, t.folder, sessions);
    const plain = out.flatMap((t) => (t.folder && !t.folder.isGit ? [t.folder.id] : []));
    if (new Set(plain).size !== plain.length) throw new Refused('Two tasks target the same plain (non-git) folder, which allows one editing session at a time. Combine them into one task.');
    return out;
  }

  private async sessionStatus(callerId: string, id?: string): Promise<ToolResult> {
    const state = await this.ws.state();
    const mine = new Set(subtreeIds(callerId, state.links));
    if (id && !mine.has(id)) throw new Refused(`${id} is not one of your sessions. You can check sessions you started with handoff or delegate.`);
    const wanted = id ? [id] : [...mine].filter((x) => x !== callerId);
    if (wanted.length === 0) return { text: 'You have not started any sessions.' };
    const rows = wanted.flatMap((sid) => {
      const s = state.sessions.find((x) => x.id === sid);
      if (!s) return [];
      const files = this.rt.recordOf(sid)?.files.length;
      return [{ id: s.id, title: s.title, project: state.projects.find((p) => p.id === (s.landedIn ?? s.startedIn))?.name ?? null, agent: s.agent, state: s.state, note: s.note, filesChanged: files ?? null, lastMessage: reportOf(this.rt.lastAgentText(sid)) }];
    });
    return { text: JSON.stringify(rows) };
  }

  /** The workstream a session is in, archived or not. */
  /**
   * wait_for: the caller waits on another session of its workstream (or, with `clear`, stops). It
   * records the wait and returns; the caller hears through `onChildState` when the target finishes.
   */
  private async waitFor(callerId: string, a: { session?: string; reason?: string; clear?: boolean }): Promise<ToolResult> {
    const targetId = a.session?.trim();
    if (!targetId) throw new Refused('Name the session to wait on: session is its id (session_status, or the workstream Kestrel told you about, lists them).');
    if (a.clear) {
      if (!(await this.ws.dropWait(callerId, targetId))) throw new Refused(`You are not waiting on ${targetId}, so there is nothing to clear. Only the session that declared a wait can clear it, and it ends by itself when that session finishes.`);
      return { text: `You are no longer waiting on ${targetId}.` };
    }
    const state = await this.ws.state();
    const workstreams = [...state.workstreams, ...state.archivedWorkstreams];
    const check = checkWait({ waiterId: callerId, targetId, reason: a.reason ?? '', workstreams, sessions: state.sessions, waits: await this.ws.listWaits() });
    if (!check.ok) throw new Refused(check.finished ? `${check.reason} Its last message: ${(await this.lastReport(targetId)) || '(none)'}` : check.reason);
    await this.ws.putWait({ workstreamId: check.workstreamId, waiterId: callerId, targetId, reason: check.reason });
    const title = state.sessions.find((s) => s.id === targetId)?.title ?? targetId;
    return { text: `Recorded: you are waiting on “${title}” (${targetId}) for ${check.reason}. The user sees it on the workstream page. You will be told when it finishes, with its last message. Do not poll: end your turn now, or carry on with what you can do without it.` };
  }

  private async workstreamOf(sessionId: string) {
    const state = await this.ws.state();
    return workstreamOf([...state.workstreams, ...state.archivedWorkstreams], sessionId);
  }

  /**
   * The lead says the whole task is finished. The status change is the menu's Mark complete
   * (`setWorkstreamStatus`); who may call it, and when, is `completeRefusal`. Nothing is archived,
   * moved or stopped.
   */
  private async completeWorkstream(callerId: string): Promise<ToolResult> {
    const workstream = await this.workstreamOf(callerId);
    const refusal = completeRefusal(workstream, callerId, (await this.ws.state()).sessions);
    if (refusal !== null || !workstream) throw new Refused(refusal ?? 'This session is not in a workstream.');
    if (isComplete(workstream)) return { text: ALREADY_COMPLETE(workstream.name) };
    await this.ws.setWorkstreamStatus(workstream.id, 'complete');
    return { text: `Marked “${workstream.name}” complete. It stays in the user's sidebar until they archive it; nothing was moved or stopped. Tell the user the outcome in a sentence or two.` };
  }

  /**
   * archive_session: archive a session (Matt, 2026-11-24). Its own sessions without asking: itself,
   * when its turn ends, the sessions it started, and those of a workstream it leads (`archiveScope`);
   * any other only on the user's yes. Through the user's one archive, so its refusals hold; it never
   * stops, deletes or restores a session.
   */
  private async archiveSession(callerId: string, a: { session?: string; reason?: string }): Promise<ToolResult> {
    const caller = await this.session(callerId);
    const reason = (a.reason ?? '').trim().slice(0, ARCHIVE_REASON_MAX);
    const state = await this.ws.state();
    const targetId = (a.session ?? '').trim() || callerId;
    if (state.archived.sessions.some((s) => s.id === targetId)) throw new Refused(ALREADY_ARCHIVED);
    const target = state.sessions.find((s) => s.id === targetId);
    if (!target) throw new Refused(`No such session: ${targetId}. session_status lists the sessions you started.`);
    const scope = archiveScope(callerId, targetId, state.links, state.workstreams);
    if (scope === 'self') {
      this.setAfterTurn(callerId, { archive: { reason } });
      return { text: selfArchiveLater };
    }
    if (scope === 'ask') {
      const ask = archiveSessionAsk(target.title, reason);
      if (!(await this.approve(caller, 'archive_session', ask.title, [ask.detail], 'Archive', true))) return { text: ARCHIVE_DECLINED };
    }
    try {
      await this.archiveNow(callerId, target, reason);
    } catch (error) {
      if (error instanceof Refused) throw new Refused(`${error.message} ${NOT_STOPPED}`);
      throw error;
    }
    return { text: archivedTold(target.title, target.id) };
  }

  /** Archive `target` through the user's one archive, leaving the line with Undo in `whereId`'s conversation. Throws `Refused` with the archive's own reason. */
  private async archiveNow(whereId: string, target: Pick<Session, 'id' | 'title'>, reason: string): Promise<void> {
    await this.rt.suggestions.act(whereId, { kind: ARCHIVE_SESSION_KIND, target: target.id, title: target.title, reason });
  }

  /** The mode the session that starts a child is in now; the child's own comes from it (`childPermission`). */
  private modeOf(sessionId: string): PermissionLevel | undefined {
    return this.rt.recordOf(sessionId)?.settings.permission;
  }

  // ---- hearing back ----------------------------------------------------------------------

  /** The user wrote to a session: it may ask other sessions for work again (`ASKS_PER_USER_MESSAGE`). */
  onUserMessage(id: string): void {
    for (const key of [...this.askCount.keys()]) if (key.startsWith(`${id}>`)) this.askCount.delete(key);
  }

  /** A session is running again (the user replied or answered): its next state change is news. */
  onSessionRunning(id: string): void {
    this.told.delete(id);
  }

  /** What the note says when a session finishes a turn. */
  async doneNote(id: string, stopped: boolean): Promise<string> {
    if (stopped) return 'Stopped';
    const handedOff = (await this.ws.state()).links.some((l) => l.parentId === id && l.kind === 'handoff');
    return handedOff ? 'Handed off' : 'Finished · waiting for your next message';
  }

  /**
   * A session finished a turn, failed or needs the user: tell whoever this turn is news for, once
   * each (`turnReports`): who asked for it (`ask_session`), its delegate parent (once per state
   * change, and not for a turn the user started there, `parentHears`), and whoever waited on it
   * (`wait_for`, only once it has finished). An idle session told is woken; a busy one hears it with its next turn.
   */
  async onChildState(childId: string, state: Extract<SessionState, 'done' | 'attention'>, detail: string): Promise<void> {
    const state0 = await this.ws.state();
    const child = state0.sessions.find((s) => s.id === childId);
    if (!child) return;
    // A review is run by Kestrel: its reviewer's finish, and its author's answer, are steps of it (below).
    if (await this.reviewStep(child, state)) return;
    // What the user approved for after this turn: the session moves into a project, or is archived.
    if (state === 'done' && (await this.finishTurn(child))) return;
    if (state === 'done') await this.offerMove(child).catch(() => undefined);
    // A role's part that cannot go on where it is goes to the role's next choice, when there is one.
    const passed = state === 'attention' && detail.startsWith(FAILED) ? await this.passOn(child, detail.slice(FAILED.length), state0) : null;
    if (passed === true) return;
    return this.tell(child, state, passed ? `${detail}. ${passed}` : detail, state0);
  }

  /** Tell whoever a session's turn is news for (`onChildState`). */
  private async tell(child: Session, state: 'done' | 'attention', detail: string, state0: Awaited<ReturnType<Workspace['state']>>): Promise<void> {
    const childId = child.id;
    const askers = await this.rt.takeAskers(child);
    const waits = await this.endWaits(child);
    const parent = this.parentToTell(childId, state, state0);
    const reasons = new Map(waits.map((w) => [w.waiterId, w.reason]));
    const said = reportOf(this.rt.lastAgentText(childId));
    const where = state0.projects.find((p) => p.id === (child.landedIn ?? child.startedIn))?.name ?? 'no project';
    for (const r of turnReports({ askers, parent, waiters: waits.map((w) => w.waiterId) })) {
      const guest = this.rt.recordOf(childId)?.guest;
      // A writing guest hands back to its host: Kestrel says what was made and where what is left goes.
      const handBack = r.as === 'parent' && state === 'done' && guest?.writes ? handBackText({ title: child.title, id: child.id, role: guest.role, runner: await this.runnerName(child, guest.role) }, said, guest.role === 'design' ? await this.buildRunner() : null, 'your delegate tool') : null;
      await this.deliver(r.to, handBack ?? reportText(r.as, child, { state, detail, said, where, waitReason: reasons.get(r.to) ?? '' }), child.id);
    }
  }

  /**
   * A session started for a role failed in a way that says its model cannot run now
   * (`cannotRunNow`): the part goes to the role's next choice. True when it was passed on, or the
   * user is being asked (then they hear either way); a sentence to add to the failure report when
   * there was nobody else; null when this is not such a failure.
   */
  private async passOn(child: Session, reason: string, state0: Awaited<ReturnType<Workspace['state']>>): Promise<true | string | null> {
    const run = this.rt.recordOf(child.id)?.roleRun;
    const link = state0.links.find((l) => l.childId === child.id && l.kind === 'delegate');
    if (!run || !link || !cannotRunNow(reason)) return null;
    const who = await this.rt.whoDoesWhat.current();
    const runners = runnersOf(who, run.role);
    const from = who.presets.find((p) => p.id === run.tried.at(-1));
    if (!from) return null;
    const to = nextRunner(runners, run.tried, this.rt.availableAgents());
    if (!to) return noFallbackLeft(run.role, runners);
    const why = `stopped with "${reason.slice(0, 120)}"`;
    const go = async (): Promise<void> => {
      const newId = await this.giveTo(child, link.parentId, run, from, to);
      this.rt.notice(link.parentId, fallbackNotice(run.role, from, why, to, newId === null), 'warning');
      const parent = (await this.ws.state()).sessions.find((s) => s.id === link.parentId);
      // Queued, not sent: the parent is not woken just to be told to keep waiting.
      if (parent) await this.rt.queueNews(parent, `[Kestrel] ${fallbackTold(run.role, child.title, from, why, to, newId)}`);
    };
    const failed = (error: unknown) => this.tell(child, 'attention', `${FAILED}${reason}. Kestrel could not give the part to "${to.name}": ${error instanceof Error ? error.message : String(error)}`, state0);
    const replay = inReplay();
    if (whenUnavailable(who) === 'auto' && !replay) {
      await go().catch(failed);
      return true;
    }
    // Asked where the work was handed out. Not awaited: the failed session's own events must not wait on the user.
    const { title, body } = fallbackAsk(run.role, from, why, to);
    const request: InputRequest = { id: `fallback-${randomUUID()}`, kind: 'approval', tool: 'delegate', title, detail: body, options: [{ id: 'allow', label: `Use ${to.name}`, role: 'allow' }, { id: 'deny', label: 'Not now', role: 'deny' }] };
    // A step, so a restart before the answer keeps the card; taken up again by `resumeStep`.
    const asked = asStep(this.rt.steps, link.parentId, { kind: 'fallback', childId: child.id, reason }, async () => {
      if (await this.rt.requestApproval(link.parentId, request)) await go().catch(failed);
      else await this.tell(child, 'attention', `${FAILED}${reason}. The user chose not to use "${to.name}" for it`, state0);
    });
    // Taken up after a restart, the answer is awaited, and a card that changed refuses (`Refused`).
    if (replay) await asked;
    else void asked.catch(failed);
    return true;
  }

  /**
   * Give a role's part to another preset. On the same agent the same session carries on, on the
   * new model, with its conversation and its worktree; on another agent a new session takes the
   * brief (a guest in the same worktree when the first was one). The new session's id, or null
   * when it is the same session.
   */
  private async giveTo(child: Session, parentId: string, run: RoleRun, from: ModelPreset, to: ModelPreset): Promise<string | null> {
    const rec = this.rt.recordOf(child.id);
    const tried = [...run.tried, to.id];
    if (to.agent === child.agent && rec) {
      rec.roleRun = { ...run, tried };
      await this.rt.reply(child.id, CARRY_ON, { model: to.model, effort: to.effort, fast: to.fast }, { fromAgent: true });
      return null;
    }
    const state = await this.ws.state();
    const project = state.projects.find((p) => p.id === child.startedIn);
    if (!project) throw new Refused('The session that failed has no project.');
    const folder = project.folders.find((f) => f.id === (state.sessions.find((x) => x.id === child.id)?.folderId ?? child.startedFolderId)) ?? null;
    const guest = rec?.guest ?? null;
    const host = guest ? state.sessions.find((s) => s.id === guest.hostId) : undefined;
    if (guest && !host) throw new Refused('The session whose worktree it worked in is gone.');
    await this.ws.checkLimits(parentId, 1, { depth: true });
    const { children } = await this.delegateIn(parentId, [{ projectId: project.id, folderId: folder?.id ?? null, brief: run.brief, agent: to.agent, title: child.title, ...(guest && host ? { hostId: host.id } : {}) }]);
    const next = children[0]!;
    this.noteStarted(parentId, next.id, 'delegate');
    const prompt = [guest && host ? guestIntro(guest.role, host.title) : '', takeoverIntro(from, guest !== null), run.brief].filter(Boolean).join('\n\n');
    const launched = await this.rt.launchChild(next, project, folder, prompt, 'delegate', to.model, this.modeOf(parentId), { effort: to.effort, fast: to.fast }, guest && host ? { guest, host } : undefined, { ...run, tried });
    if (!launched.ok) throw new Refused(launched.reason);
    return next.id;
  }

  /**
   * A session started other sessions, so it leads: it moves to the Orchestrate preset from its
   * next turn when that is on its own agent, and is told once why not when it is on another (a
   * session keeps its agent). A guest or a session started for a role keeps what it was given, and
   * so does a session whose model the user picked themselves.
   */
  private async lead(callerId: string, caller: Session): Promise<void> {
    const rec = this.rt.recordOf(callerId);
    if (!rec || rec.orchestrateTold || rec.guest || rec.roleRun || rec.modelChosen) return;
    const { move, preset } = orchestrateMove(orchestratorsOf(await this.rt.whoDoesWhat.current()), { agent: caller.agent, model: rec.settings.model, effort: rec.settings.effort, fast: rec.settings.fast });
    if (!preset || move === 'none' || move === 'already') return;
    rec.orchestrateTold = true;
    if (move === 'move') this.rt.moveSettings(callerId, { model: preset.model, effort: preset.effort, fast: preset.fast });
    this.rt.notice(callerId, orchestrateNotice(preset, move, caller.agent), 'info');
  }

  /** Who does a role, in words: its preset's name and what it is, else the session's own agent. */
  private async runnerName(session: Pick<Session, 'agent'>, role: Role): Promise<string> {
    const preset = presetForRole(await this.rt.whoDoesWhat.current(), role);
    return preset && preset.agent === session.agent ? `${preset.name} (${presetSummary(preset)})` : AGENT_LABEL[session.agent];
  }

  /** Who Build work is given to, when the user gave it to someone; null leaves what is left to the host. */
  private async buildRunner(): Promise<string | null> {
    const preset = presetForRole(await this.rt.whoDoesWhat.current(), 'build');
    return preset ? `"${preset.name}" (${presetSummary(preset)})` : null;
  }

  // ---- review (shared/worktree-guests.ts) --------------------------------------------------

  /** Authors whose answer to a round of findings is still queued behind a turn they were already on: that turn's end is not the answer. */
  private readonly answerQueued = new Set<string>();

  /**
   * Start a review of a session's work by the Review role's agent, in that session's worktree,
   * reading only. Asked for by the user (the Create pull request form), so it needs no card.
   */
  async startReview(authorId: string, opts: { comment?: boolean } = {}): Promise<Review> {
    const state = await this.ws.state();
    const author = state.sessions.find((s) => s.id === authorId);
    if (!author) throw new Refused('No such session.');
    // Its record is read from storage when this Kestrel has not opened it yet (after a restart).
    const rec = await this.rt.recordFor(author);
    if (!rec) throw new Refused(`"${author.title}" never got as far as running an agent, so there is no work of its to review.`);
    if (rec.review && rec.review.status !== 'done') throw new Refused(`${rec.review.reviewer} is already reviewing this work.`);
    if (!author.worktreePath || author.worktreeDiscarded) throw new Refused('A review reads a session\'s worktree, and this session has none.');
    if (author.state === 'running' || author.state === 'attention') throw new Refused(`"${author.title}" is still working. Ask for the review when it has finished.`);
    const { reviewer: preset, reason } = await this.reviewerFor(authorId);
    if (!preset) throw new Refused(reason);
    const project = state.projects.find((p) => p.id === author.startedIn);
    if (!project) throw new Refused('A review needs the session\'s project, and this session has none.');
    const folder = project.folders.find((f) => f.id === author.folderId) ?? null;
    await this.ws.checkLimits(authorId, 1, { depth: true });
    const reviewer = `${preset.name} (${presetSummary(preset)})`;
    const { children } = await this.delegateIn(authorId, [{ projectId: project.id, folderId: folder?.id ?? null, brief: `Review: ${author.title}`, agent: preset.agent, title: `Review: ${author.title}`, hostId: authorId }]);
    const child = children[0]!;
    this.noteStarted(authorId, child.id, 'delegate');
    const guest: Guest = { hostId: authorId, role: 'review', writes: false };
    // The reviewer runs its commands without a card each (it cannot change a file): Auto, whatever the author's mode.
    const launched = await this.rt.launchChild(child, project, folder, `${guestIntro('review', author.title)}\n\n${reviewBrief(rec.base)}`, 'delegate', preset.model, 'auto', { effort: preset.effort, fast: preset.fast }, { guest, host: author });
    if (!launched.ok) throw new Refused(`The review could not start: ${launched.reason}`);
    rec.review = { reviewerId: child.id, reviewer, round: 1, rounds: REVIEW_ROUNDS, status: 'reviewing', ...(opts.comment ? { comment: true } : {}) };
    this.rt.saveRecord(authorId);
    this.rt.notice(authorId, `${reviewer} is reviewing this work, in this worktree, without changing it (round 1 of ${REVIEW_ROUNDS}).${preset.agent === author.agent ? ` ${sameAgentNote(reviewer, AGENT_LABEL[preset.agent])}` : ''}`, 'info');
    return rec.review;
  }

  /**
   * Who would review a session's work, or why nobody can: the first reviewer the user set that did
   * not write any of it and whose agent is connected (shared/who-does-what.ts `pickReviewer`). The
   * authors are the session and every session that wrote in its worktree as its guest.
   */
  async reviewerFor(authorId: string): Promise<{ reviewer: ModelPreset | null; reason: string }> {
    const state = await this.ws.state();
    const author = state.sessions.find((s) => s.id === authorId);
    if (!author) return { reviewer: null, reason: 'No such session.' };
    const wrote: Author[] = [];
    const guests = state.links.filter((l) => l.parentId === authorId && l.kind === 'delegate').flatMap((l) => state.sessions.filter((s) => s.id === l.childId));
    for (const session of [author, ...guests]) {
      const rec = await this.rt.recordFor(session);
      if (session.id === authorId || rec?.guest?.writes) wrote.push({ agent: session.agent, model: rec?.settings.model ?? '' });
    }
    const all = reviewersOf(await this.rt.whoDoesWhat.current());
    const connected = all.filter((r) => this.rt.availableAgents().includes(r.agent));
    const reviewer = pickReviewer(connected, wrote);
    if (reviewer) return { reviewer, reason: '' };
    // Somebody could have reviewed, were its agent connected: say that, not that everyone wrote it.
    const waiting = pickReviewer(all, wrote);
    return { reviewer: null, reason: waiting ? `Review would go to "${waiting.name}" (${presetSummary(waiting)}), but ${AGENT_LABEL[waiting.agent]} is not connected.` : noReviewerReason(all, wrote) };
  }

  /** Where the review of a session's work stands; null when there has been none. */
  reviewOf(sessionId: string): Review | null {
    return this.rt.recordOf(sessionId)?.review ?? null;
  }

  /**
   * `post_review` from the reviewer of a session's own work: the round's findings, kept until its
   * turn ends (`reviewStep`), when they go to the author as a card. Null when `reviewerId` is not
   * reviewing a session's work, so the tool says what it is for instead.
   */
  async handOverRound(reviewerId: string, args: { verdict?: unknown; summary?: unknown; findings?: unknown; earlier?: unknown }): Promise<ToolResult | null> {
    const guest = this.rt.recordOf(reviewerId)?.guest;
    if (guest?.role !== 'review') return null;
    const author = this.rt.recordOf(guest.hostId);
    if (!author?.review || author.review.reviewerId !== reviewerId) return null;
    if (author.review.status !== 'reviewing') throw new Refused('This round of the review is over: there is nothing to hand findings over to now.');
    const problem = verdictProblem(args.verdict) ?? summaryProblem(args.summary, true);
    if (problem) throw new Refused(problem);
    const checked = freshFindings(args.findings);
    if ('problem' in checked) throw new Refused(checked.problem);
    // From the second round, every finding of the round before is accounted for: the open ones are carried forward, the same findings.
    const previous = this.lastRound(guest.hostId);
    const early = checkEarlier(args.earlier, previous?.findings ?? []);
    if ('problem' in early) throw new Refused(early.problem);
    const findings = carryForward(previous, early.earlier, checked.findings);
    const handed = { verdict: roundVerdict(args.verdict as ReviewVerdict, findings), summary: (args.summary as string).trim(), findings, ...(early.earlier.length > 0 ? { earlier: early.earlier } : {}) };
    author.review = { ...author.review, handed };
    this.rt.saveRecord(guest.hostId);
    const n = findings.length;
    const carried = findings.length - checked.findings.length;
    return { text: `Handed over: ${n} finding${n === 1 ? '' : 's'}${carried > 0 ? ` (${carried} still open from the round before)` : ''} for round ${author.review.round} of ${author.review.rounds}${handed.verdict === 'clean' ? ', nothing that must change' : ''}. Kestrel shows them to the user and gives them to the author when your turn ends. End your turn now and write nothing more.` };
  }

  /** The findings card of the last round of the review of `authorId`'s work, as it is now (the user may have dismissed some), or null. */
  private lastRound(authorId: string): RoundFindings | null {
    const rec = this.rt.recordOf(authorId);
    const id = rec?.review?.lastCard;
    return (id && rec?.messages.find((m) => m.id === id)?.roundFindings) || null;
  }

  /** The id of a session's latest message from its agent: where "Open the review" lands. */
  private lastAgentMessage(sessionId: string): string | undefined {
    return this.rt.recordOf(sessionId)?.messages.findLast((m) => m.author === 'agent' && m.id && m.text && !m.notice)?.id;
  }

  /**
   * One step of a review, when `session`'s turn ending is one: the reviewer finished a round (its
   * findings go to the author, or the review ends), or the author finished answering (the reviewer
   * looks again). True when the turn was a review's and needs no other report.
   */
  private async reviewStep(session: Session, state: 'done' | 'attention'): Promise<boolean> {
    const own = this.rt.recordOf(session.id);
    // The author finished answering a round of findings: the reviewer looks again.
    if (own?.review?.status === 'answering' && state === 'done') {
      if (this.answerQueued.delete(session.id)) return false; // it was busy when the findings came: this end is not the answer
      const review = { ...own.review, round: own.review.round + 1, status: 'reviewing' as const };
      own.review = review;
      this.rt.saveRecord(session.id);
      await this.rt.reply(review.reviewerId, nextRoundText(review, reportOf(this.rt.lastAgentText(session.id))), {}, { fromAgent: true }).catch((error: unknown) => this.endReview(session.id, 'findings', `It could not look again: ${error instanceof Error ? error.message : String(error)}`));
      return false; // the author's own parent, waiters and askers still hear of its turn
    }
    const guest = own?.guest;
    if (guest?.role !== 'review' || state !== 'done') return false;
    const author = this.rt.recordOf(guest.hostId);
    if (!author?.review || author.review.reviewerId !== session.id || author.review.status !== 'reviewing') return false;
    const said = reportOf(this.rt.lastAgentText(session.id));
    const { handed, said: saidBefore, ...review } = author.review;
    // Findings only in text are not taken: the reviewer is asked once to hand them over (Matt, 2026-11-24: what the user sees are findings).
    if (!handed && verdictOf(said) === 'findings' && review.asked !== review.round) {
      author.review = { ...review, asked: review.round, said };
      this.rt.saveRecord(guest.hostId);
      await this.rt.reply(session.id, handOverAgainText(review), {}, { fromAgent: true }).catch((error: unknown) => this.endReview(guest.hostId, 'findings', `It could not be asked for its findings: ${error instanceof Error ? error.message : String(error)}`));
      return true;
    }
    const card = this.roundCard(session.id, review, handed, review.asked === review.round ? (saidBefore ?? said) : null);
    const verdict = card ? card.verdict : verdictOf(said);
    const cardId = `round-findings-${session.id}-${review.round}`;
    const shown = card && (card.findings.length > 0 || card.summary || card.earlier?.length);
    author.review = { ...review, summary: clipSummary(card ? roundFindingsText(card) : said), ...(shown ? { lastCard: cardId } : {}) };
    if (card && shown) this.rt.showCard(guest.hostId, { type: 'card', id: cardId, roundFindings: card });
    if (verdict === 'clean' || author.review.round >= author.review.rounds) {
      await this.endReview(guest.hostId, verdict);
      return true;
    }
    author.review = { ...author.review, status: 'answering' };
    // The findings go to the agent as news with the turn the notice starts: the user reads them on the card.
    if (card) author.inbox = [...author.inbox, roundNews(card)];
    this.rt.saveRecord(guest.hostId);
    if (author.handle?.busy()) this.answerQueued.add(guest.hostId);
    // The turn that answers the findings is about this review: what it asks the user links here.
    author.newsFrom.push(session.id);
    // Sent as a turn of its own, not as news for its next turn: the author is woken even when this
    // Kestrel has no agent process for it yet (after a restart), and a busy author gets it next.
    await this.rt.reply(guest.hostId, card ? roundNotice(card) : findingsText(author.review, said), {}, { fromAgent: true }).catch((error: unknown) => this.endReview(guest.hostId, 'findings', `The session could not be given the findings: ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }

  /**
   * A round's card: what the reviewer handed over, or, when it was asked to and still answered only
   * in text (`textOnly`), its words as one unstructured finding beside the round before's findings,
   * carried forward since nobody said they were fixed. Null when nothing was handed over or owed.
   */
  private roundCard(reviewerId: string, review: Review, handed: Review['handed'], textOnly: string | null): RoundFindings | null {
    const head = { reviewer: review.reviewer, reviewerId, round: review.round, rounds: review.rounds, ...(this.lastAgentMessage(reviewerId) ? { at: this.lastAgentMessage(reviewerId)! } : {}) };
    if (handed) return { ...head, verdict: handed.verdict, summary: handed.summary, findings: handed.findings, ...(handed.earlier?.length ? { earlier: handed.earlier } : {}) };
    if (textOnly === null) return null;
    const previous = this.lastRound(this.rt.recordOf(reviewerId)!.guest!.hostId);
    const unknown = previous ? earlierUnknown(previous.findings) : [];
    const carried = carryForward(previous, unknown.map((e) => ({ ...e, status: 'open' as const })), []);
    return { ...head, verdict: 'findings', summary: '', findings: [...carried, unstructuredFinding(textOnly, review.reviewer, previous)], ...(unknown.length > 0 ? { earlier: unknown } : {}) };
  }

  /**
   * The review is over. Clean: a line says so. With findings: a card that stays above the message box
   * until the user carries on, and the session needs the user until they act (Matt, 2026-11-24: a
   * warning line scrolls away). Findings warn; they never block.
   */
  private async endReview(authorId: string, verdict: 'clean' | 'findings', problem = ''): Promise<void> {
    const rec = this.rt.recordOf(authorId);
    if (!rec?.review) return;
    rec.review = { ...rec.review, status: 'done', verdict };
    this.answerQueued.delete(authorId);
    this.rt.saveRecord(authorId);
    // The last round's findings are the findings: its card is drawn in full from now on.
    const last = rec.review.lastCard ? rec.messages.find((m) => m.id === rec.review!.lastCard) : undefined;
    if (last?.roundFindings && !last.roundFindings.final) this.rt.showCard(authorId, { type: 'card', id: last.id!, roundFindings: { ...last.roundFindings, final: true }, ...(last.at !== undefined ? { at: last.at } : {}) });
    // Posted to the pull request when that was asked for; a failure to post is said, and changes nothing else.
    const posted = rec.review.comment ? await this.rt.postToRequest(authorId, reviewComment(rec.review)).then((where) => (where ? `Posted to ${where}.` : ''), (error: unknown) => `It could not be posted to the pull request: ${error instanceof Error ? error.message : String(error)}`) : '';
    if (verdict === 'clean') return this.rt.notice(authorId, [reviewEndNotice(rec.review), problem, posted].filter(Boolean).join(' '), 'info');
    const { reviewer, reviewerId, round, lastCard } = rec.review;
    const at = this.lastAgentMessage(reviewerId);
    const end: ReviewEnd = { reviewer, reviewerId, rounds: round, ...(lastCard ? { card: lastCard } : {}), ...(at ? { at } : {}), state: 'open', ...(problem ? { problem } : {}) };
    this.rt.showCard(authorId, { type: 'card', id: reviewEndId(reviewerId), reviewEnd: end });
    if (posted) this.rt.notice(authorId, posted, 'info');
    const now = (await this.ws.state()).sessions.find((s) => s.id === authorId);
    if (now && now.state !== 'running' && now.state !== 'attention') await this.ws.setState(authorId, 'attention', REVIEW_END_NOTE, { activity: true });
  }

  /**
   * A role's part started by the user, from the message box ("Send to Design"): the brief is what
   * they typed, and it runs as a guest in this session's worktree, as a `delegate` with that role
   * would. No card: the user asked. Refused, with why, when the role has no agent, the session has
   * no worktree or is still working, or another session is writing here.
   */
  async startRole(hostId: string, role: Role, brief: string): Promise<Session> {
    const text = brief.trim();
    if (!text) throw new Refused(`Say what the ${ROLE_LABEL[role]} part is first.`);
    if (role === 'review') throw new Refused('A review is started from the Create pull request form.');
    const state = await this.ws.state();
    const host = state.sessions.find((s) => s.id === hostId);
    if (!host) throw new Refused('No such session.');
    if (!host.worktreePath || host.worktreeDiscarded) throw new Refused(`${ROLE_LABEL[role]} work is done in a session's worktree, and this session has none.`);
    if (host.state === 'running' || host.state === 'attention') throw new Refused(`"${host.title}" is still working, and one session writes in a worktree at a time. Send it when this session has finished.`);
    const runners = runnersOf(await this.rt.whoDoesWhat.current(), role);
    const first = runners[0];
    if (!first) throw new Refused(`No agent is set for ${ROLE_LABEL[role]}. Choose one in Settings → Models & roles → Who does what.`);
    // The user asked for it here, so the next choice is used without another card, and said.
    const preset = nextRunner(runners, [], this.rt.availableAgents());
    if (!preset) throw new Refused(`${ROLE_LABEL[role]} is set to "${first.name}" (${presetSummary(first)}), but ${AGENT_LABEL[first.agent]} is not connected${runners.length > 1 ? ', and neither is any of its fallbacks' : ''}.`);
    if (preset.id !== first.id) this.rt.notice(hostId, fallbackNotice(role, first, NOT_CONNECTED, preset, false), 'warning');
    const busy = writerRefusal(this.writerIn(hostId, state.sessions), 1);
    if (busy) throw new Refused(busy);
    const project = state.projects.find((p) => p.id === host.startedIn);
    if (!project) throw new Refused('This session has no project.');
    const folder = project.folders.find((f) => f.id === host.folderId) ?? null;
    await this.ws.checkLimits(hostId, 1, { depth: true });
    const { children } = await this.delegateIn(hostId, [{ projectId: project.id, folderId: folder?.id ?? null, brief: text, agent: preset.agent, title: titleFrom(text), hostId }]);
    const child = children[0]!;
    this.noteStarted(hostId, child.id, 'delegate');
    const launched = await this.rt.launchChild(child, project, folder, `${guestIntro(role, host.title)}\n\n${text}`, 'delegate', preset.model, this.modeOf(hostId), { effort: preset.effort, fast: preset.fast }, { guest: { hostId, role, writes: true }, host }, { role, brief: text, tried: runners.slice(0, runners.indexOf(preset) + 1).map((p) => p.id) });
    if (!launched.ok) throw new Refused(`The ${ROLE_LABEL[role]} session could not start: ${launched.reason}`);
    return child;
  }

  /** The delegate parent to tell about this state of its child, or null: none, a turn the user started, or already told. */
  private parentToTell(childId: string, state: 'done' | 'attention', state0: Awaited<ReturnType<Workspace['state']>>): string | null {
    const link = state0.links.find((l) => l.childId === childId && l.kind === 'delegate');
    if (!link || !parentHears({ byUser: this.rt.recordOf(childId)?.turnByUser === true })) return null;
    if (this.told.get(childId) === state) return null;
    this.told.set(childId, state);
    return link.parentId;
  }

  /** A session finished: every wait on it ends. Waiting on the user is not finished, so those stay. The waits that ended. */
  private async endWaits(target: Session): Promise<{ waiterId: string; reason: string }[]> {
    if (isOpenWork(target)) return [];
    const waits = waitsOnTarget(await this.ws.listWaits(), target.id);
    const ended: { waiterId: string; reason: string }[] = [];
    // Dropping is the once-only guard: a second report of the same finish finds nothing to drop.
    for (const wait of waits) if (await this.ws.dropWait(wait.waiterId, target.id)) ended.push({ waiterId: wait.waiterId, reason: wait.reason });
    return ended;
  }

  /**
   * Mark in the caller's conversation where it started another session: a row there, with that
   * session's state and a way to open it. It stays where it happened and scrolls away with the
   * rest; nothing is kept at the end of the conversation once the work is done.
   */
  private noteStarted(callerId: string, childId: string, kind: ChildOrigin): void {
    this.rt.showCard(callerId, { type: 'card', id: `started-${childId}`, started: { sessionId: childId, kind } });
  }

  private async deliver(parentId: string, text: string, fromId?: string): Promise<void> {
    const parent = (await this.ws.state()).sessions.find((s) => s.id === parentId);
    if (!parent) return;
    const rec = await this.rt.queueNews(parent, text, fromId);
    if (!rec) return;
    // No agent process this server run (interrupted, or never opened), or busy: it hears on its next turn.
    const idle = rec.handle !== null && !rec.handle.busy() && rec.pendingInput.size === 0 && parent.state === 'done' && !rec.stopped;
    if (idle) await this.drainInbox(parentId);
  }

  /** Give an idle session the news that queued up while it was busy. One turn for all of it. */
  async drainInbox(parentId: string): Promise<void> {
    const rec = this.rt.recordOf(parentId);
    if (!rec || rec.inbox.length === 0 || rec.stopped || !rec.handle || rec.handle.busy() || rec.pendingInput.size > 0) return;
    const parent = (await this.ws.state()).sessions.find((s) => s.id === parentId);
    if (!parent || parent.state !== 'done') return;
    const text = rec.inbox.join('\n');
    await this.rt.reply(parentId, text, {}, { notice: true }).catch((error) => console.error('[kestrel] could not wake', parentId, error));
  }

  // ---- stopping and moving ---------------------------------------------------------------

  /** Stopping a workstream stops every session it points at, and what those started. */
  async stopWorkstream(workstreamId: string): Promise<number> {
    const state = await this.ws.state();
    const workstream = state.workstreams.find((w) => w.id === workstreamId);
    if (!workstream) throw new Refused('No such workstream.');
    const ids = new Set<string>();
    for (const sessionId of workstream.sessionIds) for (const id of subtreeIds(sessionId, state.links)) ids.add(id);
    return this.rt.stopSessions([...ids]);
  }

  /** Stopping a folder stops every session in its tree. */
  async stopGroup(groupId: string): Promise<number> {
    const state = await this.ws.state();
    const ids = new Set<string>();
    for (const s of state.sessions) if (s.groupId === groupId) for (const id of subtreeIds(s.id, state.links)) ids.add(id);
    return this.rt.stopSessions([...ids]);
  }

  /** Ask the agent to write the summary for a manual move. Null when it cannot be asked. */
  async draftSummary(sessionId: string, projectName: string): Promise<string | null> {
    try {
      if (!(await this.rt.snapshot(sessionId))) return null;
      if (isWorking(this.rt.recordOf(sessionId))) throw new Refused('The session is still working. Stop it first, or write the summary yourself.');
      const finished = this.rt.awaitTurn(sessionId);
      await this.rt.reply(sessionId, SUMMARY_ASK(projectName), {}, { notice: true });
      await finished;
      return this.rt.lastAgentText(sessionId) || null;
    } catch (error) {
      if (error instanceof Refused && /still working/.test(error.message)) throw error;
      return null;
    }
  }

  /** A session's last message as another session is told it (`reportOf`), from its record or, with no agent this run, from storage. */
  private async lastReport(sessionId: string): Promise<string> {
    await this.rt.snapshot(sessionId);
    // A session with no agent behind it this run (sample data, one never reopened) has its conversation stored only.
    const said = this.rt.lastAgentText(sessionId) || lastAgentTextOf((await this.ws.storedDetail(sessionId))?.messages ?? []);
    return reportOf(said);
  }

  /** "Move to project": the same operation as the handoff tool, started by Matt. */
  /** `groupId`: a group in that project (or the Sessions list) for the new session; absent, it follows the usual rule. */
  async manualMove(sessionId: string, projectId: string, summary: string, groupId?: string | null): Promise<Session> {
    const session = await this.session(sessionId);
    const state = await this.ws.state();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) throw new Refused('No such project.');
    const text = summary.trim();
    if (!text) throw new Refused('Write a summary for the new session first.');
    if (isWorking(this.rt.recordOf(sessionId))) throw new Refused('The session is still working. Stop it first.');
    if (project.id === (session.landedIn ?? session.startedIn)) throw new Refused(`This session is already in ${project.name}.`);
    const folder = defaultFolder(project);
    if (folder) this.rt.checkPlainFolderFree(project, folder, state.sessions);
    const child = await this.ws.handoff(sessionId, { projectId, folderId: folder?.id ?? null, summary: text, title: titleFrom(text), markParentDone: true, ...(groupId === undefined ? {} : { groupId }) });
    this.noteStarted(sessionId, child.id, 'handoff');
    const launched = await this.rt.launchChild(child, project, folder, text, 'handoff', this.rt.recordOf(sessionId)?.settings.model ?? '', this.modeOf(sessionId));
    this.rt.notice(sessionId, `You moved this work to "${child.title}" in ${project.name}.`, 'info');
    if (!launched.ok) throw new Refused(`The new session was created but could not start: ${launched.reason}`);
    return child;
  }
}

/** What a session is told about another's turn, by why it is told (`turnReports`). */
function reportText(as: ReportRole, child: Session, t: { state: 'done' | 'attention'; detail: string; said: string; where: string; waitReason: string }): string {
  const name = `"${child.title}" (${child.id})`;
  const last = t.said ? ` Its last message: ${t.said}` : '';
  const needs = `needs attention (${t.detail}). The user has to act on it; you cannot answer for it.`;
  if (as === 'waiter') return `[Kestrel] The session ${name}, which you were waiting on (${t.waitReason}), finished.${last}`;
  if (as === 'asker') return t.state === 'done' ? `[Kestrel] The session ${name} finished the turn you asked it for.${last}` : `[Kestrel] The session ${name} that you asked ${needs}`;
  return t.state === 'done' ? `[Kestrel] Your delegated session ${name} in ${t.where} finished.${last}` : `[Kestrel] Your delegated session ${name} in ${t.where} ${needs}`;
}
