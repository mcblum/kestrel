// The data model from docs/designs/kestrel.md ("Data model"). Types only; shared with the UI.
import type { McpServerState } from './shared/mcp-servers.ts';
import type { ReviewReply } from './shared/review-reply.ts';
import type { ReviewEnd, RoundFindings } from './shared/round-findings.ts';
import type { AsideOf } from './shared/asides.ts';
import type { ReviewMark } from './shared/review-requests.ts';
import type { SlashCommand } from './shared/slash-commands.ts';
import type { PermissionLevel } from './shared/permissions.ts';

import type { SubAgent } from './shared/subagents.ts';
import type { LiveBackgroundTask } from './shared/background-tasks.ts';
import type { SessionCommand } from './shared/commands.ts';
import type { SessionQueue } from './shared/queue.ts';
import type { MidTurnState } from './shared/mid-turn.ts';
import type { PullRequestState, SessionUsage } from './shared/details.ts';
import type { Suggestion } from './shared/suggestions.ts';
import type { Attachment } from './shared/attachments.ts';
import type { ContextUsage } from './shared/context-usage.ts';
import type { HostKind } from './shared/host-terms.ts';
import type { SandboxOffer } from './shared/sandbox-allow.ts';
import type { AutopilotRecord } from './shared/autopilot.ts';

export type { QueuedMessage, SessionQueue } from './shared/queue.ts';
export type { Attachment } from './shared/attachments.ts';

import type { Machine } from './shared/machines.ts';

export type Agent = 'claude' | 'codex' | 'opencode';
export type SessionState = 'running' | 'attention' | 'done' | 'interrupted';
/** Only `delegate` makes a child (tree.ts `isChildLink`). `handoff` and `fork` are lineage only: the task moved, or a copy of the conversation carries on. */
export type LinkKind = 'handoff' | 'delegate' | 'fork';

/** One folder of a project (a directory on disk). Git is optional ("A project does not have to be a git repo"). */
export interface ProjectFolder {
  id: string;
  /** The directory's real path. */
  path: string;
  isGit: boolean;
}

/**
 * A named place for sessions with zero, one or several folders, in the user's order
 * (docs/designs/kestrel.md, "Projects with several directories"). Helpers: shared/project-folders.ts.
 */
export interface Project {
  id: string;
  name: string;
  folders: ProjectFolder[];
  /**
   * The folder new sessions start in, chosen explicitly; order carries no meaning. One of `folders`.
   * Absent, or naming a folder no longer there, means the first (`defaultFolder` reads it).
   */
  defaultFolderId?: string | null;
  /** Set on a project only another computer of the account has: it is listed for its sessions, and has no folder here. */
  away?: true;
  /**
   * Set on a project of this computer that other computers of the account have too (by repository key): each
   * of them, with its id for the project there, so New session can start it there (shared/start-computer.ts).
   */
  alsoOn?: { id: string; name: string; projectId: string }[];
  /**
   * Set with `away`: the computers of the account that have it, its repositories, and its folders as they
   * told of them (shared/account-projects.ts). No repositories: a plain folder, only on its computer.
   */
  elsewhere?: {
    /** `projectId`: the project's id on that computer, what a session started there is given (shared/start-computer.ts). */
    machines: { id: string; name: string; projectId?: string }[];
    repos: string[];
    folders: { name: string; isGit: boolean; path?: string }[];
  };
}

/** Shown as "group" in the UI. Spans projects. `auto` marks one created by a delegate split. */
export interface Group {
  id: string;
  name: string;
  auto: boolean;
  createdAt: number;
  /**
   * The project it belongs to: shown under that project in the sidebar and holding only that
   * project's sessions. Absent or null for a group in the Sessions list, which can span projects.
   * One level only: a group never holds another group.
   */
  projectId?: string | null;
}

/**
 * A named piece of work that reaches across projects: references to the sessions doing it. A
 * session stays filed in its own project; the workstream only points at it. Made by a `delegate`
 * that spans projects (docs/designs/kestrel.md, "Workstreams"); rules in shared/workstreams.ts.
 */
export interface Workstream {
  id: string;
  name: string;
  /** What the work is for, in a sentence or two. May be empty. */
  objective: string;
  createdAt: number;
  /** The sessions it points at, in the order they joined. */
  sessionIds: string[];
  /** Whether the work is finished. Absent on workstreams stored before this existed: active. */
  status?: WorkstreamStatus;
  /** When it was archived (out of the sidebar, still searchable); null or absent while it is not. */
  archivedAt?: number | null;
}

/** Did the work finish. Says nothing about whether the workstream is still in the sidebar: that is archiving. */
export type WorkstreamStatus = 'active' | 'complete';

/**
 * A session in a workstream waiting on another session in it, declared by the waiting session's
 * agent (`wait_for`) with a short reason. It ends when the session waited on finishes, or the agent
 * clears it. Rules: shared/waits.ts.
 */
export interface SessionWait {
  workstreamId: string;
  waiterId: string;
  targetId: string;
  reason: string;
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  agent: Agent;
  state: SessionState;
  /** One line of status shown in lists. */
  note: string;
  /** Project the session was started in; null for a no-repo start. */
  startedIn: string | null;
  /** The directory of `startedIn` it works in. Null for sessions from before, and where there is none (resolve with `resolveStartedFolder`). */
  startedFolderId: string | null;
  /** Derived from git evidence; the last value is kept after the worktree is discarded. */
  landedIn: string | null;
  worktreePath: string | null;
  branch: string | null;
  worktreeDiscarded: boolean;
  groupId: string | null;
  createdAt: number;
  /** When anything about the record last changed (state, note, filing, group). The unread dot goes by `lastActivityAt` instead. */
  updatedAt: number;
  /**
   * When the session last did or received something the user would call activity: created, a
   * message sent or an answer given (a turn starting), a turn ending or stopping to ask. Not a
   * rename, tag, pin, move or status-line update. Absent on sessions stored before it existed:
   * read it with `activityAt` (shared/session-order.ts), which falls back to `updatedAt`.
   */
  lastActivityAt?: number;
  /** First recorded successful completion; retained when resumed. Older done sessions use their last activity. */
  completedAt?: number;
  /**
   * Its last turn ended because the user stopped it (Stop, Stop all sessions), not because the agent
   * finished: status "Stopped" (shared/status.ts). Set only with state `done`; any other state change clears it.
   */
  stopped?: boolean;
  /**
   * Its current (or last) turn was started by the user writing in it, not by the work it was given:
   * a delegate parent does not hear about such a turn (`parentHears`) and is not waiting on it
   * (`waitingOn`). Set once per turn as it starts; absent means not the user's.
   */
  turnByUser?: boolean;
  /** Set on a session that reviews somebody else's pull request (shared/review-requests.ts); absent on every other. */
  review?: ReviewMark;
  /**
   * Set on a sidebar: a read-only fork of another session, kept to talk over one finding of a card in
   * that session (shared/asides.ts). It is listed nowhere and drawn only in its pane. Added
   * 2026-11-24; absent on every other session.
   */
  aside?: AsideOf;
  /**
   * Set on a guest (shared/worktree-guests.ts): the session whose worktree it works in, its host. A
   * guest has no worktree or branch of its own; where it works is read with `workingTreeOf`
   * (shared/working-tree.ts), never from `worktreePath`. Added 2026-11-24; absent on every other session.
   */
  hostId?: string;
  /**
   * `'setup'` on a session started from Set up this computer's Ask the agent (shared/setup-agent.ts): the
   * only sessions that may run a set-up step or command, each on a card. Set only at creation, by that tab.
   */
  purpose?: 'setup';
  /**
   * Set on a session that runs on another computer of the account (shared/machines.ts): that machine's
   * id. Such a session is never in this computer's `sessions` table or its runtime; it is drawn from
   * the replica, and only in the view a window is sent (`Workspace.view`). Absent on this computer's own.
   */
  runsOn?: string;
}

/**
 * A pull or merge request remembered as belonging to a session, so it stays listed after the
 * session's branch changes (pull-requests/session-requests.ts). Stored apart from the session
 * record, one per (session, host, number); never removed automatically.
 */
export interface RequestLink {
  host: HostKind;
  /** GitHub's `#n`, or GitLab's `!n` (the iid). */
  number: number;
  url: string;
  /** The branch the session was on when the request was first found. */
  branch: string;
  /** When it was linked, ms since 1970. */
  linkedAt: number;
  /**
   * The request's state when a lookup last saw it: written when it is linked, updated whenever a
   * later lookup sees another. Absent on links stored before it was kept (read as unknown).
   */
  state?: PullRequestState;
}

/** A stored link with the session it belongs to, for building every session's view at once. */
export interface SessionRequestLink extends RequestLink {
  sessionId: string;
}

/** Parent and child between sessions. Stored apart from groups; never changed by a move. */
export interface Link {
  id: string;
  parentId: string;
  childId: string;
  kind: LinkKind;
}

// ---- derived --------------------------------------------------------------

/**
 * Where a session is listed.
 * - landed: under `landedIn` (work exists there)
 * - pending: a handoff/delegate child with no change yet, under the project it was started in
 * - started: an ordinary session with no change yet, under `startedIn`
 * - unscoped: no project at all
 * - hidden: a parent that handed off without changing anything; only visible in its child's trail
 */
export type FilingStatus = 'landed' | 'pending' | 'started' | 'unscoped' | 'hidden';

export interface Filing {
  projectId: string | null;
  status: FilingStatus;
  /** The worktree whose changes filed this session has been discarded. */
  discarded: boolean;
}

/** A row in the sidebar tree for one group (or for the ungrouped sessions). */
export interface TreeNode {
  sessionId: string;
  /** How this row relates to its parent row, when it is drawn as a child. */
  via: LinkKind | null;
  /** Set when the session has a parent that is not drawn above it here (it was moved out). */
  movedFrom: string | null;
  children: TreeNode[];
}

// ---- API payloads -----------------------------------------------------------

export interface SessionView extends Session {
  filing: Filing;
  /** `startedFolderId` resolved (shared/project-folders.ts): the directory of `startedIn` it works in, or null when there is none. */
  folderId: string | null;
  /** Short labels the user gave it (shared/tags.ts), in the order added. */
  tags: readonly string[];
  /**
   * The last-seen state of its newest linked request (shared/request-state.ts), or null when it has
   * none or that state is unknown. What decides whether a finished session waits on review (status.ts).
   */
  request: PullRequestState | null;
  /** Its Autopilot (shared/autopilot.ts), on or stopped; absent when it was never turned on. */
  autopilot?: AutopilotRecord;
}

/** Something the user pinned to the top of the sidebar. */
/** `review`: a request the user was asked to review, by its key (shared/review-requests.ts); it is no row of the workspace's. */
export type PinKind = 'session' | 'project' | 'group' | 'review';
export interface Pin {
  kind: PinKind;
  id: string;
  /** When it was pinned, ms since 1970. The PINNED list is in the user's order, not this one. */
  pinnedAt: number;
}

/** One tag on one session, as stored. */
export interface TagRow {
  sessionId: string;
  tag: string;
}

export interface WorkspaceState {
  projects: Project[];
  groups: Group[];
  sessions: SessionView[];
  links: Link[];
  /** Workstreams with a session in sight, oldest first; `sessionIds` lists only sessions in `sessions`. */
  workstreams: Workstream[];
  /** Workstreams the user archived, most recently archived first: out of the sidebar, found by search and in Settings → Archived. */
  archivedWorkstreams: Workstream[];
  /** Declared waits between sessions in sight, inside one workstream (shared/waits.ts). Absent from data written before them. */
  waits?: SessionWait[];
  /** Tree per group id, plus `ungrouped`. */
  trees: Record<string, TreeNode[]>;
  /** Things the user archived, and sessions out of sight because their group or project is. They are in none of the lists above. */
  archived: { sessions: SessionView[]; projects: Project[]; groups: Group[] };
  /** What is pinned and in sight (in the lists above), in the order the user dragged them into. */
  pins: Pin[];
  /** The account's other computers whose sessions are in `sessions` (`runsOn`); absent when there are none. */
  machines?: Machine[];
}

/** One tool use shown under an agent message. `status` is absent on the seeded fake data. */
export interface ChatActivity {
  id?: string;
  icon: 'check' | 'file-diff' | 'terminal' | 'split' | 'arrow-right';
  text: string;
  /** `stopped`: it was still running when the user stopped the turn. */
  status?: 'running' | 'done' | 'failed' | 'stopped';
  /** What the tool returned, clipped. */
  detail?: string;
  /** Files it edited, relative to the session's working folder: each opens the Changes pane at its diff. */
  paths?: string[];
  /** Kestrel refused it by a rule of its own: the reason, shown as text on the step and, one line of it, on the folded row. */
  refusal?: string;
  /** It went through although Kestrel would have refused it (it could not be stopped): the reason, shown with a warning state. */
  warning?: string;
}

/** An agent waiting for the user: approve an action or answer a question. */
export interface InputCard {
  id: string;
  kind: 'approval' | 'question';
  title: string;
  /** Exactly what would run, be written, or is being asked. */
  detail: string;
  tool: string;
  options: { id: string; label: string; role: 'allow' | 'deny' | 'choice' }[];
  /** `detail` is markdown (a plan), not a command or file content. */
  markdown?: boolean;
  /** The questions of a question card, each with its choices. Absent on approvals. */
  questions?: CardQuestion[];
  /** A command outside the sandbox: what its "Always allow" choices add (shared/sandbox-allow.ts). */
  sandboxOffer?: SandboxOffer;
  /**
   * Kestrel's own card (an approval for handoff, delegate, spawn, ask_session, move_to_project,
   * start_review, add_project or a role's fallback preset), not the agent's. It can stay open after
   * its turn ends, and a restart closes it (shared/quit-check.ts). Added 2026-11-24; absent from older servers.
   */
  kestrel?: true;
  /** Set once answered (or abandoned): what was chosen. */
  resolved?: string;
}

/** One question the agent asked, with the choices it offered. */
export interface CardQuestion {
  question: string;
  /** A word or two naming what is being decided. */
  header?: string;
  /** Several choices may be picked. */
  multi?: boolean;
  options: { label: string; description?: string }[];
}

/** One line of the agent's task list. */
export interface TodoItem {
  id?: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Something the agent drew for the user: an SVG picture or a small HTML page, shown sandboxed. */
export interface WidgetCard {
  title: string;
  code: string;
}

/** A file the agent made for the user. `path` is absolute. */
export interface FileCard {
  path: string;
  name: string;
  caption?: string;
  bytes?: number;
}

/** What the agent left the user at the end of a turn: where things stand, and replies to pick from. */
export interface NextStep {
  recap: string;
  ask?: string;
  replies: string[];
  /** The user has replied since; the buttons are spent. */
  done?: boolean;
  /**
   * The sessions whose news the turn was given (a session it started reporting back, a review's
   * findings), by id: the box links to them, so the user can see what the question is about.
   * Absent when the turn was the user's own, and from older servers.
   */
  about?: string[];
}

/** A session this one started (handoff, delegate or spawn), marked in the conversation where it happened. */
export interface StartedSession {
  sessionId: string;
  kind: LinkKind | 'spawn';
}

export interface ChatMessage {
  /** Present on real sessions; streaming updates replace the message with the same id. */
  id?: string;
  author: 'you' | 'agent';
  time: string;
  text: string;
  streaming?: boolean;
  /** An error from the agent or Kestrel rather than something the agent said. */
  notice?: 'error' | 'warning' | 'info';
  /** This failure was the agent not being signed in: the row offers to sign it in, where Kestrel can. */
  signIn?: true;
  activity?: ChatActivity[];
  question?: { text: string; choices: string[] };
  input?: InputCard;
  /** The agent's task list, replaced in place as it works. */
  todos?: TodoItem[];
  widget?: WidgetCard;
  file?: FileCard;
  next?: NextStep;
  /** A finished review of somebody else's pull request, to be posted (shared/review-reply.ts). */
  review?: ReviewReply;
  /** One round's findings from the review of this session's own work (shared/round-findings.ts). Added 2026-11-24; absent from older servers. */
  roundFindings?: RoundFindings;
  /** How the review of this session's own work ended with findings still open: a card that stays above the message box until the user carries on (shared/round-findings.ts). Added 2026-11-24; absent from older servers. */
  reviewEnd?: ReviewEnd;
  /** A session this one started, at the point it started it; the row shows that session's state as it is now. */
  started?: StartedSession;
  /** Pictures a tool returned (a screenshot, an image it read), by file name under the session's media folder. */
  images?: string[];
  /** When a picture message first appeared, ms since 1970: close-together pictures are grouped by it (shared/conversation-folds.ts). Older messages have none. */
  at?: number;
  /** An optional action the agent dropped in (shared/suggestions.ts). Absent from older servers. */
  suggestion?: Suggestion;
  /** Files the user attached to this message. Older messages have none. */
  attachments?: Attachment[];
  /**
   * When this message was sent, ms since 1970: on the user's messages, and on a notice from Kestrel
   * that started a turn. A turn starts with it (shared/turns.ts). Absent from older servers.
   */
  sentAt?: number;
  /**
   * When the turn this message started ended (the agent finished, was stopped or failed), ms since
   * 1970. Absent from older servers, and on a turn a restart cut off.
   */
  turnEndedAt?: number;
  /**
   * Where the turn this message started ends in the agent's own conversation (Claude: the uuid of
   * its last message; Codex: the turn id), which Fork passes to start a new session from that turn
   * (shared/fork.ts). Stamped as the turn ends, like `turnEndedAt`. Absent on turns recorded before
   * Kestrel kept it (0.0.18) and on turns a fork copied (the agent's copy has new ids).
   */
  forkPoint?: string;
  /**
   * The user sent this while the agent was working, into its running turn (shared/mid-turn.ts):
   * 'sent' once the agent has it, 'read' once the agent says it read it. Such a message does not
   * start a turn (shared/turns.ts). Absent on a message that started one, and from older servers.
   */
  midTurn?: MidTurnState;
  /** A note from another session (shared/notes.ts): which one. Its text is the whole line, "From <title>: …". Absent from older servers. */
  from?: { sessionId: string; title: string };
}

export interface ChangedFile {
  path: string;
  status: 'M' | 'A' | 'D';
  /** Unified diff text for this file, as `git diff` prints it. */
  diff: string;
}

/** A project page's Changes: the main checkout's uncommitted changes against HEAD. */
export interface ProjectChanges {
  isGit: boolean;
  /** The checked-out branch, or null (a plain folder, a detached HEAD). */
  branch: string | null;
  files: ChangedFile[];
  /** Why there is no diff to show, when there is none to be had. */
  note: string | null;
  /** The directory these are the changes of; null when the project has none. Absent from older servers. */
  folderId?: string | null;
}

export interface TrailEntry {
  sessionId: string;
  title: string;
  agent: Agent;
  state: SessionState;
  projectName: string | null;
  filingStatus: FilingStatus;
  /** The session's `request` (SessionView), so the trail can say what its status says. */
  request: PullRequestState | null;
  /** The session's `stopped` (Session), for the same reason. */
  stopped?: boolean;
  /** How this entry was reached from the one before it; null for the first. */
  via: LinkKind | null;
  current: boolean;
}

/** What a running session can be changed to from the next message on. */
export interface SessionSettings {
  /** Empty means the agent's default. */
  model: string;
  permission: PermissionLevel;
  /** Reasoning effort; empty or absent means the model's default. Absent on older sessions. */
  effort?: string;
  /** Fast mode; absent means off. */
  fast?: boolean;
}

export interface SessionDetail {
  session: SessionView;
  messages: ChatMessage[];
  files: ChangedFile[];
  agentOutput: string;
  /** Ancestors, this session, then its direct children. */
  trail: TrailEntry[];
  /** Whether the agent confirmed it has Kestrel's tools at session start; `unknown` until it reports. */
  kestrelTools: 'connected' | 'missing' | 'unknown';
  /** Names of Kestrel tools the agent did not have, when `kestrelTools` is `missing`. */
  kestrelMissing?: string[];
  /** Kestrel's own MCP servers in this session, as the agent reported them at its last start (shared/mcp-servers.ts). Absent when it was handed none. */
  mcpServers?: McpServerState[];
  /** The slash commands the session's agent offers, as it last listed them (shared/slash-commands.ts). Absent until it has. */
  slashCommands?: SlashCommand[];
  /** Absent on sample sessions. */
  settings?: SessionSettings;
  /** The agent's own conversation id, needed to resume. Absent on fake sessions. */
  agentSessionId?: string | null;
  /** Messages written while the agent worked, not sent yet (shared/queue.ts). Absent when none ever were. */
  queue?: SessionQueue;
  /** What the agent reported spending, summed over its turns. Absent when nothing was ever recorded (older sessions, agents that do not report cost). */
  usage?: SessionUsage;
  /**
   * Set for a session that runs on another computer (`session.runsOn`); its messages are this computer's copy
   * (remote-conversation.ts). `current`: they are all the session's head says there is. `reachable`: false only
   * when they are not and that machine was asked for the rest and did not answer. `asOf`: when this computer last
   * read the conversation from the account (ms; null if it never has).
   */
  remote?: { machine: Machine; current: boolean; reachable: boolean; asOf: number | null };
}

export const AGENT_LABEL: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

/** The agents a user (or a delegating agent) can pick. One that is not installed shows the reason it cannot start. */
export const SELECTABLE_AGENTS: readonly Agent[] = ['claude', 'codex', 'opencode'];
export const isSelectableAgent = (value: unknown): value is Agent => SELECTABLE_AGENTS.includes(value as Agent);

/** What the live channel sends for a session. Messages replace those with the same id. */
export interface LivePatch {
  messages?: ChatMessage[];
  /** This session was replaced by another (a first-message review request made into a review session) and is about to be removed: a tab showing it shows that one instead. */
  replacedBy?: string;
  /** Messages taken out of the conversation, by id: sent into a turn that ended before the agent read them, and held again. */
  removedMessages?: string[];
  files?: ChangedFile[];
  /** Why the changed-file list could not be read (git's own words); null when it was. Live only. */
  filesProblem?: string | null;
  agentOutput?: string;
  kestrelTools?: SessionDetail['kestrelTools'];
  kestrelMissing?: string[];
  mcpServers?: McpServerState[];
  /** The slash commands the session's agent offers, as it last listed them (shared/slash-commands.ts). Absent until it has. */
  slashCommands?: SlashCommand[];
  settings?: SessionSettings;
  /** What the agent is doing right now ("Thinking…"); empty when it is not working. */
  status?: string;
  /** Helpers the agent started inside its own process. Live only; never stored. */
  subagents?: SubAgent[];
  /** The message the sub-agent card sits under; null puts it at the end. */
  subagentsAfter?: string | null;
  /** Messages waiting for the turn to end. */
  queue?: SessionQueue;
  /** How full the context window is, measured as the last turn ended. Live only. */
  context?: ContextUsage | null;
  /** Work the agent left running in the background (shared/background-tasks.ts), the whole list. Live only; empty when none. */
  backgroundTasks?: LiveBackgroundTask[];
  /** Every command the agent is running or ran while this server runs (shared/commands.ts), the whole list. Live only. */
  commands?: SessionCommand[];
}
