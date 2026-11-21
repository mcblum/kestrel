// Runs real agent sessions: creates the worktree, starts the adapter, keeps the live transcript,
// stores it, and files the session from git evidence. Streaming output leaves here on its own
// channel (`onLive`) and never goes through the workspace state.
//
// `SessionRuntime` is the one facade callers use. It owns the live records, the live channel and
// the side-effect chain, and hands the rest to the slices under `runtime/`, each given the part of
// `runtime/host.ts` it needs: `runtime/bring-up.ts` (starting, resuming and child sessions),
// `runtime/turns.ts` (the user's side of a turn: replies, the queue, cards, Stop),
// `runtime/events.ts` (what the agent reports, and a turn's end), `runtime/agent-options.ts` (an
// agent's options and the edit check), `runtime/agent-info.ts` (models, capabilities, slash
// commands, context use) and `runtime/session-worktrees.ts` (deleting sessions, discarding
// worktrees, Settings → Worktrees).
//
// The pieces around those: `runtime/record.ts` (the in-memory record of a session),
// `runtime/projects.ts` (registering folders), `runtime/upkeep.ts` (throttled storing, file
// refresh and row notes), `runtime/titling.ts` (short generated titles), `runtime/workdir.ts`
// (a new session's worktree, named from its title), `runtime/start-options.ts` (an agent's
// start options, the plain-folder rule, restart recovery), `delegation.ts`
// (handoff, delegate, spawn), `display.ts` (widgets, files, next steps and pictures shown in the
// conversation), `suggestions/` (optional actions the agent drops in), `browser-tools.ts` (the browser
// pane, driven through the window that shows it) and `sim-tools.ts` (the iOS Simulator, driven by the server itself).
import { commentOnPR } from './pull-requests/create.ts';
import { githubCommands } from './pull-requests/github.ts';
import { gitlabCommands } from './pull-requests/gitlab.ts';
import { REVIEW_KIND, reviewKind } from './suggestions/review-kind.ts';
import type { RequestLink } from './model.ts';
import type { Guest } from './shared/worktree-guests.ts';
import type { RoleRun } from './shared/who-does-what.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentCapabilities, InputAnswer, InputRequest, Intercept, KestrelToolHost, ToolAction } from './agents/types.ts';
import { AttachmentStore } from './attachments/store.ts';
import { BaseRefresh } from './base-refresh.ts';
import { BrowserBridge } from './browser-bridge.ts';
import { BrowserTools } from './browser-tools.ts';
import { CommitSigning } from './commit-signing/prefs.ts';
import { CrashReports } from './crash-reports/prefs.ts';
import { Delegation, type ChildOrigin } from './delegation.ts';
import { Display } from './display.ts';
import { Forks } from './fork.ts';
import { GitPrefs } from './git-settings/prefs.ts';
import { READ_ONLY_OMITTED, type McpSessions } from './kestrel-mcp.ts';
import { AGENT_LABEL, type Agent, type LivePatch, type Project, type ProjectFolder, type Session, type SessionDetail, type SessionSettings } from './model.ts';
import { OpenIn } from './open-in/prefs.ts';
import { ProjectEdits } from './project-edits/prefs.ts';
import { StartBase } from './start-base/prefs.ts';
import { CommandsKept } from './commands-kept/prefs.ts';
import { AgentInfo, type ModelList } from './runtime/agent-info.ts';
import { editVerdict, optionsFor, startOptions } from './runtime/agent-options.ts';
import { BackgroundWork } from './runtime/background.ts';
import { launchChild, loadRecord, startSession, type StartRequest } from './runtime/bring-up.ts';
import { githubByNumber, gitlabByNumber } from './pull-requests/by-number.ts';
import { git, originUrl } from './git.ts';
import { startReview } from './review-requests/start.ts';
import { ReviewReplies } from './review-requests/reply.ts';
import { ReviewPrefs } from './review-settings/prefs.ts';
import { execRunner } from './pull-requests/github.ts';
import type { ReviewRequest } from './shared/review-requests.ts';
import { moveKind } from './suggestions/move-kind.ts';
import { moveRefusal, moveToProject } from './runtime/move-project.ts';
import { Commands } from './runtime/commands.ts';
import { onAgentEvent, showImage } from './runtime/events.ts';
import type { RuntimeHost } from './runtime/host.ts';
import { systemProcesses } from './runtime/kill-task.ts';
import type { MidTurnHost } from './runtime/mid-turn.ts';
import { ensureProject, registerProject } from './runtime/projects.ts';
import { ProjectEnvPrefs } from './project-env/prefs.ts';
import { resolveEnv } from './project-env/resolve.ts';
import { KeepAwake } from './keep-awake/hold.ts';
import { WhoDoesWhatPrefs } from './who-does-what/prefs.ts';
import { CleanupPrefs } from './cleanup/prefs.ts';
import { MergeCleanup } from './cleanup/on-merge.ts';
import { NotifyPrefsStore } from './notifications/prefs.ts';
import { GitDefaultsPrefs } from './git-defaults/prefs.ts';
import { SavedActionsPrefs } from './saved-actions/prefs.ts';
import { ProjectScriptsPrefs } from './project-scripts/prefs.ts';
import { runArchive, type ScriptsHost } from './runtime/project-scripts.ts';
import type { ScriptOutcome } from './shared/project-scripts.ts';
import { clock, isWorking, lastAgentTextOf, noteFromText, type Live } from './runtime/record.ts';
import { SessionWorktrees } from './runtime/session-worktrees.ts';
import { assertPlainFolderFree, interruptAfterRestart } from './runtime/start-options.ts';
import { WorkStopper } from './runtime/stop-work.ts';
import { Titler } from './runtime/titling.ts';
import { answerCard, dropQueued, flushQueue, moveSettings, reply, sendQueued, stopTurn, type ReplyOptions } from './runtime/turns.ts';
import { Upkeep } from './runtime/upkeep.ts';
import type { RuntimeOptions } from './runtime/workdir.ts';
import { folderContext } from './sandbox-allow/context.ts';
import { SandboxAllowList } from './sandbox-allow/store.ts';
import { projectDirectory, scopeFolder, sessionDirectory } from './scope-folder.ts';
import { canRetry, retryMessage, type CommandOutput } from './shared/commands.ts';
import type { ContextUsage } from './shared/context-usage.ts';
import type { PermissionLevel } from './shared/permissions.ts';
import type { SessionQueue } from './shared/queue.ts';
import type { SlashCommand } from './shared/slash-commands.ts';
import type { BulkRemoval } from './shared/stale-worktrees.ts';
import { SimTools } from './sim-tools.ts';
import { Simulator } from './simulator.ts';
import { createSuggestions, type Suggestions } from './suggestions/index.ts';
import { titleFrom } from './title.ts';
import { appendOutput, applyToTranscript, outputLine, type TranscriptAction } from './transcript.ts';
import type { WorktreeList } from './worktree-cleanup.ts';
import { Refused, type Workspace } from './workspace.ts';

export type { ModelList } from './runtime/agent-info.ts';
export type { ReplyOptions } from './runtime/turns.ts';
export type { StartRequest } from './runtime/bring-up.ts';
export { titleFrom, noteFromText };

export class SessionRuntime implements McpSessions {
  private readonly records = new Map<string, Live>();
  private readonly listeners = new Set<(sessionId: string, patch: LivePatch) => void>();
  readonly delegation: Delegation;
  /** Fork a session: a copy of its conversation in a new session (fork.ts). */
  readonly forks: Forks;
  readonly display: Display;
  readonly browser: BrowserTools;
  readonly sim: SimTools;
  /** Generated session titles, in the background (runtime/titling.ts). */
  readonly titler: Titler;
  readonly suggestions: Suggestions;
  private readonly stopReviewOffer: () => void;
  /** Adds a comment to a pull request (pull-requests/create.ts `commentOnPR`); tests pass their own. */
  private readonly requestComment: NonNullable<RuntimeOptions['requestComment']>;
  /** Settings → Git: the branch name prefix new worktrees get (git-settings/prefs.ts). */
  readonly gitPrefs: GitPrefs;
  private readonly baseRefresh: BaseRefresh;
  /** Settings → Workflow: whether an edit to another project's file is refused (project-edits/prefs.ts). */
  readonly projectEdits: ProjectEdits;
  readonly startBase: StartBase;
  /** Each project's setup and archive scripts (project-scripts/prefs.ts), and what runs them. */
  readonly projectScripts: ScriptsHost;
  /** Variables, .env files and files copied into new worktrees (project-env/prefs.ts). */
  readonly projectEnv: ProjectEnvPrefs;
  /** Each project's saved actions (saved-actions/prefs.ts); run from a Terminal pane (terminal-socket.ts). */
  readonly savedActions: SavedActionsPrefs;
  /** Each project's base branch and remote (git-defaults/prefs.ts). */
  readonly gitDefaults: GitDefaultsPrefs;
  /** Settings → Workflow → Notifications (notifications/prefs.ts); the UI shows them (ui/src/notifier.ts). */
  readonly notifications: NotifyPrefsStore;
  /** What is done by itself when a session's pull request is merged (cleanup/). */
  readonly cleanupPrefs: CleanupPrefs;
  readonly mergeCleanup: MergeCleanup;
  private readonly stopMergeCleanup: () => void;
  /** The model presets and the "Who does what" table (who-does-what/prefs.ts). */
  readonly whoDoesWhat: WhoDoesWhatPrefs;
  /** Settings → Workflow → Keep awake: holds the Mac awake while any session is working (keep-awake/hold.ts). */
  readonly keepAwake: KeepAwake;
  private readonly stopKeepAwake: () => void;
  /** Settings → Workflow → Commands kept per session (commands-kept/prefs.ts). */
  readonly commandsKept: CommandsKept;
  /** The user's default "Open in" app (Settings → Workflow). */
  readonly openIn: OpenIn;
  /** Settings → Workflow: commands and folders always allowed outside a child's sandbox (sandbox-allow/). */
  readonly sandboxAllow: SandboxAllowList;
  /** Files the user attached to messages (attachments/store.ts). */
  readonly attachments: AttachmentStore;
  private readonly simShows = new Set<(sessionId: string, udid: string) => void>();
  private readonly upkeep: Upkeep;
  /** When turns start and end (shared/turns.ts), and when background work was first seen. */
  private readonly now: () => number;
  /** Work each session's agent left running in the background (runtime/background.ts). Live only. */
  readonly background: BackgroundWork;
  /** Every command each session's agent is running or ran (runtime/commands.ts). Live only. */
  readonly commands: Commands;
  /** Settings → Workflow → Commit signing: what a confined session's sandbox lets through to sign (commit-signing/). */
  readonly commitSigning: CommitSigning;
  /** Settings → General → Crash reports: whether a failure in Kestrel is reported (crash-reports/). */
  readonly crashReports: CrashReports;
  /** Settings → Git → Review requests (review-settings/prefs.ts). */
  readonly reviewPrefs: ReviewPrefs;
  /** The `post_review` tool, and posting a review card to its host (review-requests/reply.ts). */
  readonly reviewReplies: ReviewReplies;
  /** Stops one command or piece of background work on the user's word (runtime/stop-work.ts). */
  private readonly stopper: WorkStopper;
  /** Which agent each live session runs, for the words the Commands pane uses. */
  private readonly agents = new Map<string, Agent>();
  /** What the slices in runtime/ share (runtime/host.ts). */
  private readonly host: RuntimeHost;
  /** Deleting sessions, discarding worktrees, Settings → Worktrees (runtime/session-worktrees.ts). */
  private readonly checkouts: SessionWorktrees;
  /** Models, capabilities, slash commands and context use, asked of the agents (runtime/agent-info.ts). */
  private readonly info: AgentInfo;

  constructor(
    private readonly workspace: Workspace,
    private readonly adapters: Partial<Record<Agent, AgentAdapter>>,
    private readonly dataDir: string,
    opts: RuntimeOptions = {},
  ) {
    const simulator = opts.simulator ?? new Simulator({ dataDir });
    this.now = opts.now ?? Date.now;
    this.attachments = new AttachmentStore(dataDir);
    this.background = new BackgroundWork(this.now, (id, patch) => this.emitLive(id, patch));
    this.commandsKept = new CommandsKept(opts.commandsKept);
    this.commands = new Commands(
      this.now,
      (id, patch) => this.emitLive(id, patch),
      (id) => {
        // Stored with the conversation, on the same timer.
        const rec = this.records.get(id);
        if (rec) this.upkeep.schedulePersist(id, rec);
      },
      () => this.commandsKept.current(),
    );
    this.commitSigning = new CommitSigning(opts.commitSigning);
    this.crashReports = new CrashReports(opts.crashReports);
    this.reviewPrefs = new ReviewPrefs(opts.reviewPrefs);
    this.reviewReplies = new ReviewReplies({
      session: async (id) => (await workspace.state()).sessions.find((s) => s.id === id),
      messages: (id) => this.records.get(id)?.messages ?? [],
      showCard: (id, card) => this.showCard(id, card),
      notice: (id, text, level) => this.notice(id, text, level),
      settings: () => this.reviewPrefs.current(),
      byNumber: (host) => (host === 'github' ? githubByNumber() : gitlabByNumber()),
      run: opts.reviewRunner ?? execRunner,
      now: () => this.now(),
    });
    this.stopper = new WorkStopper(this.background, this.commands, opts.processes ?? systemProcesses);
    this.delegation = new Delegation(this, workspace, dataDir);
    this.display = new Display(
      {
        directoryOf: (id) => this.directoryOf(id),
        projectPaths: async () => (await workspace.state()).projects.flatMap((p) => p.folders.map((f) => f.path)),
        showCard: (id, card) => this.showCard(id, card),
        notice: (id, text, level) => this.notice(id, text, level),
      },
      dataDir,
    );
    this.browser = new BrowserTools(new BrowserBridge(), { notice: (id, text, level) => this.notice(id, text, level) });
    this.sim = new SimTools(simulator, {
      directoryOf: (id) => this.directoryOf(id),
      notice: (id, text, level) => this.notice(id, text, level),
      show: (id, udid) => this.simShows.forEach((l) => l(id, udid)),
    });
    this.requestComment = opts.requestComment ?? ((cwd, number, body, host) => commentOnPR(cwd, number, body, { commands: host === 'gitlab' ? gitlabCommands : githubCommands }));
    this.suggestions = createSuggestions(this, workspace, {
      ...opts.suggestions,
      kinds: [
        reviewKind({
          who: () => this.whoDoesWhat.current(),
          reviewerFor: async (id) => (await this.delegation.reviewerFor(id)).reviewer,
          reviewOf: (id) => this.delegation.reviewOf(id),
          start: (id) => this.delegation.startReview(id, { comment: true }),
          stopOffering: async () => void (await this.whoDoesWhat.set({ ...(await this.whoDoesWhat.current()), reviewOffer: false })),
        }),
        moveKind({
          where: (projectId, folderId) => this.delegation.whereIs(projectId, folderId),
          refusal: async (id) => {
            const session = (await workspace.state()).sessions.find((s) => s.id === id);
            return session ? this.moveRefusal(session) : 'No such session.';
          },
          move: (id, projectId, folderId) => this.delegation.moveNow(id, projectId, folderId),
        }),
      ],
    });
    this.stopReviewOffer = workspace.onRequestLinked((id, link) => this.offerReview(id, link));
    this.gitPrefs = new GitPrefs(opts.git);
    this.baseRefresh = new BaseRefresh({ enabled: () => this.gitPrefs.startFromLatest(), fetch: opts.baseFetch });
    this.projectEdits = new ProjectEdits(opts.projectEdits);
    this.startBase = new StartBase(opts.startBase);
    this.projectEnv = new ProjectEnvPrefs(opts.projectEnv);
    this.savedActions = new SavedActionsPrefs(opts.savedActions);
    this.gitDefaults = new GitDefaultsPrefs(opts.gitDefaults);
    this.notifications = new NotifyPrefsStore(opts.notifications);
    this.cleanupPrefs = new CleanupPrefs(opts.cleanup);
    this.mergeCleanup = new MergeCleanup({
      policies: () => this.cleanupPrefs.all(),
      session: async (id) => (await workspace.state()).sessions.find((s) => s.id === id) ?? null,
      checkoutOf: (id) => this.checkoutOf(id),
      runArchiveScript: (id) => this.runArchiveScript(id),
      discardWorktree: (id, deleteBranch) => this.discardWorktree(id, deleteBranch),
      archive: (id) => workspace.setArchived('session', id, true),
      notice: (id, text) => this.notice(id, text, 'info'),
    });
    this.stopMergeCleanup = workspace.onMerged((id) => void this.mergeCleanup.merged(id));
    this.whoDoesWhat = new WhoDoesWhatPrefs(opts.whoDoesWhat);
    this.keepAwake = new KeepAwake({ ...opts.keepAwake, working: async () => (await workspace.state()).sessions.some((s) => s.state === 'running') });
    // Asked again whenever anything changes: a session starting or ending is such a change.
    this.stopKeepAwake = workspace.onChange(() => void this.keepAwake.refresh().catch(() => undefined));
    this.projectScripts = { scripts: new ProjectScriptsPrefs(opts.projectScripts), run: opts.projectScripts?.run };
    this.openIn = new OpenIn(opts.openIn);
    this.sandboxAllow = new SandboxAllowList({ settings: opts.sandboxAllow?.settings, context: () => folderContext(workspace, dataDir) });
    this.titler = new Titler(workspace, opts.titleProviders, opts.titleWait, undefined, (id, tags) => this.suggestions.fromTitle(id, tags));
    this.upkeep = new Upkeep(workspace, (id, patch) => this.emitLive(id, patch), (rec, work) => this.queue(rec, work), (id) => this.commands.stored(id));
    this.forks = this.makeForks();
    this.host = this.makeHost();
    this.checkouts = new SessionWorktrees(this.host);
    this.info = new AgentInfo(this.host);
  }

  /** What the runtime's slices share (runtime/host.ts), built once. */
  private makeHost(): RuntimeHost {
    return {
      workspace: this.workspace,
      adapters: this.adapters,
      dataDir: this.dataDir,
      records: this.records,
      agents: this.agents,
      upkeep: this.upkeep,
      background: this.background,
      commands: this.commands,
      attachments: this.attachments,
      delegation: this.delegation,
      display: this.display,
      browser: this.browser,
      titler: this.titler,
      gitPrefs: this.gitPrefs,
      baseRefresh: this.baseRefresh,
      projectEdits: this.projectEdits,
      startBase: this.startBase,
      projectScripts: this.projectScripts,
      projectEnv: this.projectEnv,
      whoDoesWhat: this.whoDoesWhat,
      gitDefaults: this.gitDefaults,
      sandboxAllow: this.sandboxAllow,
      commitSigning: this.commitSigning,
      midTurn: this.midTurnHost,
      now: () => this.now(),
      mcpAccess: () => this.mcpAccess,
      emitLive: (id, patch) => this.emitLive(id, patch),
      apply: (id, rec, action) => this.apply(id, rec, action),
      queue: (rec, work) => this.queue(rec, work),
      setQueue: (id, rec, queue) => this.setQueue(id, rec, queue),
      notice: (id, text, level) => this.notice(id, text, level),
      onEvent: (id, rec, event) => onAgentEvent(this.host, id, rec, event),
      flushQueue: (id) => flushQueue(this.host, id),
      endRunning: (id) => this.endRunning(id),
      idle: (id) => this.idle(id),
      scratch: () => this.scratch(),
      sessionOrThrow: (id) => this.sessionOrThrow(id),
      recordFor: (session) => this.recordFor(session),
      checkPlainFolderFree: (project, folder, sessions, except) => this.checkPlainFolderFree(project, folder, sessions, except),
      toolHost: (id) => this.toolHost(id),
      optionsFor: (session, rec, forTurn) => optionsFor(this.host, session, rec, forTurn),
      startOptions: (...args) => startOptions(this.host, ...args),
    };
  }

  /** What forking needs from here (fork.ts); kept here so the rest of the runtime does not change for it. */
  private makeForks(): Forks {
    return new Forks({
      workspace: this.workspace,
      dataDir: this.dataDir,
      adapterFor: (agent) => this.adapters[agent],
      isWorking: (id) => isWorking(this.records.get(id)),
      conversation: async (id) => {
        const live = this.overlay(id);
        return live ? { ...live, slashCommands: this.records.get(id)!.slashCommands } : this.workspace.storedDetail(id);
      },
      directoryOf: (id) => this.directoryOf(id),
      checkPlainFolderFree: (project, folder, sessions) => this.checkPlainFolderFree(project, folder, sessions),
      branchPrefix: () => this.gitPrefs.prefixForNewBranch(),
      sessionFolders: (id) => [this.display.mediaDir(id), this.attachments.sessionDir(id)],
    });
  }

  /** A simulator tool ran for a session: windows showing it bring up the Simulator view on that device. */
  onSimShow(listener: (sessionId: string, udid: string) => void): () => void {
    this.simShows.add(listener);
    return () => this.simShows.delete(listener);
  }

  /** A picture the user took (of the simulator), put into the session's conversation. */
  async showPicture(sessionId: string, image: { mediaType: string; data: string }): Promise<void> {
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    const rec = session ? await this.recordFor(session) : null;
    if (!rec) throw new Refused('No such session.');
    showImage(this.host, sessionId, rec, { type: 'image', id: `user-${randomUUID()}-0`, ...image });
  }

  onLive(listener: (sessionId: string, patch: LivePatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Which agents Kestrel has an adapter for. Whether one can start right now is `agentAvailability`. */
  availableAgents(): Agent[] {
    return this.info.agents();
  }

  /** Which agents can start a session now (installed, signed in), and for the others why not. */
  agentAvailability(): Promise<{ available: Agent[]; notes: Partial<Record<Agent, string>> }> {
    return this.info.availability();
  }

  /** Where an out-of-process agent reaches a session's Kestrel tools (set once the HTTP server's port and token are known). */
  private mcpAccess: ((sessionId: string) => { url: string; token: string }) | null = null;
  setMcpAccess(access: (sessionId: string) => { url: string; token: string }): void {
    this.mcpAccess = access;
  }

  /** A loaded session's Kestrel tools, for the MCP endpoint (kestrel-mcp.ts). */
  toolsFor(sessionId: string): { host: KestrelToolHost; omit: readonly string[] } | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    return { host: this.toolHost(sessionId), omit: rec.settings.permission === 'readonly' ? READ_ONLY_OMITTED : [] };
  }

  /** Everything a watcher needs to start from; loads the session into memory if it is only stored. */
  async snapshot(sessionId: string): Promise<LivePatch | null> {
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const backgroundTasks = this.background.list(sessionId);
    // A session with no agent behind it can still show sample background work. The live state the
    // window builds from this stands in for the stored conversation, so that goes along too.
    if (!(await this.recordFor(session))) return backgroundTasks.length > 0 ? { ...(await this.storedSnapshot(sessionId, backgroundTasks)), commands: this.commands.list(sessionId) } : null;
    const { messages, files, agentOutput, kestrelTools, kestrelMissing, settings, queue } = this.overlay(sessionId)!;
    const rec = this.records.get(sessionId)!;
    // A session with no command list yet (it last ran before Kestrel kept one, or the list was empty)
    // is asked for one now, without a turn, so "/" works as soon as it is opened.
    this.info.askSlashCommands(session, rec);
    // Opening a session looks at its worktree again: files changed outside a turn (in the terminal,
    // or before a base was recovered for a branch made inside the worktree) show without waiting for one.
    this.upkeep.scheduleRefresh(sessionId, rec);
    return { messages, files, filesProblem: rec.filesProblem, agentOutput, kestrelTools, kestrelMissing, settings, queue, subagents: rec.subagents, subagentsAfter: rec.subagentsAfter, backgroundTasks, commands: this.commands.list(sessionId), slashCommands: rec.slashCommands };
  }

  /** What is stored for a session with no agent behind it, with its (sample) background work. */
  private async storedSnapshot(sessionId: string, backgroundTasks: LivePatch['backgroundTasks']): Promise<LivePatch> {
    const stored = await this.workspace.storedDetail(sessionId);
    if (!stored) return { backgroundTasks };
    const { files, agentOutput, kestrelTools } = stored;
    // Sample messages have no ids; a window that watches twice must replace them, not add them again.
    const messages = stored.messages.map((m, i) => (m.id === undefined ? { ...m, id: `stored-${i}` } : m));
    return { messages, files, agentOutput, kestrelTools, kestrelMissing: stored.kestrelMissing ?? [], backgroundTasks };
  }

  /** The in-memory state of a live session, if it has one; newer than what is stored. */
  overlay(sessionId: string): Pick<SessionDetail, 'messages' | 'files' | 'agentOutput' | 'kestrelTools' | 'kestrelMissing' | 'agentSessionId' | 'settings' | 'queue' | 'usage'> | null {
    const rec = this.records.get(sessionId);
    return rec ? { messages: rec.messages, files: rec.files, agentOutput: rec.agentOutput, kestrelTools: rec.kestrelTools, kestrelMissing: rec.kestrelMissing, agentSessionId: rec.agentSessionId, settings: rec.settings, queue: rec.queue, ...(rec.usage ? { usage: rec.usage } : {}) } : null;
  }

  /** Resolves when every queued side effect for the session has run. For tests and shutdown. */
  async idle(sessionId: string): Promise<void> {
    const rec = this.records.get(sessionId);
    if (rec?.launching) await rec.launching;
    while (rec) {
      const chain = rec.chain;
      await chain;
      if (rec.chain === chain) return;
    }
  }

  /** The models an agent offers. Cached once it has answered from the SDK (runtime/agent-info.ts). */
  models(agent: Agent): Promise<ModelList> {
    return this.info.models(agent);
  }

  /** The slash commands a new session in this project would offer, for the new-session box (runtime/agent-info.ts). */
  draftSlashCommands(agent: Agent, projectId: string | null, folderId: string | null): Promise<SlashCommand[]> {
    return this.info.draftSlashCommands(agent, projectId, folderId);
  }

  /** What an agent offers for the controls under the message box (agents/types.ts, AgentCapabilities). */
  capabilities(agent: Agent): Promise<AgentCapabilities> {
    return this.info.capabilities(agent);
  }

  /** How full a session's context window is, or null while it cannot be known (runtime/agent-info.ts). */
  contextUsage(sessionId: string): Promise<ContextUsage | null> {
    return this.info.contextUsage(sessionId);
  }

  // ---- projects -----------------------------------------------------------------------

  registerProject(path: string, name?: string): Promise<Project> {
    return registerProject(this.workspace, path, name);
  }

  ensureProject(path: string): Promise<{ project: Project; created: boolean }> {
    return ensureProject(this.workspace, path);
  }

  // ---- sessions ------------------------------------------------------------------------

  /**
   * A new session: its row at once, then its worktree and agent, in the background in a git project
   * (runtime/bring-up.ts). A failure to start the agent elsewhere is thrown.
   */
  start(req: StartRequest): Promise<Session> {
    return startSession(this.host, req);
  }

  /**
   * Start reviewing a request somebody asked the user to review, or give back the review already
   * started (review-requests/start.ts): a session in the request's project, at the request's commit.
   */
  startReview(request: ReviewRequest): Promise<Session> {
    return startReview(
      {
        projects: async () => (await this.workspace.state()).projects,
        sessions: async () => (await this.workspace.state()).sessions,
        originOf: originUrl,
        git,
        byNumber: (host) => (host === 'github' ? githubByNumber() : gitlabByNumber()),
        who: () => this.whoDoesWhat.current(),
        connectedAgents: () => this.availableAgents(),
        start: ({ effort, fast, ...req }) => this.start({ ...req, ...(effort ? { effort } : {}), ...(fast ? { fast: true } : {}) }),
      },
      request,
    );
  }

  /**
   * A message for the agent: into the running turn ('delivered'), held for the next one ('queued'),
   * or a new turn ('sent'). A notice is refused while the agent works (runtime/turns.ts).
   */
  reply(sessionId: string, text: string, change: Partial<SessionSettings> = {}, opts: ReplyOptions = {}): Promise<'sent' | 'delivered' | 'queued'> {
    return reply(this.host, sessionId, text, change, opts);
  }

  /** What the mid-turn messages need from here (runtime/mid-turn.ts). */
  private readonly midTurnHost: MidTurnHost = {
    apply: (id, rec, action) => this.apply(id, rec, action),
    emitLive: (id, patch) => this.emitLive(id, patch),
    setQueue: (id, rec, queue) => this.setQueue(id, rec, queue),
    forAgent: (id, attachments) => this.attachments.forAgent(id, attachments),
  };

  /** Send what is queued now, as one turn: "Send now" after a stop, a failure or a restart. */
  sendQueued(sessionId: string): Promise<void> {
    return sendQueued(this.host, sessionId);
  }

  /** Drop one queued message before it is sent. */
  removeQueued(sessionId: string, messageId: string): Promise<void> {
    return dropQueued(this.host, sessionId, messageId);
  }

  /**
   * News for a session from one it started. It waits for the session's next turn and is stored
   * with the conversation, so a restart does not lose it; a session not opened in this server
   * run is loaded for it. Null when the session never got an agent, so there is no one to tell.
   */
  async queueNews(session: Session, text: string): Promise<Live | null> {
    const rec = await this.recordFor(session);
    if (!rec) return null;
    rec.inbox = [...rec.inbox, text];
    this.upkeep.schedulePersist(session.id, rec);
    return rec;
  }

  /** `asker` asked this session for work (`ask_session`) and is told how its turn ends. Stored, so a restart does not lose it. */
  async addAsker(session: Session, askerId: string): Promise<void> {
    const rec = await this.recordFor(session);
    if (!rec || rec.askers.includes(askerId)) return;
    rec.askers = [...rec.askers, askerId];
    this.upkeep.schedulePersist(session.id, rec);
  }

  /** Who asked this session for work and has not been told: each is told once, so the list empties. */
  async takeAskers(session: Session): Promise<string[]> {
    const rec = await this.recordFor(session);
    if (!rec || rec.askers.length === 0) return [];
    const askers = rec.askers;
    rec.askers = [];
    this.upkeep.schedulePersist(session.id, rec);
    return askers;
  }

  private setQueue(id: string, rec: Live, queue: SessionQueue): void {
    if (queue === rec.queue) return;
    rec.queue = queue;
    this.emitLive(id, { queue });
    this.upkeep.schedulePersist(id, rec);
  }

  /**
   * What a session's agent ran and read since the user last wrote: its commands in full, and its
   * tool calls as shown. For telling where it has been working (shared/session-move.ts).
   */
  turnWork(sessionId: string): string[] {
    const messages = this.records.get(sessionId)?.messages ?? [];
    const from = messages.findLastIndex((m) => m.author === 'you');
    const calls = messages.slice(from + 1).flatMap((m) => (m.activity ?? []).map((a) => a.text));
    return [...calls, ...this.commands.list(sessionId).map((c) => c.command ?? '')];
  }

  /** Why a session cannot move itself into a project, or null (runtime/move-project.ts). */
  moveRefusal(session: Session): string | null {
    return moveRefusal(this.host, session, this.records.get(session.id));
  }

  /** A session with no project moves into one, keeping its conversation (runtime/move-project.ts). Between turns only. */
  async moveToProject(sessionId: string, project: Project, source: ProjectFolder): Promise<{ directory: string; branch: string | null }> {
    const session = await this.host.sessionOrThrow(sessionId);
    const rec = await this.recordFor(session);
    if (!rec) throw new Refused('This session has no conversation to move yet.');
    if (isWorking(rec)) throw new Refused('The session is still working; it moves when its turn has ended.');
    const from = (await this.directoryOf(sessionId)) ?? this.host.scratch();
    return moveToProject(this.host, session, rec, project, source, from);
  }

  /** Kestrel changes a session's model, effort or fast mode while its turn runs; it takes effect with its next turn (runtime/turns.ts). */
  moveSettings(sessionId: string, change: Partial<SessionSettings>): void {
    const rec = this.records.get(sessionId);
    if (rec) moveSettings(this.host, sessionId, rec, change);
  }

  /** The user answered a card (runtime/turns.ts). */
  answer(sessionId: string, requestId: string, answer: InputAnswer): Promise<void> {
    return answerCard(this.host, sessionId, requestId, answer);
  }

  /** Stop a running turn, or abandon a start still under way (runtime/turns.ts). */
  stop(sessionId: string): Promise<void> {
    return stopTurn(this.host, sessionId);
  }

  /** Nothing the agent's process ran is running any more: the background strip empties and the Commands pane marks them stopped. */
  private endRunning(sessionId: string): void {
    this.background.clear(sessionId);
    this.commands.endAll(sessionId, 'stopped');
  }

  /** What one command printed (runtime/commands.ts). */
  async commandOutput(sessionId: string, commandId: string): Promise<CommandOutput> {
    const session = await this.sessionOrThrow(sessionId);
    return this.commands.output(sessionId, commandId, this.records.get(sessionId)?.handle, AGENT_LABEL[session.agent]);
  }

  /**
   * "Retry command" on a command that has ended: the session's agent is told which command to run
   * again (shared/commands.ts, `retryMessage`), as a message from the user. Into the running turn
   * like any other while the agent works. Refused for a command still running, or one no longer listed.
   */
  async retryCommand(sessionId: string, commandId: string): Promise<'sent' | 'delivered' | 'queued'> {
    const session = await this.sessionOrThrow(sessionId);
    await this.recordFor(session);
    const command = this.commands.list(sessionId).find((c) => c.id === commandId);
    if (!command) throw new Refused('That command is not listed for this session any more.');
    if (!canRetry(command)) throw new Refused('That command is still running. Stop it first, or wait for it to end.');
    const output = await this.commands.output(sessionId, commandId, this.records.get(sessionId)?.handle, AGENT_LABEL[session.agent]).catch(() => ({ text: '' }));
    return this.reply(sessionId, retryMessage(command, output.text));
  }

  /** Stop one command: the background work it became (runtime/stop-work.ts); refused with the reason otherwise. */
  async stopCommand(sessionId: string, commandId: string): Promise<void> {
    const session = await this.sessionOrThrow(sessionId);
    await this.stopper.stopCommand({ sessionId, handle: this.records.get(sessionId)?.handle, agentName: AGENT_LABEL[session.agent] }, commandId);
  }

  /** Stop one piece of background work the session's agent left running (runtime/stop-work.ts). */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    const session = await this.sessionOrThrow(sessionId);
    await this.stopper.stop({ sessionId, taskId, handle: this.records.get(sessionId)?.handle, agentName: AGENT_LABEL[session.agent] });
  }

  /** Delete a session for good, with its worktree; its branch stays when it holds work (runtime/session-worktrees.ts). */
  deleteSession(sessionId: string): Promise<void> {
    return this.checkouts.deleteSession(sessionId);
  }

  /** At startup: mark sessions whose worktree folder is gone; says how many (runtime/session-worktrees.ts). */
  markLostWorktrees(): Promise<number> {
    return this.checkouts.markLostWorktrees();
  }

  /** At startup: every project's repository forgets worktrees whose folders are gone. */
  pruneWorktrees(): Promise<void> {
    return this.checkouts.pruneWorktrees();
  }

  /** A session's worktree and the main checkout it was cut from; refused, saying why, when it has none. */
  checkoutOf(sessionId: string): Promise<{ session: Session; checkout: string; worktree: string; branch: string }> {
    return this.checkouts.checkoutOf(sessionId);
  }

  /** Every session worktree on disk, with its size and whether it is suggested for cleanup (worktree-cleanup.ts). */
  worktrees(refresh = false): Promise<WorktreeList> {
    return this.checkouts.worktrees(refresh);
  }

  /** Remove several worktrees in one go (shared/stale-worktrees.ts; runtime/worktree-list.ts says which and how). */
  removeWorktrees(which: BulkRemoval): Promise<{ removed: number; failed: { title: string; reason: string }[] }> {
    return this.checkouts.removeWorktrees(which);
  }

  /** Remove a session's worktree (and its branch when asked), ending its agent; the session stays, marked discarded. */
  discardWorktree(sessionId: string, deleteBranch: boolean): Promise<void> {
    return this.checkouts.discardWorktree(sessionId, deleteBranch);
  }

  /**
   * Before a session is archived: its project's archive script, run in its worktree. Null when there
   * is nothing to run, or the session is still working (archiving is refused for that anyway).
   */
  async runArchiveScript(sessionId: string): Promise<ScriptOutcome | null> {
    const state = await this.workspace.state();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session || session.state === 'running' || session.state === 'attention') return null;
    const { env } = await resolveEnv(await this.projectEnv.all(), session.startedIn, state.projects.find((p) => p.id === session.startedIn)?.folders.find((f) => f.id === session.startedFolderId)?.path ?? null);
    return runArchive(this.projectScripts, session, state.projects, env);
  }

  /** After a restart no agent process exists: running sessions are interrupted, open prompts abandoned. */
  recoverAfterRestart(): Promise<number> {
    return interruptAfterRestart(this.workspace);
  }

  async shutdown(): Promise<void> {
    this.stopKeepAwake();
    this.stopReviewOffer();
    this.stopMergeCleanup();
    this.keepAwake.stop();
    for (const rec of this.records.values()) {
      this.upkeep.cancelRefresh(rec);
      this.upkeep.cancelNote(rec);
    }
    await Promise.all([...this.records.values()].map((r) => r.handle?.stop().catch(() => undefined)));
    // Agents that keep a process per session (Codex) end it.
    await Promise.all([...this.records.values()].map((r) => r.handle?.close?.().catch(() => undefined)));
    await Promise.all([...this.records.entries()].map(([id, r]) => this.upkeep.flush(id, r)));
  }

  // ---- internals -------------------------------------------------------------------------

  /** The shared scratch folder sessions without a directory work in, made when first needed. */
  private scratch(): string {
    const folder = join(this.dataDir, 'scratch');
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  private async sessionOrThrow(id: string): Promise<Session> {
    const session = (await this.workspace.state()).sessions.find((s) => s.id === id);
    if (!session) throw new Refused(`No such session: ${id}`);
    return session;
  }

  /** The live record, loaded from storage when the session predates this server run (runtime/bring-up.ts). */
  async recordFor(session: Session): Promise<Live | null> {
    return this.records.get(session.id) ?? loadRecord(this.host, session);
  }

  /** A plain folder has no worktree, so two editing sessions would trample each other. */
  checkPlainFolderFree(project: Project, folder: ProjectFolder, sessions: readonly Session[], except?: string): void {
    assertPlainFolderFree(project, folder, sessions, (id) => this.records.get(id), except);
  }

  /** The folder a pane's scope opens in (scope-folder.ts); for a project, directory `folderId` or its default. */
  async folderOf(scopeKey: string, folderId?: string | null): Promise<string | null> {
    return scopeFolder(scopeKey, {
      sessionFolder: (id) => this.directoryOf(id),
      projectFolder: async (id) => projectDirectory((await this.workspace.state()).projects, id, folderId),
    });
  }

  /** The folder a session works in: its worktree, its plain directory, or the shared scratch folder. */
  async directoryOf(sessionId: string): Promise<string | null> {
    return sessionDirectory(await this.workspace.state(), sessionId, join(this.dataDir, 'scratch'));
  }

  /**
   * Whether a file edit may go ahead (runtime/agent-options.ts): refused, with what to do instead,
   * when the file is inside another session's worktree or another registered project.
   */
  editVerdict(sessionId: string, ownProjectId: string | null, directory: string, action: ToolAction): Promise<Intercept> {
    return editVerdict(this.host, sessionId, ownProjectId, directory, action);
  }

  /** The Kestrel tools one session gets (delegation, display, suggestions, browser, simulator). */
  private toolHost(sessionId: string): KestrelToolHost {
    return { ...this.delegation.hostFor(sessionId), ...this.display.hostFor(sessionId), ...this.reviewReplies.hostFor(sessionId), ...this.suggestions.hostFor(sessionId), ...this.browser.hostFor(sessionId), ...this.sim.hostFor(sessionId) };
  }

  private queue(rec: Live, work: () => Promise<unknown>): void {
    rec.chain = rec.chain.then(work).catch((error) => console.error('[kestrel] session side effect failed', error));
  }

  /** Run an action through the transcript and send what changed on the live channel. */
  private apply(id: string, rec: Live, action: TranscriptAction): void {
    const { messages, changed } = applyToTranscript(rec.messages, action, clock(), this.now());
    rec.messages = messages;
    const patch: LivePatch = {};
    if (changed.length) patch.messages = changed;
    if (action.type !== 'user' && action.type !== 'resolved' && action.type !== 'settled' && action.type !== 'notice' && action.type !== 'card' && action.type !== 'withdrawn') {
      const line = outputLine(action);
      if (line) {
        rec.agentOutput = appendOutput(rec.agentOutput, line);
        patch.agentOutput = rec.agentOutput;
      }
    }
    this.emitLive(id, patch);
    this.upkeep.schedulePersist(id, rec);
  }

  private emitLive(id: string, patch: LivePatch): void {
    if (Object.keys(patch).length === 0) return;
    for (const l of this.listeners) l(id, patch);
  }

  /** Put a widget, file, next-step or suggestion card into a session's conversation. */
  showCard(sessionId: string, card: Extract<TranscriptAction, { type: 'card' }>): void {
    const rec = this.records.get(sessionId);
    if (rec) this.apply(sessionId, rec, card);
  }

  // ---- used by Delegation ---------------------------------------------------------------------

  /** The in-memory record of a session, if it has one this server run. */
  /**
   * Adds a comment to the session's newest open pull request, from its worktree. Resolves with
   * where it went ("#12"), or null when the session has no open request; throws the host's reason.
   */
  async postToRequest(sessionId: string, body: string): Promise<string | null> {
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    const links = await this.workspace.requestLinks(sessionId);
    const link = [...links].reverse().find((l) => l.state === 'open' || l.state === 'draft') ?? links.at(-1);
    if (!session?.worktreePath || !link) return null;
    await this.requestComment(session.worktreePath, link.number, body, link.host);
    return `${link.host === 'gitlab' ? '!' : '#'}${link.number}`;
  }

  /** Sessions whose pull request the Create form just made: the user was asked about a review there. */
  private readonly formRequests = new Set<string>();

  /** The Create pull request form made a request for this session (pull-requests/create-api.ts). */
  noteFormRequest(sessionId: string): void {
    this.formRequests.add(sessionId);
  }

  /** A request was linked to a session: when its agent opened it, the user is offered a review (suggestions/review-kind.ts). */
  private offerReview(sessionId: string, link: RequestLink): void {
    if (this.formRequests.delete(sessionId)) return;
    if (link.state !== 'open' && link.state !== 'draft') return;
    void this.suggestions.suggest(sessionId, { kind: REVIEW_KIND });
  }

  /** Store a session's record soon: something kept with it changed (its review, say). */
  saveRecord(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (rec) this.upkeep.schedulePersist(sessionId, rec);
  }

  recordOf(sessionId: string): Live | undefined {
    return this.records.get(sessionId);
  }

  /** Text of the agent's latest message, for "what did it say". */
  lastAgentText(sessionId: string): string {
    return lastAgentTextOf(this.records.get(sessionId)?.messages ?? []);
  }

  /** A line from Kestrel in a session's conversation: a refusal, news from another session. */
  notice(sessionId: string, text: string, level: 'info' | 'warning' | 'error'): void {
    const rec = this.records.get(sessionId);
    if (rec) this.apply(sessionId, rec, { type: 'notice', id: `notice-${randomUUID()}`, text, level });
  }

  /** Show an approval card in the caller's conversation and wait for the user's choice. */
  requestApproval(sessionId: string, request: InputRequest): Promise<boolean> {
    const rec = this.records.get(sessionId);
    if (!rec) return Promise.resolve(false);
    return new Promise((resolve) => {
      rec.kestrelRequests.set(request.id, resolve);
      this.host.onEvent(sessionId, rec, { type: 'needs-input', request });
    });
  }

  /** Resolves when the session's running turn ends (done or failed). */
  awaitTurn(sessionId: string): Promise<void> {
    const rec = this.records.get(sessionId);
    return rec ? new Promise((resolve) => rec.turnWaiters.push(resolve)) : Promise.resolve();
  }

  /** Stop each running session in the list. Quiet about the ones that are not running. */
  async stopSessions(ids: readonly string[]): Promise<number> {
    let stopped = 0;
    for (const id of ids) {
      if (!isWorking(this.records.get(id))) continue;
      await this.stop(id).then(() => stopped++, () => undefined);
    }
    return stopped;
  }

  /**
   * Start the agent for a child session whose row already exists (handoff, delegate, spawn), with
   * the brief as its first message (runtime/bring-up.ts). Failure is returned, not thrown, so the
   * caller's tool can tell its agent plainly.
   */
  launchChild(child: Session, project: Project, source: ProjectFolder | null, prompt: string, origin: ChildOrigin, model: string, parentPermission: PermissionLevel | undefined, speed: Pick<SessionSettings, 'effort' | 'fast'> = {}, hosted?: { guest: Guest; host: Pick<Session, 'worktreePath' | 'branch'> }, roleRun: RoleRun | null = null): Promise<{ ok: true } | { ok: false; reason: string }> {
    return launchChild(this.host, child, project, source, prompt, origin, model, parentPermission, speed, hosted, roleRun);
  }
}
