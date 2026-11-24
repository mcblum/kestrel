// The one interface every agent implements (Claude, Codex and OpenCode).
// Designed against the capability table in docs/spike-results.md:
//   - Claude: one in-process query() per run with its input kept open (streaming input), resumed by session id.
//   - Codex: one long-lived `codex app-server` process, JSON-RPC; approvals arrive as requests.
//   - OpenCode: `opencode serve` over HTTP + SSE; permissions arrive as events.
// Everything below is what Kestrel needs from any of them and nothing agent-specific.
import type { AgentSignIn } from './sign-in.ts';
import type { SlashCommand } from '../shared/slash-commands.ts';
import type { SandboxSupport } from './claude/sandbox-support.ts';
import type { Agent, CardQuestion, TodoItem, WidgetCard } from '../model.ts';
import type { PermissionLevel } from '../shared/permissions.ts';
import type { ContextUsage } from '../shared/context-usage.ts';
import type { BackgroundTask } from '../shared/background-tasks.ts';
import type { SandboxAllowEntry, SandboxOffer } from '../shared/sandbox-allow.ts';
import type { SigningAccess } from '../shared/commit-signing.ts';
import type { Bounds } from '../sandbox-allow/match.ts';

// ---- events out -------------------------------------------------------------------

/** Whether the agent has Kestrel's tools. Checked from the agent's own start-up report. */
export type KestrelToolsStatus = 'connected' | 'missing';

/** Where a fork's conversation comes from and works, and the turn it ends with (absent: as it stands). */
export interface ForkWhere {
  from: string;
  to: string;
  at?: string;
}

export type AgentEvent =
  /** The agent process is up. Sent once per start or resume, before anything else. */
  | { type: 'started'; agentSessionId: string; model: string; kestrelTools: KestrelToolsStatus; /** Kestrel tools the agent did not have. */ missing?: string[]; detail?: string;
      /** Set when the session carries tool servers Kestrel did not give it (claude.ai connectors, say). */
      warning?: string }
  /** Agent text. `text` is everything so far for this message; `delta` is the new piece. */
  | { type: 'message'; id: string; text: string; delta: string; done: boolean }
  /** What the agent is doing right now, in a few words ("Thinking…"). Shown live, never stored. */
  | { type: 'status'; text: string }
  /** Something a helper the agent started (its sub-agent tool call `id`) said or did. Shown beside the conversation, never in it. */
  | { type: 'subagent-output'; id: string; text: string }
  /** One tool use. Sent when it starts and again when it ends (same id). */
  | {
      type: 'tool'; id: string; name: string; summary: string; status: 'started' | 'finished' | 'failed'; detail?: string;
      /** A tool call that runs a shell command: the full command line, and the agent's words for it. Listed in the Commands pane. */
      command?: string; label?: string;
      /** Files the call edits, relative to the session's working folder (agents/edited-paths.ts). */
      paths?: string[];
      /** The command was sent to the background: its tool call returns at once while it keeps running. */
      inBackground?: boolean;
      /** Where a background command's output is written, when the agent says (Claude names a file). */
      outputFile?: string;
      /** Kestrel refused this call by a rule of its own (the edit rule, the read-only folders): the reason. Not set for a tool that simply failed. */
      refusal?: string;
      /** The call went through although Kestrel would have refused it, because it could not be stopped (Codex in Auto): the reason. */
      warning?: string }
  /** More of what a running command printed (Codex streams it; Claude is asked for it instead). */
  | { type: 'tool-output'; id: string; delta: string }
  /** The agent's whole task list, as it now stands. */
  | { type: 'todos'; items: TodoItem[] }
  /** One task of the list was added or changed. `status: 'deleted'` removes it. */
  | { type: 'task'; id: string; text?: string; status?: TodoItem['status'] | 'deleted' }
  /** A picture a tool returned, base64. */
  | { type: 'image'; id: string; mediaType: string; data: string }
  /** The user approved a plan: the session leaves plan mode for this level. */
  | { type: 'mode'; permission: PermissionLevel }
  /** The agent is blocked until the user answers. Answer it with `answer(requestId, …)`. */
  | { type: 'needs-input'; request: InputRequest }
  /** Something on disk probably changed; the caller recomputes the list from git. */
  | { type: 'files-changed'; paths: string[] }
  /**
   * The agent finished what it was saying but left work running in the background (`background`):
   * the turn is over for the user and `busy()` is false, so `send` delivers a new message into the
   * same run while that work keeps running. `working`: it started talking again by itself (a task
   * it left running finished and it reacts). A later `done` or `failed` ends the run. Claude only.
   */
  | { type: 'phase'; phase: 'background' | 'working' }
  /** A run ended (its last turn, and any background work it left). The session is idle until the next `send`. `costUsd` is the run's total. */
  | { type: 'done'; reason: 'complete' | 'stopped'; costUsd?: number }
  /** The agent read these messages sent into its running turn (`AgentHandle.sendNow`), by their ids. Sent only by an agent that can tell. */
  | { type: 'picked-up'; ids: string[] }
  /**
   * These messages went into the run (`sendNow`) but the agent never read them before it ended (it was
   * stopped, or failed). Sent just before the run's `done` or `failed`; Kestrel holds them for the user.
   */
  | { type: 'unread'; ids: string[] }
  /** The turn could not finish. `auth` means sign-in is needed, which the UI says plainly. */
  | { type: 'failed'; reason: string; kind: 'auth' | 'other' }
  /** How full the context window is, measured as a turn ends. Shown by the ring under the message box; never stored. */
  | { type: 'context'; usage: ContextUsage }
  /** The slash commands the agent offers in this session, the whole list (shared/slash-commands.ts). */
  | { type: 'slash-commands'; commands: SlashCommand[] }
  /** The user chose "Allow all outside the sandbox": the session keeps that choice, so a restart does not ask again. */
  | { type: 'outside-allowed' }
  /**
   * Where the turn that just ended ends in the agent's own conversation (Claude: its last message's
   * uuid; Codex: the turn id): what `fork` takes as `at` to copy the conversation through it. Sent as
   * each of the agent's turns ends; the latest one stands for the user's turn. Stored, not shown.
   */
  | { type: 'turn-point'; point: string }
  /** Every piece of work the agent left running in the background, as it now stands (replaces the last list). Helpers are not in it. Shown live, never stored. */
  | { type: 'background-tasks'; tasks: BackgroundTask[] }
  /** One piece of background work ended, and how (Claude's task_notification). */
  | { type: 'background-ended'; taskId: string; status: 'completed' | 'failed' | 'stopped'; /** The file its output was written to, when the agent says. */ outputFile?: string };

export interface InputRequest {
  id: string;
  /** `approval`: allow or deny one action. `question`: the agent asked something with choices. */
  kind: 'approval' | 'question';
  /** One line for the card title, e.g. "Write a file". */
  title: string;
  /** What exactly is being asked: the command, the file and its content, or the question. */
  detail: string;
  /** Tool the approval is for; empty for a question. */
  tool: string;
  options: InputOption[];
  /** `detail` is markdown (a plan). */
  markdown?: boolean;
  /** For a question: every question asked, with its choices. */
  questions?: CardQuestion[];
  /** For a command outside the sandbox: what its "Always allow" choices would add (sandbox-allow/). */
  sandboxOffer?: SandboxOffer;
  /** Kestrel's own card (`requestApproval`), not the agent's: it can outlive its turn. Set by Kestrel only. */
  kestrel?: true;
}

/**
 * The user's always-allowed list for commands outside the sandbox, as a session's agent sees it
 * (sandbox-allow/store.ts). Read-only: an agent has no way to add to it. Claude only for now.
 */
export interface SandboxAllowAccess {
  /** The entries as they stand at this moment: a change reaches a running session's next request. */
  entries(): readonly SandboxAllowEntry[];
  /** What a card for this command may offer to add. */
  offer(command: string, bounds: Bounds): Promise<SandboxOffer>;
}

export interface InputOption {
  id: string;
  label: string;
  /** Shown as the primary choice; `deny` options stop the action. */
  role: 'allow' | 'deny' | 'choice';
}

/** What the user chose. `optionId` is one of the request's options; `text` is a free reply. */
export interface InputAnswer {
  optionId?: string;
  text?: string;
  /** For a card with questions: the answer to each, keyed by the question's text. */
  answers?: Record<string, string>;
}

/** Whether an error thrown while starting an agent says it is not signed in (it carries `kind: 'auth'`). */
export function failureKind(error: unknown): 'auth' | 'other' {
  return typeof error === 'object' && error !== null && (error as { kind?: unknown }).kind === 'auth' ? 'auth' : 'other';
}

// ---- calls in ---------------------------------------------------------------------

/** Kestrel's tools, by their plain names. Each adapter exposes them in its own way (in-process
 *  MCP, a stdio MCP server, an MCP entry in the server config) and spells the names its own way. */
export const KESTREL_TOOLS = [
  'list_projects',
  'add_project',
  'handoff',
  'move_to_project',
  'delegate',
  'spawn',
  'session_status',
  'ask_session',
  'complete_workstream',
  'wait_for',
  'archive_session',
  'show_widget',
  'send_file',
  'next_step',
  'post_review',
  'start_review',
  'suggest',
  'ticket_read',
  'ticket_update',
  'browser_navigate',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_console',
  'sim_list',
  'sim_boot',
  'sim_launch',
  'sim_screenshot',
  'sim_tap',
  'sim_swipe',
  'sim_pinch',
  'sim_type',
  'sim_key',
  'sim_button',
  'sim_open_url',
  'sim_appearance',
] as const;
export type KestrelToolName = (typeof KESTREL_TOOLS)[number];

/** Whether a tool's schema is in front of the agent from its first turn. The session tools are
 *  (an agent that has to look `spawn` up first often never does); the browser and simulator
 *  tools are most of the text and used by few sessions, so those are looked up when wanted. */
export function loadsWithSession(name: string): boolean {
  return !name.startsWith('browser_') && !name.startsWith('sim_');
}

/** What a Kestrel tool call gives back to the agent: plain text, never an exception. */
export interface ToolResult {
  text: string;
  isError?: boolean;
  /** A picture for the agent to see as well (base64). It is shown in the conversation too. */
  image?: { mediaType: string; data: string };
}

export interface ProjectInfo {
  name: string;
  /** The default directory's path; null when the project has none yet. */
  path: string | null;
  isGit: boolean;
  /** Every directory, the default first. */
  folders: { name: string; path: string; isGit: boolean }[];
}

/** What an agent may ask Kestrel for, on behalf of one session. Built per session by the runtime. */
export interface KestrelToolHost {
  listProjects(): Promise<ProjectInfo[]>;
  /** Register a folder the agent found on disk as a project, after the user approves. */
  addProject(args: { path: string; name?: string }): Promise<ToolResult>;
  /** The caller is finished with this work and all of it belongs in another project: start a linked session there and stop here. It does not report back. */
  handoff(args: { project: string; folder?: string; summary: string; agent?: string; archive_self?: boolean }): Promise<ToolResult>;
  /** A session with no project moves itself into one, keeping its conversation, after the user approves. */
  moveToProject(args: { project: string; folder?: string; reason?: string }): Promise<ToolResult>;
  /** `start_review`: the user's first message asked for a review of a pull request; offer to make this a review session. */
  startReview(args: { pull_request: string }): Promise<ToolResult>;
  /** Work for one or more sessions of their own, which report back: one child session each; the caller stays as the orchestrator. `name` and `objective` describe the workstream a split across projects makes. */
  delegate(args: { tasks: { project: string; folder?: string; brief: string; agent?: string; role?: string }[]; name?: string; objective?: string }): Promise<ToolResult>;
  /** An unrelated new task in a project. No link. */
  spawn(args: { project: string; folder?: string; brief: string; agent?: string; role?: string }): Promise<ToolResult>;
  /** Send work to a session that already exists (the one whose worktree needs the change); the caller is told when it finishes its turn. */
  askSession(args: { session: string; message: string }): Promise<ToolResult>;
  /** State of the caller's own sessions (or one of them). */
  sessionStatus(args: { id?: string }): Promise<ToolResult>;
  /** The lead of a workstream says the whole task is finished: the workstream is marked complete. Nothing is archived, moved or stopped. */
  completeWorkstream(args: Record<string, never>): Promise<ToolResult>;
  /** The caller, in a workstream, waits on another session of it (shown on the workstream page) and is told when that one finishes; `clear` ends the caller's own wait on it. It does not block. */
  waitFor(args: { session?: string; reason?: string; clear?: boolean }): Promise<ToolResult>;
  /** Archive a session: this one when its turn ends, one it started or one of a workstream it leads at once, any other on the user's yes. Never stops, deletes or restores. */
  archiveSession(args: { session?: string; reason?: string }): Promise<ToolResult>;
  /** Draw something in the conversation: an SVG picture or a small HTML page. */
  showWidget(args: WidgetCard): Promise<ToolResult>;
  /** Put a file the agent made in front of the user. */
  sendFile(args: { path: string; caption?: string }): Promise<ToolResult>;
  /** End the turn with where things stand and replies the user can pick. */
  nextStep(args: { recap: string; ask?: string; replies?: string[] }): Promise<ToolResult>;
  /** Hand over a finished review of somebody else's pull request; the user posts it (review-requests/reply.ts). */
  postReview(args: { verdict?: unknown; summary?: unknown; findings?: unknown; earlier?: unknown }): Promise<ToolResult>;
  /** Drop an optional action into the conversation (suggestions/service.ts). Never waits for the user. */
  suggest(args: { kind: string } & Record<string, unknown>): Promise<ToolResult>;
  /** A ticket as the tracker has it now (status, description, criteria, comments): the session's own, or a listed one named by `key`. Read only. */
  ticketRead(args?: { key?: string }): Promise<ToolResult>;
  /** Propose a change to the session's ticket (In progress, In review, a comment), as a `ticket` suggestion: never waits for the user. */
  ticketUpdate(args: { change: string; body?: string; reason?: string }): Promise<ToolResult>;
  /** The session's browser pane, which the user watches. See browser-tools.ts. */
  browserNavigate(args: { url: string }): Promise<ToolResult>;
  browserRead(args: { max_chars?: number }): Promise<ToolResult>;
  browserClick(args: { ref: number }): Promise<ToolResult>;
  browserType(args: { ref: number; text: string; submit?: boolean }): Promise<ToolResult>;
  browserScreenshot(): Promise<ToolResult>;
  browserConsole(): Promise<ToolResult>;
  /** The iOS Simulator, driven by the server (works with the session in the background). See sim-tools.ts. */
  simList(): Promise<ToolResult>;
  simBoot(args: { device: string }): Promise<ToolResult>;
  simLaunch(args: { app_path?: string; bundle_id?: string }): Promise<ToolResult>;
  simScreenshot(): Promise<ToolResult>;
  simTap(args: { x: number; y: number; duration_ms?: number }): Promise<ToolResult>;
  simSwipe(args: { x1: number; y1: number; x2: number; y2: number; duration_ms?: number }): Promise<ToolResult>;
  simPinch(args: { x: number; y: number; scale: number; rotation_deg?: number; duration_ms?: number }): Promise<ToolResult>;
  simType(args: { text: string }): Promise<ToolResult>;
  simKey(args: { key: string; modifiers?: ('command' | 'shift' | 'option' | 'control')[] }): Promise<ToolResult>;
  simButton(args: { button: 'home' | 'lock' | 'siri' | 'volume_up' | 'volume_down' | 'shake' }): Promise<ToolResult>;
  simOpenUrl(args: { url: string }): Promise<ToolResult>;
  simAppearance(args: { mode: 'light' | 'dark' }): Promise<ToolResult>;
}

/** An action an agent is about to take, for rules to inspect (annoyances, later). */
export interface ToolAction {
  tool: string;
  input: Record<string, unknown>;
}
export type Intercept = { allow: true } | { allow: false; message: string };

export interface StartOptions {
  /** Variables from the environment settings (shared/project-env.ts), added to the agent's process; none when absent. */
  env?: Record<string, string>;
  /** Where the agent works: a worktree, a plain folder, or a scratch folder when read-only. */
  directory: string;
  /** Standing instruction for this session (same text for every agent). */
  instruction: string;
  tools: KestrelToolHost;
  model?: string;
  /** Reasoning effort, one of the model's `efforts`; absent means the model's own default. */
  effort?: string;
  /** Fast mode on or off; absent leaves it to the agent. Only for a model with `fast`. */
  fast?: boolean;
  /** How much the agent may do without asking. `readonly` means no edits and no commands;
   *  `readableDirectories` can still be read. */
  permission: PermissionLevel;
  readableDirectories?: string[];
  /**
   * Hold this session's shell commands to its own folder, as its file edits already are: set for a
   * session another session started (handoff, delegate, spawn). An agent that cannot do it itself
   * ignores it (Codex sandboxes every session's commands already).
   */
  confineShell?: boolean;
  /**
   * Whether this computer can sandbox commands (agents/claude/sandbox-support.ts), set with
   * `confineShell`. Absent means it can. Where it cannot (Windows; Linux without bubblewrap), a
   * confined Claude session runs no command without asking, and the card says why.
   */
  sandboxSupport?: SandboxSupport;
  /**
   * The user already chose "Allow all outside the sandbox" in this session: its commands that
   * leave the sandbox run without asking, from its first turn after a restart too.
   */
  outsideAllowed?: boolean;
  /** The always-allowed list (Settings → Workflow): its folders widen the sandbox, its commands skip the card. */
  sandboxAllow?: SandboxAllowAccess;
  /**
   * Kestrel's own credential files (shared/protected-files.ts), resolved, set with `confineShell`: a Claude
   * child's sandbox cannot read them, and `intercept` refuses any call that reads, searches or names them.
   */
  protectedFiles?: string[];
  /** What a confined session's sandbox lets through so a signed commit works (shared/commit-signing.ts); absent when its repository does not sign or the user switched it off. */
  commitSigning?: SigningAccess;
  /**
   * What of the user's own agent setup this session gets. Absent means none of it: the session
   * runs isolated, with only Kestrel's tools.
   */
  setup?: {
    /** Load the user's instructions, skills, commands and hooks. */
    loadSettings: boolean;
    /** The session works in a project, so that project's own settings apply too. */
    inProject: boolean;
    /** The user's MCP servers switched on for this project, by name, with their configuration. */
    mcpServers: Record<string, Record<string, unknown>>;
  };
  /** The name of an element the agent read in the browser pane, by ref, for approval titles. */
  browserElement?: (ref: number) => string | null;
  /** Called before every tool use; `{allow:false}` returns the message to the agent. */
  intercept?: (action: ToolAction) => Promise<Intercept>;
  /**
   * Kestrel's tools served over HTTP for this one session (kestrel-mcp/), for an agent that runs
   * them out of process (Codex). `token` is good for this session's tools only.
   */
  kestrelMcp?: { url: string; token: string };
}

/** One entry in a model picker. `id` is what the agent takes; empty means its default. */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  /** Reasoning effort levels the model takes, lowest first; absent when it has none. */
  efforts?: readonly string[];
  /** It can run in fast mode. */
  fast?: boolean;
  /** The agent's canonical id this entry stands for (an alias such as `opus` resolves to one). */
  resolves?: string;
}

/**
 * What an agent offers, for the controls under the message box: the UI shows only what is here.
 * Built by the runtime from the adapter (its models, `permissions`, and whether it has `contextUsage`).
 */
export interface AgentCapabilities {
  models: ModelOption[];
  fromSdk: boolean;
  /** The permission levels it understands; the mode menu offers only these. */
  permissions: readonly PermissionLevel[];
  /** It can say how full a session's context window is. */
  contextUsage: boolean;
}

/**
 * A file the user attached to a message, as an agent gets it: `file` is where Kestrel stored it
 * (the session's attachments folder, which the session may read). Each adapter decides how the
 * model sees it: Claude gets pictures and PDFs as content (agents/claude/content.ts); an agent
 * that cannot take them gets the note from agents/attachment-note.ts and reads the file itself.
 */
export interface AgentAttachment {
  name: string;
  mediaType: string;
  size: number;
  kind: 'image' | 'file';
  file: string;
}

/** A message the user wrote while a turn runs, handed to the agent at once (`AgentHandle.sendNow`). */
export interface MidTurnMessage {
  /** Kestrel's id for it: what `picked-up` and `unread` name. */
  id: string;
  text: string;
  attachments?: readonly AgentAttachment[];
}

export interface AgentHandle {
  /** The agent's own id for the conversation; what `resume` needs. Known after `started`. */
  agentSessionId(): string | null;
  /** True while a turn is running: the agent is generating or running a tool. Not while it only waits on background work (`phase`). */
  busy(): boolean;
  /** Send a message (its text and any files attached to it) and run a turn. Refuses (throws) while busy; quiet on background work, the message goes into the live run. */
  send(text: string, attachments?: readonly AgentAttachment[]): void;
  /**
   * Optional (0.0.18). Give the agent a message while its turn runs (`busy()`), by the agent's own
   * means, for it to take into account as soon as it can within that same turn (Claude: its streaming
   * input; Codex: `turn/steer`). Resolves true once the agent has it, false when it cannot take one at
   * this moment (no turn running, the turn ending); never rejects for that. On false Kestrel holds the
   * message and sends it when it can, at the latest as the next turn. When the agent reads it, the
   * handle sends `picked-up` with `message.id`, where the agent can tell; one it took and never read
   * before its run ended is listed in `unread`. Absent: every message written during a turn is held
   * and sent as the next turn, as before 0.0.18, so an adapter written without it works unchanged.
   */
  sendNow?(message: MidTurnMessage): Promise<boolean>;
  /** Answer a pending `needs-input`. Throws if there is no such request. */
  answer(requestId: string, answer: InputAnswer): void;
  /** End the running turn. Pending requests are denied. The session can be resumed later. Claude: ends any background work too. */
  stop(): Promise<void>;
  /**
   * Compact the conversation by the agent's own means, as a turn of its own that ends like any other
   * (Claude: its `/compact` command; Codex: `thread/compact/start`; OpenCode: `session.summarize`).
   * Throws while busy, as `send` does. Absent: the agent cannot compact a conversation from Kestrel.
   */
  compact?(): void;
  /** End the agent's process too, for an agent that keeps one per session. The handle is not used again. */
  close?(): Promise<void>;
  /**
   * Stop one piece of background work (a `background-tasks` entry) while its run lasts. Rejects with
   * a reason the user can read when it cannot, as a `BackgroundStopFailed` when the agent can say
   * why (so Kestrel can end the process itself, or show the row as ended). Absent: the agent has no
   * such work to stop.
   */
  stopBackgroundTask?(taskId: string): Promise<void>;
  /** The end of what one piece of background work printed (at most the last 8 KiB, raw). Rejects with a reason when the agent cannot say. */
  backgroundOutput?(taskId: string): Promise<{ text: string; truncated: boolean }>;
}

export interface AgentAdapter {
  readonly agent: Agent;
  /** The models this agent offers right now, from the agent itself where it can say. */
  models(): Promise<{ models: ModelOption[]; fromSdk: boolean }>;
  /** Begin a new conversation and run its first turn (the prompt and any files attached to it). */
  start(options: StartOptions, prompt: string, emit: (event: AgentEvent) => void, attachments?: readonly AgentAttachment[]): AgentHandle;
  /** Reattach to an earlier conversation (after a restart). Nothing runs until `send`. */
  resume(agentSessionId: string, options: StartOptions, emit: (event: AgentEvent) => void): AgentHandle;
  /**
   * Copy a conversation into a new one of the agent's own that `resume` takes (Fork): as it stands,
   * or through the turn whose `turn-point` was `at` (the copy ends with that turn). `from` is the
   * folder the conversation was held in, `to` the folder the copy will work in. Nothing runs.
   * Returns the new conversation's id; rejects with a reason. Absent: the agent cannot fork.
   */
  fork?(agentSessionId: string, where: ForkWhere): Promise<string>;
  /**
   * Whether a session can start now (installed, signed in), and if not, what the user should do.
   * `signIn`: it is not signed in, and `signIn` below can do it from Kestrel. Absent: always.
   */
  availability?(): Promise<{ available: boolean; reason?: string; signIn?: boolean }>;
  /**
   * Signing the agent in from Kestrel, with the agent's own program (sign-in.ts). Absent where that
   * program cannot do it without a terminal of its own: OpenCode signs in to one of many model
   * providers, chosen in its own prompt.
   */
  readonly signIn?: AgentSignIn;
  /** The permission levels it understands. Absent: all of them. */
  readonly permissions?: readonly PermissionLevel[];
  /** How full an idle conversation's context window is, asked without running a turn. Absent when the agent cannot say. */
  contextUsage?(agentSessionId: string, options: StartOptions): Promise<ContextUsage | null>;
  /** The slash commands a session with these options would offer, asked without running a turn. Absent when the agent has none to list. */
  slashCommands?(options: StartOptions): Promise<SlashCommand[] | null>;
}

/**
 * Why stopping one piece of background work failed: it had already ended (`endedAs` says how), the
 * agent does not know it (`unknown`: a task an earlier process started), the agent did not answer
 * (`no-answer`), or it refused for another reason.
 */
export type StopFailure = 'ended' | 'unknown' | 'no-answer' | 'refused';

export class BackgroundStopFailed extends Error {
  constructor(
    message: string,
    readonly why: StopFailure,
    readonly endedAs: 'completed' | 'failed' | 'stopped' = 'stopped',
  ) {
    super(message);
    this.name = 'BackgroundStopFailed';
  }
}
