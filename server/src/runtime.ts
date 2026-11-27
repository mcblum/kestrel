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
import { PlanUsageStore } from './plan-usage.ts';
import type { McpServerStore } from './mcp-servers/store.ts';
import { finishedProposal, pullRequestProposals } from './tickets/moments.ts';
import { sameTag } from './shared/tags.ts';
import { commentOnPR } from './pull-requests/create.ts';
import { hostTerms } from './shared/host-terms.ts';
import { reviewRequestKey } from './shared/review-requests.ts';
import type { RequestHome } from './review-requests/convert.ts';
import { githubCommands } from './pull-requests/github.ts';
import { gitlabCommands } from './pull-requests/gitlab.ts';
import { REVIEW_KIND, reviewKind } from './suggestions/review-kind.ts';
import type { RequestLink } from './model.ts';
import { REVIEW_ASKED, REVIEW_STARTS, type Guest } from './shared/worktree-guests.ts';
import { presetSummary, type RoleRun } from './shared/who-does-what.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentCapabilities, InputAnswer, InputRequest, Intercept, KestrelToolHost, ToolAction, ToolResult } from './agents/types.ts';
import { AttachmentStore } from './attachments/store.ts';
import { BaseRefresh } from './base-refresh.ts';
import { BrowserBridge } from './browser-bridge.ts';
import { BrowserTools } from './browser-tools.ts';
import { needsWindow, type WindowRefusals } from './shared/no-window.ts';
import { CommitSigning } from './commit-signing/prefs.ts';
import { CrashReports } from './crash-reports/prefs.ts';
import { Delegation, type ChildOrigin } from './delegation.ts';
import { FindingActions } from './finding-actions.ts';
import { ReviewEndActions } from './review-end.ts';
import { Asides } from './asides.ts';
import { reviewAnchors } from './review-requests/anchors.ts';
import { ASIDE_TOOL_REFUSAL, ASIDE_TOOLS } from './shared/asides.ts';
import { Display } from './display.ts';
import { Forks } from './fork.ts';
import { GitPrefs } from './git-settings/prefs.ts';
import { READ_ONLY_OMITTED, type McpSessions } from './kestrel-mcp.ts';
import { AGENT_LABEL, type Agent, type LivePatch, type Project, type ProjectFolder, type Session, type SessionDetail, type SessionSettings } from './model.ts';
import { OpenIn } from './open-in/prefs.ts';
import { ProjectEdits } from './project-edits/prefs.ts';
import { Knowledge } from './knowledge/service.ts';
import { homedir } from 'node:os';
import { hostPlatform } from './host.ts';
import { setupToolsFor } from './setup-actions/agent-tools.ts';
import { nodeRunner } from './setup-actions/io.ts';
import type { SetupSteps } from './setup-actions/steps.ts';
import { KNOWLEDGE_KIND, knowledgeKind } from './suggestions/knowledge-kind.ts';
import { RemoteStarts } from './remote-starts/prefs.ts';
import { StartBase } from './start-base/prefs.ts';
import { CommandsKept } from './commands-kept/prefs.ts';
import { AgentInfo, type AgentAvailability, type ContextShown, type ModelList } from './runtime/agent-info.ts';
import type { AgentSignIn } from './agents/sign-in.ts';
import { editVerdict, optionsFor, startOptions } from './runtime/agent-options.ts';
import { BackgroundWork } from './runtime/background.ts';
import { launchChild, loadRecord, startSession, type StartRequest } from './runtime/bring-up.ts';
import { githubByNumber, gitlabByNumber } from './pull-requests/by-number.ts';
import { commitIsHere, git, originUrl } from './git.ts';
import { startReview, type StartReviewOptions } from './review-requests/start.ts';
import type { ReviewingComments } from './review-requests/reviewing.ts';
import { ReviewReplies } from './review-requests/reply.ts';
import { ReviewPrefs } from './review-settings/prefs.ts';
import { ColourPrefs } from './colours/prefs.ts';
import { execRunner } from './pull-requests/github.ts';
import type { ReviewRequest } from './shared/review-requests.ts';
import { moveKind } from './suggestions/move-kind.ts';
import { ARCHIVE_KIND, archiveKind } from './suggestions/archive-kind.ts';
import { archiveSessionKind } from './suggestions/archive-session-kind.ts';
import { TICKET_KIND, ticketKind } from './suggestions/ticket-kind.ts';
import { TICKET_WORK_KIND, ticketWorkKind } from './suggestions/ticket-work-kind.ts';
import { REQUEST_KIND, requestKind } from './suggestions/request-kind.ts';
import { AttentionWatch } from './pull-requests/attention-watch.ts';
import { Autopilot } from './pull-requests/autopilot.ts';
import { mergeWhenGreen } from './pull-requests/merge-api.ts';
import type { AutopilotChoice } from './pull-requests/create-api.ts';
import { AUTOPILOT_KIND, autopilotKind } from './suggestions/autopilot-kind.ts';
import { isWanted } from './shared/autopilot.ts';
import type { PullRequestStore } from './pull-requests/store.ts';
import { requestAttention } from './shared/request-attention.ts';
import { cardSession, requestCardGone, requestCardHome } from './shared/request-cards.ts';
import { ticketMention } from './shared/ticket-mention.ts';
import { NO_SESSION_TICKETS, type SessionTickets } from './tickets/session.ts';
import { ticketLead, ticketOf, type Ticket } from './shared/tickets.ts';
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
import { scriptFailure, type ScriptOutcome } from './shared/project-scripts.ts';
import { clock, isWorking, lastAgentTextOf, noteFromText, type Live } from './runtime/record.ts';
import { inReplay, WaitingSteps } from './runtime/steps.ts';
import { SessionWorktrees } from './runtime/session-worktrees.ts';
import { assertPlainFolderFree, interruptAfterRestart } from './runtime/start-options.ts';
import { WorkStopper } from './runtime/stop-work.ts';
import { Titler } from './runtime/titling.ts';
import { answerCard, compactTurn, dropQueued, flushQueue, moveSettings, note, reply, sendQueued, stopTurn, type ReplyOptions } from './runtime/turns.ts';
import type { MessageFrom, NoteOutcome } from './shared/notes.ts';
import { Upkeep } from './runtime/upkeep.ts';
import type { RuntimeOptions } from './runtime/workdir.ts';
import { folderContext } from './sandbox-allow/context.ts';
import { SandboxAllowList } from './sandbox-allow/store.ts';
import { projectDirectory, scopeFolder, sessionDirectory, sessionFolderOf } from './scope-folder.ts';
import { parseScope } from './shared/scope.ts';
import { canRetry, retryMessage, type CommandOutput } from './shared/commands.ts';
import type { ContextUsage } from './shared/context-usage.ts';
import type { PermissionLevel } from './shared/permissions.ts';
import type { SessionQueue } from './shared/queue.ts';
import type { SlashCommand } from './shared/slash-commands.ts';
import type { BulkRemoval } from './shared/stale-worktrees.ts';
import { SimTools } from './sim-tools.ts';
import { Simulator } from './simulator.ts';
import { createSuggestions, type Suggestions } from './suggestions/index.ts';
import { SHOWN_TEXT } from './suggestions/service.ts';
import { titleFrom } from './title.ts';
import { appendOutput, applyToTranscript, outputLine, type TranscriptAction } from './transcript.ts';
import type { WorktreeList } from './worktree-cleanup.ts';
import { Refused, type Workspace } from './workspace.ts';
import type { KestrelKind } from './shared/host-kind.ts';
import { sessionGitEnvFor } from './runtime/session-git.ts';

export type { ContextShown, ModelList } from './runtime/agent-info.ts';
export type { ReplyOptions } from './runtime/turns.ts';
export type { StartRequest } from './runtime/bring-up.ts';
export { titleFrom, noteFromText };

export class SessionRuntime implements McpSessions {
  private readonly records = new Map<string, Live>();
  private readonly listeners = new Set<(sessionId: string, patch: LivePatch) => void>();
  readonly delegation: Delegation;
  /** Kestrel's own steps waiting on a card, stored so they survive a restart (runtime/steps.ts). */
  readonly steps: WaitingSteps;
  /** Fork a session: a copy of its conversation in a new session (fork.ts). */
  readonly forks: Forks;
  /** Sidebars about a finding (asides.ts). */
  readonly asides: Asides;
  readonly display: Display;
  readonly browser: BrowserTools;
  readonly sim: SimTools;
  /** What needs a window and is refused here, with the reason: nothing in the app, every one on a worker node (shared/no-window.ts). */
  readonly noWindow: WindowRefusals;
  /** Generated session titles, in the background (runtime/titling.ts). */
  readonly titler: Titler;
  readonly suggestions: Suggestions;
  private readonly stopReviewOffer: () => void;
  /** The PR store, once handed over (`watchRequestAttention`): what the failed-checks card reads. */
  private requestStore: PullRequestStore | null = null;
  private attentionWatch: AttentionWatch | null = null;
  /** Autopilot for sessions' pull requests (pull-requests/autopilot.ts); made with the PR store. */
  autopilot: Autopilot | null = null;
  /** Adds a comment to a pull request (pull-requests/create.ts `commentOnPR`); tests pass their own. */
  private readonly requestComment: NonNullable<RuntimeOptions['requestComment']>;
  /** Settings → Git: the branch name prefix new worktrees get (git-settings/prefs.ts). */
  readonly gitPrefs: GitPrefs;
  private readonly baseRefresh: BaseRefresh;
  /** Settings → Workflow: whether an edit to another project's file is refused (project-edits/prefs.ts). */
  readonly projectEdits: ProjectEdits;
  /** The knowledge base in use (knowledge/service.ts). */
  readonly knowledge: Knowledge;
  /** Whether other devices of the account may start sessions here (A8; Settings → Workflow). */
  readonly remoteStarts: RemoteStarts;
  readonly startBase: StartBase;
  /** Each project's setup and archive scripts (project-scripts/prefs.ts), and what runs them. */
  readonly projectScripts: ScriptsHost;
  /** Variables, .env files and files copied into new worktrees (project-env/prefs.ts). */
  readonly projectEnv: ProjectEnvPrefs;
  readonly mcpServers: McpServerStore | null;
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
  /** Settings → Colours: the review and workstream colours, and each tag's (colours/prefs.ts). */
  readonly colours: ColourPrefs;
  /** The "Reviewing" comments on a request (review-requests/reviewing.ts); null where no host is asked. */
  private readonly reviewing: ReviewingComments | null;
  /** The `post_review` tool, and posting a review card to its host (review-requests/reply.ts). */
  readonly reviewReplies: ReviewReplies;
  /** What the user does to one finding of a review card (finding-actions.ts). */
  readonly findingActions: FindingActions;
  readonly reviewEnds: ReviewEndActions;
  /** Stops one command or piece of background work on the user's word (runtime/stop-work.ts). */
  private readonly stopper: WorkStopper;
  /** Which agent each live session runs, for the words the Commands pane uses. */
  private readonly agents = new Map<string, Agent>();
  /** What the slices in runtime/ share (runtime/host.ts). */
  private readonly host: RuntimeHost;
  /** Which kind of server this is (the app or a worker node), as the entry that started it said. */
  private readonly kind: KestrelKind;
  /** Deleting sessions, discarding worktrees, Settings → Worktrees (runtime/session-worktrees.ts). */
  private readonly checkouts: SessionWorktrees;
  /** Models, capabilities, slash commands and context use, asked of the agents (runtime/agent-info.ts). */
  private readonly info: AgentInfo;
  /** Each agent account's plan usage as its sessions last reported it, pushed to every window (plan-usage.ts). */
  readonly planUsage = new PlanUsageStore();

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
    this.colours = new ColourPrefs(opts.colours);
    this.reviewing = opts.reviewing ?? null;
    this.reviewReplies = new ReviewReplies({
      session: async (id) => (await workspace.state()).sessions.find((s) => s.id === id),
      messages: (id) => this.records.get(id)?.messages ?? [],
      showCard: (id, card) => this.showCard(id, card),
      notice: (id, text, level) => this.notice(id, text, level),
      settings: () => this.reviewPrefs.current(),
      byNumber: (host) => (host === 'github' ? githubByNumber() : gitlabByNumber()),
      run: opts.reviewRunner ?? execRunner,
      now: () => this.now(),
      roundReview: (id, args) => this.delegation.handOverRound(id, args),
      diffAnchors: reviewAnchors,
      approved: (id, request) => void this.approvalPosted(id, request).catch((error: unknown) => console.error('[kestrel] could not offer to archive the review session', error)),
    });
    this.findingActions = new FindingActions({
      messages: (id) => this.records.get(id)?.messages ?? [],
      showCard: (id, card) => this.showCard(id, card),
      send: (id, text) => this.reply(id, text),
    });
    this.reviewEnds = new ReviewEndActions({
      messages: (id) => this.records.get(id)?.messages ?? [],
      showCard: (id, card) => this.showCard(id, card),
      send: (id, text) => this.reply(id, text),
      stateOf: async (id) => (await workspace.state()).sessions.find((s) => s.id === id) ?? null,
      settle: async (id) => workspace.setState(id, 'done', await this.delegation.doneNote(id, false)),
    });
    this.stopper = new WorkStopper(this.background, this.commands, opts.processes ?? systemProcesses);
    this.steps = new WaitingSteps(workspace, () => this.now());
    this.delegation = new Delegation(this, workspace, dataDir);
    this.display = new Display(
      {
        directoryOf: (id) => this.directoryOf(id),
        projectPaths: async () => (await workspace.state()).projects.flatMap((p) => p.folders.map((f) => f.path)),
        showCard: (id, card) => this.showCard(id, card),
        notice: (id, text, level) => this.notice(id, text, level),
        newsFrom: (id) => this.records.get(id)?.turnNewsFrom ?? [],
      },
      dataDir,
    );
    this.kind = opts.window?.kind ?? 'app';
    this.noWindow = needsWindow(this.kind, opts.window?.name ?? '');
    this.browser = new BrowserTools(new BrowserBridge(), { notice: (id, text, level) => this.notice(id, text, level) }, this.noWindow.browser);
    this.sim = new SimTools(
      simulator,
      {
        directoryOf: (id) => this.directoryOf(id),
        notice: (id, text, level) => this.notice(id, text, level),
        show: (id, udid) => this.simShows.forEach((l) => l(id, udid)),
      },
      undefined,
      this.noWindow.simulator,
    );
    this.requestComment = opts.requestComment ?? ((cwd, number, body, host) => commentOnPR(cwd, number, body, { commands: host === 'gitlab' ? gitlabCommands : githubCommands }));
    this.suggestions = createSuggestions(this, workspace, {
      ...opts.suggestions,
      // A delegate child's cards about its pull request are shown on the top of its tree, and go once the request is merged or closed (shared/request-cards.ts).
      homeOf: async (id) => {
        const state = await workspace.state();
        return requestCardHome(id, state.links, state.workstreams, (home) => state.sessions.some((s) => s.id === home));
      },
      gone: (suggestion) => requestCardGone(suggestion, this.requestStore?.peek(cardSession(suggestion))),
      kinds: [
        reviewKind({
          who: () => this.whoDoesWhat.current(),
          reviewerFor: async (id) => (await this.delegation.reviewerFor(id)).reviewer,
          reviewed: (id, ever) => this.reviewsWaiting.has(id) || (ever ? this.delegation.reviewOf(id) !== null : (this.delegation.reviewOf(id)?.status ?? 'done') !== 'done'),
          start: (id) => this.startReviewWhenIdle(id),
          stopOffering: async () => void (await this.whoDoesWhat.set({ ...(await this.whoDoesWhat.current()), reviewOffer: false })),
          startAlone: async () => void (await this.whoDoesWhat.set({ ...(await this.whoDoesWhat.current()), reviewAuto: true })),
        }),
        moveKind({
          where: (projectId, folderId) => this.delegation.whereIs(projectId, folderId),
          refusal: async (id) => {
            const session = (await workspace.state()).sessions.find((s) => s.id === id);
            return session ? this.moveRefusal(session) : 'No such session.';
          },
          move: (id, projectId, folderId) => this.delegation.moveNow(id, projectId, folderId),
        }),
        ticketKind({
          ticketOf: (id) => this.tickets.ticketOf(id),
          moveTo: (key, category) => this.tickets.moveTo(key, category),
          moveBack: (key, to) => this.tickets.moveBack(key, to),
          comment: (key, body) => this.tickets.comment(key, body),
        }),
        knowledgeKind({
          check: async (id, draft) => {
            const checked = await this.knowledge.check(await this.projectOfSession(id), draft);
            return { ...checked, base: (await this.knowledge.base())?.read.manifest.name ?? 'the knowledge base' };
          },
          open: (id, isUpdate, text, reason) => this.knowledge.open(id, isUpdate, text, reason),
          never: async () => void (await this.knowledge.setSettings({ proposals: 'never' })),
        }),
        archiveKind({
          answer: async () => (await this.reviewPrefs.current()).afterApproval,
          setAnswer: async (afterApproval) => void (await this.reviewPrefs.set({ afterApproval })),
          archive: async (id) => {
            const failure = await this.archiveSession(id);
            if (failure) throw new Refused(failure.reason);
          },
          restore: (id) => workspace.setArchived('session', id, false),
        }),
        archiveSessionKind({
          archive: async (id) => {
            const failure = await this.archiveSession(id);
            if (failure) throw new Refused(failure.reason);
          },
          restore: (id) => workspace.setArchived('session', id, false),
        }),
        requestKind({
          send: (id, text) => this.reply(id, text),
          current: async (id) => {
            const lookup = this.requestStore?.peek(id);
            return lookup?.state === 'ready' ? requestAttention(lookup, await this.gitPrefs.attention()) : undefined;
          },
          prefs: () => this.gitPrefs.attention(),
          stopOffering: (reason) => this.gitPrefs.setAttention({ reason, card: 'never' }),
        }),
        autopilotKind({
          prefs: () => this.gitPrefs.autopilot(),
          turnOn: (id, merge, number) => this.autopilotOrThrow().turnOn(id, merge, number),
          stopOffering: () => this.gitPrefs.setAutopilot({ offer: false }),
          asks: async (id) => {
            const session = (await this.workspace.state()).sessions.find((s) => s.id === id);
            return session ? (await this.recordFor(session))?.settings.permission === 'ask' : false;
          },
        }),
        ticketWorkKind({
          attach: (id, key, from) => this.ticketTaken(id, key, from),
          detach: (id, key) => this.tickets.detach(id, key),
          titleOf: async (id) => (await workspace.state()).sessions.find((s) => s.id === id)?.title ?? null,
        }),
      ],
    });
    this.stopReviewOffer = workspace.onRequestLinked((id, link) => {
      const fromForm = this.formRequests.has(id);
      const formChoice = this.formRequests.get(id) ?? null;
      this.formRequests.delete(id);
      this.offerReview(id, link, fromForm);
      void this.offerAutopilot(id, link, fromForm, formChoice).catch((error: unknown) => console.error('[kestrel] could not offer Autopilot', error));
      void this.proposeTicketPullRequest(id, link).catch((error: unknown) => console.error('[kestrel] could not propose the ticket’s review', error));
    });
    this.gitPrefs = new GitPrefs(opts.git);
    this.baseRefresh = new BaseRefresh({ enabled: () => this.gitPrefs.startFromLatest(), fetch: opts.baseFetch });
    this.projectEdits = new ProjectEdits(opts.projectEdits);
    this.knowledge = new Knowledge(async () => (await workspace.state()).projects, { ...opts.knowledge, proposing: opts.knowledge?.proposing ?? { workDir: join(dataDir, 'knowledge') } });
    this.remoteStarts = new RemoteStarts(opts.remoteStarts);
    this.startBase = new StartBase(opts.startBase);
    this.projectEnv = new ProjectEnvPrefs(opts.projectEnv);
    this.mcpServers = opts.mcpServers ?? null;
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
    this.upkeep = new Upkeep(workspace, (id, patch) => this.emitLive(id, patch), (rec, work) => this.queue(rec, work), (id) => this.commands.stored(id), (id) => this.records.get(id));
    this.forks = this.makeForks();
    this.asides = new Asides({
      workspace: this.workspace,
      adapterFor: (agent) => this.adapters[agent],
      isWorking: (id) => isWorking(this.records.get(id)),
      conversation: async (id) => this.overlay(id) ?? this.workspace.storedDetail(id),
    });
    this.host = this.makeHost();
    this.checkouts = new SessionWorktrees(this.host);
    this.info = new AgentInfo(this.host, opts.window?.kind ?? 'app', opts.window?.name ?? '');
  }

  /** What the runtime's slices share (runtime/host.ts), built once. */
  private makeHost(): RuntimeHost {
    return {
      workspace: this.workspace,
      adapters: this.adapters,
      dataDir: this.dataDir,
      sessionGitEnv: (directory) => sessionGitEnvFor(this.kind, this.dataDir, directory),
      records: this.records,
      agents: this.agents,
      upkeep: this.upkeep,
      background: this.background,
      commands: this.commands,
      attachments: this.attachments,
      delegation: this.delegation,
      steps: this.steps,
      display: this.display,
      browser: this.browser,
      titler: this.titler,
      gitPrefs: this.gitPrefs,
      baseRefresh: this.baseRefresh,
      projectEdits: this.projectEdits,
      knowledge: this.knowledge,
      startBase: this.startBase,
      projectScripts: this.projectScripts,
      projectEnv: this.projectEnv,
      mcpServers: this.mcpServers,
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
      agentTurns: { failed: (agent, event) => this.info.turnFailed(agent, event), succeeded: (agent) => this.info.turnSucceeded(agent) },
      planUsage: this.planUsage,
      turnComplete: (id) => {
        void this.proposeTicketFinished(id).catch((error: unknown) => console.error('[kestrel] could not propose the ticket’s summary', error));
        void this.startWaitingReview(id);
        void this.offerWaitingArchive(id);
      },
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
  agentAvailability(): Promise<AgentAvailability> {
    return this.info.availability();
  }

  /** A worker node's `kestrel node agents` changed these agents: forget what was known of them and ask again (runtime/agent-info.ts). */
  recheckAgents(agents: readonly Agent[]): Promise<AgentAvailability> {
    return this.info.recheck(agents);
  }

  /** How a worker node names itself when it words its agents: Kestrel Connect's computer name, once that is up. */
  nameAgentsBy(read: () => string): void {
    this.info.nameBy(read);
  }

  /** Told when an agent's availability or model list differs from what it answered before (runtime/agent-info.ts). */
  onAgentsChange(listener: () => void): () => void {
    return this.info.onAgentsChange(listener);
  }

  /** The agent's own sign-in, run from Kestrel (agents/sign-in.ts). Refused for an agent Kestrel cannot sign in. */
  agentSignIn(agent: Agent): AgentSignIn {
    return this.info.signIn(agent);
  }

  /** The sessions' tickets (tickets/session.ts), set once the ticket store and sync exist; none until then. */
  private tickets: SessionTickets = NO_SESSION_TICKETS;
  useTickets(tickets: SessionTickets): void {
    this.tickets = tickets;
  }

  /** Work on the session's ticket has started: Kestrel proposes moving it to In progress, unless it is already there or further, or the user said not to ask. Never waits. */
  proposeTicketStarted(sessionId: string): Promise<ToolResult> {
    return this.suggestions.suggest(sessionId, { kind: TICKET_KIND, change: 'in-progress', reason: 'Work on it has started here.' });
  }

  /** A pull request opened from work on a ticket: in the ticket's lead (else here), a comment with its link and In review are proposed, once for that request. */
  private async proposeTicketPullRequest(sessionId: string, link: RequestLink): Promise<void> {
    const proposals = pullRequestProposals(link);
    if (proposals.length === 0) return;
    const at = await this.tickets.situation(sessionId);
    const attached = at && ticketOf(sessionId, at.links, at.workstreams);
    if (!at || !attached) return;
    const target = ticketLead(attached.ticketKey, at.links, at.workstreams, at.liveSessions) ?? sessionId;
    for (const proposal of proposals) await this.suggestions.suggest(target, { kind: TICKET_KIND, ...proposal });
  }

  /** A turn of a ticket's lead ended: when nothing under it is still working and it stopped at pull requests, a comment with its report is proposed, once for the ticket. */
  private async proposeTicketFinished(sessionId: string): Promise<void> {
    const at = await this.tickets.situation(sessionId);
    const attached = at && ticketOf(sessionId, at.links, at.workstreams);
    if (!at || !attached || ticketLead(attached.ticketKey, at.links, at.workstreams, at.liveSessions) !== sessionId) return;
    const ids = new Set([sessionId, ...(at.workstreams.find((w) => w.sessionIds.includes(sessionId))?.sessionIds ?? [])]);
    const state = await this.workspace.state();
    const requests = (await this.workspace.allRequestLinks()).filter((r) => ids.has(r.sessionId)).length;
    const proposal = finishedProposal({ sessions: state.sessions.filter((s) => ids.has(s.id)), requests, report: this.lastAgentText(sessionId) });
    if (proposal) await this.suggestions.suggest(sessionId, { kind: TICKET_KIND, ...proposal });
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
    const { messages, files, agentOutput, kestrelTools, kestrelMissing, mcpServers, settings, queue } = this.overlay(sessionId)!;
    const rec = this.records.get(sessionId)!;
    // A session with no command list yet (it last ran before Kestrel kept one, or the list was empty)
    // is asked for one now, without a turn, so "/" works as soon as it is opened.
    this.info.askSlashCommands(session, rec);
    // Opening a session looks at its worktree again: files changed outside a turn (in the terminal,
    // or before a base was recovered for a branch made inside the worktree) show without waiting for one.
    this.upkeep.scheduleRefresh(sessionId, rec);
    return { messages, files, filesProblem: rec.filesProblem, agentOutput, kestrelTools, kestrelMissing, mcpServers, settings, queue, subagents: rec.subagents, subagentsAfter: rec.subagentsAfter, backgroundTasks, commands: this.commands.list(sessionId), slashCommands: rec.slashCommands };
  }

  /** What is stored for a session with no agent behind it, with its (sample) background work. */
  private async storedSnapshot(sessionId: string, backgroundTasks: LivePatch['backgroundTasks']): Promise<LivePatch> {
    const stored = await this.workspace.storedDetail(sessionId);
    if (!stored) return { backgroundTasks };
    const { files, agentOutput, kestrelTools } = stored;
    // Sample messages have no ids; a window that watches twice must replace them, not add them again.
    const messages = stored.messages.map((m, i) => (m.id === undefined ? { ...m, id: `stored-${i}` } : m));
    return { messages, files, agentOutput, kestrelTools, kestrelMissing: stored.kestrelMissing ?? [], ...(stored.mcpServers ? { mcpServers: stored.mcpServers } : {}), backgroundTasks };
  }

  /** The in-memory state of a live session, if it has one; newer than what is stored. */
  overlay(sessionId: string): Pick<SessionDetail, 'messages' | 'files' | 'agentOutput' | 'kestrelTools' | 'kestrelMissing' | 'mcpServers' | 'agentSessionId' | 'settings' | 'queue' | 'usage'> | null {
    const rec = this.records.get(sessionId);
    return rec ? { messages: rec.messages, files: rec.files, agentOutput: rec.agentOutput, kestrelTools: rec.kestrelTools, kestrelMissing: rec.kestrelMissing, mcpServers: rec.mcpServers, agentSessionId: rec.agentSessionId, settings: rec.settings, queue: rec.queue, ...(rec.usage ? { usage: rec.usage } : {}) } : null;
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

  /** The same with the words shown in its place when it is not known: what the window's ring and a phone show. */
  contextShown(sessionId: string): Promise<ContextShown> {
    return this.info.contextShown(sessionId);
  }

  /** What is known now of a session's context window, asking no agent (the held index). */
  contextKnown(session: Session): ContextShown {
    return this.info.contextKnown(session, this.records.get(session.id) ?? null);
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
  async start(req: StartRequest): Promise<Session> {
    if (!req.byUser) return startSession(this.host, req);
    const mention = await this.ticketMentioned(null, req.prompt);
    const session = await startSession(this.host, { ...req, ...(mention?.context ? { context: mention.context } : {}) });
    if (mention) await this.suggestions.suggest(session.id, { kind: TICKET_WORK_KIND, ...mention.payload });
    return session;
  }

  /**
   * Start reviewing a request somebody asked the user to review, or give back the review already
   * started (review-requests/start.ts): a session in the request's project, at the request's commit.
   */
  async startReview(request: ReviewRequest, opts: StartReviewOptions = {}): Promise<Session> {
    const session = await startReview(
      {
        projects: async () => (await this.workspace.state()).projects,
        // Archived ones too: a request has one review session, and one archived after an approval is brought back rather than a second made.
        sessions: async () => {
          const state = await this.workspace.state();
          return [...state.sessions, ...state.archived.sessions];
        },
        originOf: originUrl,
        git,
        byNumber: (host) => (host === 'github' ? githubByNumber() : gitlabByNumber()),
        who: () => this.whoDoesWhat.current(),
        connectedAgents: () => this.availableAgents(),
        start: ({ effort, fast, ...req }) => this.start({ ...req, ...(effort ? { effort } : {}), ...(fast ? { fast: true } : {}) }),
        ...(this.reviewing ? { reviewing: this.reviewing } : {}),
        announces: async () => (await this.reviewPrefs.current()).announce,
        permission: async () => (await this.reviewPrefs.current()).permission,
        instructions: async () => (await this.reviewPrefs.current()).instructions,
        notice: (id, text) => this.notice(id, text, 'warning'),
        now: () => this.now(),
      },
      request,
      opts,
    );
    if ((await this.workspace.state()).archived.sessions.some((s) => s.id === session.id)) await this.workspace.setArchived('session', session.id, false);
    return session;
  }

  /**
   * A message for the agent: into the running turn ('delivered'), held for the next one ('queued'),
   * or a new turn ('sent'). A notice is refused while the agent works (runtime/turns.ts).
   */
  async reply(sessionId: string, text: string, change: Partial<SessionSettings> = {}, opts: ReplyOptions = {}): Promise<'sent' | 'delivered' | 'queued'> {
    if (opts.notice || opts.fromAgent) return reply(this.host, sessionId, text, change, opts);
    // The user's own message makes the session theirs again (docs/designs/pr-autopilot.md).
    if (!opts.autopilot) await this.autopilot?.userSpoke(sessionId);
    const mention = await this.ticketMentioned(sessionId, text).catch(() => null);
    // The ticket goes to the agent with the turn this message starts (or the next one, when it joins a running turn).
    const session = mention?.context ? (await this.workspace.state()).sessions.find((s) => s.id === sessionId) : undefined;
    const rec = session && mention?.context ? await this.queueNews(session, mention.context) : null;
    let outcome: Awaited<ReturnType<typeof reply>>;
    try {
      outcome = await reply(this.host, sessionId, text, change, opts);
    } catch (error) {
      // The message was not sent: neither is what it would have brought along, nor is the ticket taken up.
      if (rec) rec.inbox = rec.inbox.filter((t) => t !== mention?.context);
      throw error;
    }
    if (mention) await this.suggestions.suggest(sessionId, { kind: TICKET_WORK_KIND, ...mention.payload });
    return outcome;
  }

  /** A note from another session (shared/notes.ts): into the running turn, or held; never a turn of its own. */
  note(sessionId: string, text: string, from: MessageFrom): Promise<NoteOutcome> {
    return note(this.host, sessionId, text, from);
  }

  /**
   * A ticket the user's message names (shared/ticket-mention.ts): what to raise in the conversation,
   * and what the agent is told with the turn. Null when the message names none, or the session keeps its own.
   */
  private async ticketMentioned(sessionId: string | null, text: string): Promise<{ payload: Record<string, unknown>; context: string | null } | null> {
    const at = await this.tickets.situation(sessionId);
    if (!at) return null;
    const verdict = ticketMention(text, at);
    if (verdict.type === 'attach') {
      const brief = await this.tickets.brief(verdict.ticket.key);
      return { payload: { mode: 'attach', key: verdict.ticket.key, ref: verdict.ticket.ref }, context: `The user's message names ticket ${verdict.ticket.ref}; Kestrel has made it this session's ticket. Here it is as the tracker has it.\n\n${brief}` };
    }
    if (verdict.type === 'elsewhere') {
      return { payload: { mode: 'elsewhere', key: verdict.ticket.key, ref: verdict.ticket.ref, session: verdict.sessionId }, context: `The user's message names ticket ${verdict.ticket.ref}, which another session is already working on; it was not attached here.` };
    }
    if (verdict.type === 'several') return { payload: { mode: 'pick', tickets: verdict.tickets.map((t) => ({ key: t.key, ref: t.ref })) }, context: null };
    return null;
  }

  /** A ticket taken up from a message or a pick: attached and tagged; Kestrel proposes In progress, and a pick gives the agent the ticket with its next turn. */
  private async ticketTaken(sessionId: string, key: string, from: 'message' | 'pick'): Promise<Ticket> {
    const ticket = await this.tickets.attach(sessionId, key);
    // Not awaited: both go through this session's suggestions, which are handling the press that called this.
    void (async () => {
      if (from === 'pick') {
        const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
        if (session) await this.queueNews(session, `The user picked ticket ${ticket.ref} as this session's ticket. Here it is as the tracker has it.\n\n${await this.tickets.brief(key)}`);
      }
      // Attaching tagged the session with the key, so a card still asking to add that tag has its answer.
      await this.suggestions.settle(sessionId, 'tag', (p) => { const tag = (p as { tag?: unknown } | null)?.tag; return typeof tag === 'string' && sameTag(tag, ticket.ref); }, `Tagged ${ticket.ref}`);
      await this.proposeTicketStarted(sessionId);
    })().catch((error: unknown) => console.error('[kestrel] could not follow up the ticket', error));
    return ticket;
  }

  /** What the mid-turn messages need from here (runtime/mid-turn.ts). */
  private readonly midTurnHost: MidTurnHost = {
    apply: (id, rec, action) => this.apply(id, rec, action),
    emitLive: (id, patch) => this.emitLive(id, patch),
    setQueue: (id, rec, queue) => this.setQueue(id, rec, queue),
    forAgent: (id, attachments) => this.attachments.forAgent(id, attachments),
  };

  /** Compact the conversation by the agent's own means, as a turn (runtime/turns.ts `compactTurn`). */
  compact(sessionId: string): Promise<void> {
    return compactTurn(this.host, sessionId);
  }

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
  async queueNews(session: Session, text: string, fromId?: string): Promise<Live | null> {
    const rec = await this.recordFor(session);
    if (!rec) return null;
    rec.inbox = [...rec.inbox, text];
    if (fromId) rec.newsFrom.push(fromId);
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
  async stop(sessionId: string): Promise<void> {
    await this.autopilot?.userSpoke(sessionId);
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

  /**
   * The request a session asked to review, as a review request: who it is by and what it is called
   * are asked of the host (review-requests/convert.ts). Throws `Refused` when the host has no such request.
   */
  async requestToReview(home: RequestHome, number: number, url: string | undefined): Promise<ReviewRequest> {
    const terms = hostTerms(home.host);
    const found = await (home.host === 'github' ? githubByNumber() : gitlabByNumber()).pullRequestByNumber(home.folder.path, number);
    if (found.state === 'unavailable') throw new Refused(`Could not look up ${terms.long} ${terms.sigil}${number}: ${found.reason}`);
    const request = found.state === 'ready' ? found.value : null;
    if (!request) throw new Refused(`${terms.service} has no ${terms.long} ${terms.sigil}${number} in ${home.repository}.`);
    const base = { host: home.host, hostName: home.hostName, repository: home.repository, number, title: request.title, author: request.author ?? '', url: request.url || url || '', updatedAt: this.now() };
    return { ...base, key: reviewRequestKey(base), projectId: home.project.id };
  }

  /** A session gives way to another: every window showing it is told to show that one, then it is deleted. */
  async replaceWith(sessionId: string, replacementId: string): Promise<void> {
    this.emitLive(sessionId, { replacedBy: replacementId });
    await this.deleteSession(sessionId);
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
   * Archive a session as the user's archive does: its project's archive script first (unless
   * `skipScript`), then the workspace's archive, whose refusal (still working or waiting) is thrown
   * as it is. A failed script stops it: what failed, and the script's output, are returned.
   */
  async archiveSession(sessionId: string, skipScript = false): Promise<{ reason: string; output: string } | null> {
    if (!skipScript) {
      const outcome = await this.runArchiveScript(sessionId);
      const failure = outcome && scriptFailure('archive', outcome);
      if (outcome && failure) return { reason: `${failure} The session was not archived.`, output: outcome.tail };
    }
    await this.workspace.setArchived('session', sessionId, true);
    return null;
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

  /**
   * Raise and withdraw the cards about a pull request that needs the user from the PR store's answers
   * and Settings → Git (pull-requests/attention-watch.ts).
   * Called once, by the server, with the one store.
   */
  watchRequestAttention(store: PullRequestStore, sample = false): AttentionWatch {
    this.requestStore = store;
    this.attentionWatch?.stop();
    this.attentionWatch = new AttentionWatch({
      sessions: async () => (await this.workspace.state()).sessions,
      lookup: (id) => store.peek(id),
      prefs: () => this.gitPrefs.attention(),
      onChange: (listener) => {
        const offs = [this.workspace.onChange(listener), store.onChange(() => listener()), this.gitPrefs.onAttentionChange(() => listener())];
        return () => offs.forEach((off) => off());
      },
      raise: (id, card) => this.suggestions.suggest(id, { kind: REQUEST_KIND, ...card }),
      withdraw: (id, line) => this.suggestions.settle(id, REQUEST_KIND, (payload) => line(payload) !== null, (payload) => line(payload) ?? ''),
      withdrawGone: (id) => this.suggestions.withdrawGone(id),
      autopilotOn: (id) => this.autopilot?.isOn(id) ?? false,
    });
    this.autopilot?.stop();
    this.autopilot = new Autopilot({
      sessions: async () => (await this.workspace.state()).sessions,
      lookup: (id) => store.peek(id),
      current: (id) => store.current(id),
      attention: () => this.gitPrefs.attention(),
      prefs: () => this.gitPrefs.autopilot(),
      save: (id, record) => this.workspace.setAutopilot(id, record),
      send: (id, text) => this.reply(id, text, {}, { autopilot: true }),
      // Sample requests are made up: a merge of one could reach a real repository's request of the same number.
      merge: (id, pr) => (sample ? Promise.reject(new Error('merging is unavailable for sample pull requests')) : mergeWhenGreen(this.workspace, store, id, pr.number)),
      notice: (id, text, level) => this.notice(id, text, level),
      madeHere: (session, sha) => commitIsHere(session.worktreePath, sha),
      onChange: (listener) => {
        const offs = [this.workspace.onChange(listener), store.onChange(() => listener())];
        return () => offs.forEach((off) => off());
      },
    });
    return this.attentionWatch;
  }

  async shutdown(): Promise<void> {
    this.attentionWatch?.stop();
    this.autopilot?.stop();
    this.stopKeepAwake();
    this.stopReviewOffer();
    this.stopMergeCleanup();
    this.keepAwake.stop();
    this.knowledge.stop();
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

  /** The folder a session works in: the worktree it works in (its host's for a guest), its plain directory, or the shared scratch folder. */
  async directoryOf(sessionId: string): Promise<string | null> {
    return sessionDirectory(await this.workspace.state(), sessionId, join(this.dataDir, 'scratch'));
  }

  /** Why a scope's folder is not where its work is (a discarded or missing worktree), or null (scope-folder.ts `sessionFolderOf`). */
  async folderNote(scopeKey: string): Promise<string | null> {
    const scope = parseScope(scopeKey);
    if (scope?.kind !== 'session') return null;
    return sessionFolderOf(await this.workspace.state(), scope.id, join(this.dataDir, 'scratch'))?.note ?? null;
  }

  /**
   * Whether a file edit may go ahead (runtime/agent-options.ts): refused, with what to do instead,
   * when the file is inside another session's worktree or another registered project.
   */
  editVerdict(sessionId: string, ownProjectId: string | null, directory: string, action: ToolAction): Promise<Intercept> {
    return editVerdict(this.host, sessionId, ownProjectId, directory, action);
  }

  /** `ticket_read` and `ticket_update`: the session's ticket, read now; a change to it only ever proposed, as a `ticket` suggestion. */
  private ticketTools(sessionId: string): Pick<KestrelToolHost, 'ticketRead' | 'ticketUpdate'> {
    return {
      ticketRead: async (args) => {
        try {
          return { text: await this.tickets.read(sessionId, args?.key) };
        } catch (error) {
          return { isError: true, text: error instanceof Error ? error.message : String(error) };
        }
      },
      ticketUpdate: (args) => this.suggestions.suggest(sessionId, { ...args, kind: TICKET_KIND }),
    };
  }

  /** The project a session works in, or null when it has none. */
  private async projectOfSession(sessionId: string): Promise<Project | null> {
    const state = await this.workspace.state();
    const session = state.sessions.find((s) => s.id === sessionId);
    return state.projects.find((p) => p.id === session?.startedIn) ?? null;
  }

  /** `knowledge_search`, `knowledge_read` and `knowledge_propose`: the knowledge base read as merged; an addition only ever proposed, as a `knowledge` suggestion. */
  private knowledgeTools(sessionId: string): Pick<KestrelToolHost, 'knowledgeSearch' | 'knowledgeRead' | 'knowledgePropose'> {
    const answer = async (work: (project: Project | null) => Promise<string>): Promise<ToolResult> => {
      try {
        return { text: await work(await this.projectOfSession(sessionId)) };
      } catch (error) {
        return { isError: true, text: error instanceof Error ? error.message : String(error) };
      }
    };
    return {
      knowledgeSearch: (args) => answer((project) => this.knowledge.search(project, args.query)),
      knowledgeRead: (args) => answer((project) => this.knowledge.read(project, args.id)),
      knowledgePropose: (args) => this.suggestions.suggest(sessionId, { ...args, kind: KNOWLEDGE_KIND }),
    };
  }

  /** This computer's Set up this computer checklist, handed over once Kestrel Connect has made it (index.ts). */
  private setupSteps: SetupSteps | null = null;

  useSetupSteps(steps: SetupSteps | null): void {
    this.setupSteps = steps;
  }

  /** `setup_list`, `setup_run_step`, `setup_run_command` (setup-actions/agent-tools.ts). */
  private setupTools(sessionId: string): Pick<KestrelToolHost, 'setupList' | 'setupRunStep' | 'setupRunCommand'> {
    const platform = hostPlatform();
    return setupToolsFor(sessionId, {
      steps: () => this.setupSteps,
      session: async (id) => (await this.workspace.state()).sessions.find((s) => s.id === id) ?? null,
      mode: (id) => this.recordOf(id)?.settings.permission,
      approve: (id, request) => this.requestApproval(id, request),
      platform,
      home: homedir(),
      run: nodeRunner(platform),
    });
  }

  /** The Kestrel tools one session gets (delegation, display, suggestions, tickets, knowledge, browser, simulator). */
  private toolHost(sessionId: string): KestrelToolHost {
    const host: KestrelToolHost = { ...this.delegation.hostFor(sessionId), ...this.display.hostFor(sessionId), ...this.reviewReplies.hostFor(sessionId), ...this.suggestions.hostFor(sessionId), ...this.ticketTools(sessionId), ...this.knowledgeTools(sessionId), ...this.setupTools(sessionId), ...this.browser.hostFor(sessionId), ...this.sim.hostFor(sessionId) };
    return this.asideGuard(sessionId, host);
  }

  /**
   * A sidebar only talks (shared/asides.ts): every Kestrel tool that starts, changes or sends
   * something is refused there with the reason, for every agent alike, since all reach this one host.
   */
  private asideGuard(sessionId: string, host: KestrelToolHost): KestrelToolHost {
    const guarded = Object.fromEntries(
      Object.entries(host).map(([name, call]) => {
        if (ASIDE_TOOLS.includes(name) || typeof call !== 'function') return [name, call];
        const fn = call as (...args: unknown[]) => Promise<unknown>;
        return [name, async (...args: unknown[]) => ((await this.asides.asideOf(sessionId)) ? { text: ASIDE_TOOL_REFUSAL, isError: true } : fn(...args))];
      }),
    );
    return guarded as unknown as KestrelToolHost;
  }

  private queue(rec: Live, work: () => Promise<unknown>): void {
    rec.chain = rec.chain.then(work).catch((error) => console.error('[kestrel] session side effect failed', error));
  }

  /** Run an action through the transcript and send what changed on the live channel. */
  private apply(id: string, rec: Live, action: TranscriptAction): void {
    const { messages, changed, removed } = applyToTranscript(rec.messages, action, clock(), this.now(), new Set([...rec.kestrelRequests.keys(), ...rec.keptSteps]));
    rec.messages = messages;
    const patch: LivePatch = {};
    if (changed.length) patch.messages = changed;
    // Taken out first, then merged: a message in both lists lands at the end (a review card kept last in its turn).
    if (removed?.length) patch.removedMessages = removed;
    if (action.type !== 'user' && action.type !== 'resolved' && action.type !== 'settled' && action.type !== 'notice' && action.type !== 'note' && action.type !== 'card' && action.type !== 'withdrawn') {
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

  /** Sessions whose pull request the Create form just made: the user was asked about a review and Autopilot there, and what they said of Autopilot. */
  private readonly formRequests = new Map<string, AutopilotChoice | null>();

  /** The Create pull request form made a request for this session (pull-requests/create-api.ts). */
  noteFormRequest(sessionId: string, autopilot: AutopilotChoice | null = null): void {
    this.formRequests.set(sessionId, autopilot);
  }

  /** A request was linked to a session: when its agent opened it, the user is offered a review (suggestions/review-kind.ts). */
  private offerReview(sessionId: string, link: RequestLink, fromForm: boolean): void {
    if (fromForm) return;
    if (link.state !== 'open' && link.state !== 'draft') return;
    void this.suggestions.suggest(sessionId, { kind: REVIEW_KIND, host: link.host, number: link.number });
  }

  /**
   * A request was linked to a session: Autopilot is offered on a card (suggestions/autopilot-kind.ts),
   * or turned on at once where the user chose Always in Settings → Git → Autopilot. Not when the Create
   * pull request form already asked, nor for a guest (its host owns the request).
   */
  private async offerAutopilot(sessionId: string, link: RequestLink, fromForm: boolean, formChoice: AutopilotChoice | null): Promise<void> {
    if (link.state !== 'open' && link.state !== 'draft') return;
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    if (!session || session.hostId || session.review) return;
    // The form's answer stands: it was shown the session's own choice to begin with.
    if (formChoice) {
      if (formChoice.on) await this.autopilotOrThrow().turnOn(sessionId, formChoice.merge, link.number);
      else await this.autopilot?.turnOff(sessionId);
      return;
    }
    // Turned on beforehand (Session Details, the pill): it starts here, and nothing is asked.
    if (isWanted(session.autopilot)) {
      if (session.autopilot.waiting) await this.autopilotOrThrow().turnOn(sessionId, session.autopilot.merge, link.number);
      return;
    }
    const prefs = await this.gitPrefs.autopilot();
    if (prefs.always) {
      await this.autopilotOrThrow().turnOn(sessionId, prefs.merge, link.number);
      return;
    }
    if (prefs.offer && !fromForm) await this.suggestions.suggest(sessionId, { kind: AUTOPILOT_KIND, host: link.host, number: link.number });
  }

  private autopilotOrThrow(): Autopilot {
    if (!this.autopilot) throw new Refused('Autopilot is not running yet: Kestrel has not started watching pull requests.');
    return this.autopilot;
  }

  /** Review sessions whose approval was posted while they were on a turn or waiting on the user, by the request's name: the archive offer comes when the turn ends. */
  private readonly archivesWaiting = new Map<string, string>();
  /** Whether the user dismissed a review request, by its key (the review request store's); none until index.ts hands it over. */
  private reviewDismissed: (key: string) => boolean = () => false;

  useReviewDismissed(isDismissed: (key: string) => boolean): void {
    this.reviewDismissed = isDismissed;
  }

  /**
   * The user's approval of somebody else's pull request was posted from this review session: its work
   * is done, so archiving it is offered (suggestions/archive-kind.ts), or done at once where the user
   * chose that. Not for a request the user dismissed. A session still on a turn or waiting on the user
   * cannot be archived, so the offer waits for the turn to end.
   */
  async approvalPosted(sessionId: string, request: string): Promise<void> {
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    if (!session?.review || this.reviewDismissed(session.review.key)) return;
    if (session.state === 'running' || session.state === 'attention') {
      this.archivesWaiting.set(sessionId, request);
      return;
    }
    await this.suggestions.suggest(sessionId, { kind: ARCHIVE_KIND, request });
  }

  /** A turn ended: the archive offer that waited for it is made, unless the session still waits on the user. */
  private async offerWaitingArchive(sessionId: string): Promise<void> {
    const request = this.archivesWaiting.get(sessionId);
    if (request === undefined) return;
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    if (session?.state === 'running' || session?.state === 'attention') return;
    this.archivesWaiting.delete(sessionId);
    if (session) await this.approvalPosted(sessionId, request).catch((error: unknown) => console.error('[kestrel] could not offer to archive the review session', error));
  }

  /** Sessions whose review was agreed while they were still on a turn: it starts when that turn ends. */
  private readonly reviewsWaiting = new Set<string>();

  /**
   * Start the review of a session's work now, or, while it is still on a turn (a review reads
   * finished work), when that turn ends. Throws the reason when nobody can review it.
   */
  private async startReviewWhenIdle(sessionId: string): Promise<{ reviewer: string; waiting: boolean }> {
    const session = (await this.workspace.state()).sessions.find((s) => s.id === sessionId);
    if (session?.state !== 'running' && session?.state !== 'attention') return { reviewer: (await this.delegation.startReview(sessionId, { comment: true })).reviewer, waiting: false };
    const { reviewer, reason } = await this.delegation.reviewerFor(sessionId);
    if (!reviewer) throw new Refused(reason);
    this.reviewsWaiting.add(sessionId);
    return { reviewer: `${reviewer.name} (${presetSummary(reviewer)})`, waiting: true };
  }

  /** A turn ended: the review that waited for it starts, or the user is told why it could not. */
  private async startWaitingReview(sessionId: string): Promise<void> {
    if (!this.reviewsWaiting.delete(sessionId)) return;
    try {
      await this.delegation.startReview(sessionId, { comment: true });
    } catch (error) {
      this.notice(sessionId, `The review did not start: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
  }

  /**
   * A session's agent asked for a review of its own work (`delegate` with the Review role, in its
   * own worktree). It is the same question as the offer when a pull request is opened, so it is
   * asked once, on that card, and nothing starts before the answer, unless the user chose "Always
   * start reviews". What the agent is told.
   */
  async reviewAsked(sessionId: string): Promise<ToolResult> {
    const open = [...(await this.workspace.requestLinks(sessionId))].reverse().find((l) => l.state === 'open' || l.state === 'draft');
    const result = await this.suggestions.suggest(sessionId, { kind: REVIEW_KIND, asked: true, ...(open ? { host: open.host, number: open.number } : {}) });
    if (result.isError) return result;
    if (this.reviewsWaiting.has(sessionId)) return { text: REVIEW_STARTS };
    return { text: result.text === SHOWN_TEXT ? REVIEW_ASKED : `No review was started. ${result.text}` };
  }

  /** Store a session's record soon: something kept with it changed (its review, say). */
  saveRecord(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (rec) this.upkeep.schedulePersist(sessionId, rec);
  }

  /**
   * The worktree was just counted (a sidebar row, the hover card) and has `changed` files. When the
   * list held for the session has another number, it is read again, so the count and the Changes
   * pane never disagree for longer than one look: files changed in the terminal, or by anything
   * that did not report an edit.
   */
  changesCounted(sessionId: string, changed: number): void {
    const rec = this.records.get(sessionId);
    if (rec && rec.files.length !== changed) this.upkeep.scheduleRefresh(sessionId, rec);
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

  /**
   * Show an approval card in the caller's conversation and wait for the user's choice. Raised by a
   * call that can be made again (a Kestrel tool, a role's fallback), its step is stored first, so the
   * card survives a restart; when that call is being made again after one, the stored answer is
   * given instead of a card (runtime/steps.ts).
   */
  async requestApproval(sessionId: string, request: InputRequest): Promise<boolean> {
    const rec = this.records.get(sessionId);
    if (!rec && !inReplay()) return false;
    const given = await this.steps.beforeCard(sessionId, { requestId: request.id, tool: request.tool, title: request.title, detail: request.detail });
    if (given !== null) return given;
    if (!rec) return false;
    return new Promise((resolve) => {
      rec.kestrelRequests.set(request.id, resolve);
      this.host.onEvent(sessionId, rec, { type: 'needs-input', request: { ...request, kestrel: true } });
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
  launchChild(child: Session, project: Project, source: ProjectFolder | null, prompt: string, origin: ChildOrigin, model: string, parentPermission: PermissionLevel | undefined, speed: Pick<SessionSettings, 'effort' | 'fast'> = {}, hosted?: { guest: Guest; host: Pick<Session, 'worktreePath' | 'branch'> }, roleRun: RoleRun | null = null, spawnedBy: string | null = null): Promise<{ ok: true } | { ok: false; reason: string }> {
    return launchChild(this.host, child, project, source, prompt, origin, model, parentPermission, speed, hosted, roleRun, spawnedBy);
  }
}
