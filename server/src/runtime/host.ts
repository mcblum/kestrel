// What the slices of the session runtime share (0.0.18). `SessionRuntime` (runtime.ts) stays the
// one facade callers use; the modules it hands work to (`events.ts`, `turns.ts`, `bring-up.ts`,
// `agent-options.ts`, `agent-info.ts`, `session-worktrees.ts`) each take the part of this they
// need (`Pick<RuntimeHost, …>`), built once by the runtime. Nothing here holds state of its own.
import type { McpServerStore } from '../mcp-servers/store.ts';
import type { WhoDoesWhatPrefs } from '../who-does-what/prefs.ts';
import type { GitDefaultsPrefs } from '../git-defaults/prefs.ts';
import type { ProjectEnvPrefs } from '../project-env/prefs.ts';
import type { ScriptsHost } from './project-scripts.ts';
import type { AgentAdapter, AgentEvent, KestrelToolHost, StartOptions } from '../agents/types.ts';
import type { AttachmentStore } from '../attachments/store.ts';
import type { BaseRefresh } from '../base-refresh.ts';
import type { BrowserTools } from '../browser-tools.ts';
import type { CommitSigning } from '../commit-signing/prefs.ts';
import type { ChildOrigin, Delegation } from '../delegation.ts';
import type { Display } from '../display.ts';
import type { GitPrefs } from '../git-settings/prefs.ts';
import type { Agent, LivePatch, Project, ProjectFolder, Session, SessionSettings } from '../model.ts';
import type { ProjectEdits } from '../project-edits/prefs.ts';
import type { StartBase } from '../start-base/prefs.ts';
import type { SandboxAllowList } from '../sandbox-allow/store.ts';
import type { SessionQueue } from '../shared/queue.ts';
import type { TranscriptAction } from '../transcript.ts';
import type { Workspace } from '../workspace.ts';
import type { BackgroundWork } from './background.ts';
import type { Commands } from './commands.ts';
import type { MidTurnHost } from './mid-turn.ts';
import type { Live } from './record.ts';
import type { Titler } from './titling.ts';
import type { Upkeep } from './upkeep.ts';
import type { WaitingSteps } from './steps.ts';

/** A state change the user would call activity: a turn starting or ending, the agent asking (Workspace.setState). */
export const ACTIVITY = { activity: true } as const;

export interface RuntimeHost {
  readonly workspace: Workspace;
  readonly adapters: Partial<Record<Agent, AgentAdapter>>;
  readonly dataDir: string;
  /** Every session loaded this server run, by id. */
  readonly records: Map<string, Live>;
  /** Which agent each live session runs, for the words the Commands pane uses. */
  readonly agents: Map<string, Agent>;
  readonly upkeep: Upkeep;
  readonly background: BackgroundWork;
  readonly commands: Commands;
  readonly attachments: AttachmentStore;
  readonly delegation: Delegation;
  /** Kestrel's own steps waiting on a card, stored so they survive a restart (runtime/steps.ts). */
  readonly steps: WaitingSteps;
  readonly display: Display;
  readonly browser: BrowserTools;
  readonly titler: Titler;
  readonly gitPrefs: GitPrefs;
  readonly baseRefresh: BaseRefresh;
  readonly projectEdits: ProjectEdits;
  /** Each project's remembered answer to where a new session starts (start-base/prefs.ts). */
  readonly startBase: StartBase;
  /** Each project's setup and archive scripts, and what runs them (runtime/project-scripts.ts). */
  readonly projectScripts: ScriptsHost;
  /** Variables, .env files and files copied into new worktrees (project-env/prefs.ts). */
  readonly projectEnv: ProjectEnvPrefs;
  /** Kestrel's own list of MCP servers (mcp-servers/store.ts); null when this copy has none (tests). */
  readonly mcpServers: McpServerStore | null;
  /** The model presets and the "Who does what" table (who-does-what/prefs.ts). */
  readonly whoDoesWhat: WhoDoesWhatPrefs;
  /** Each project's base branch and remote (git-defaults/prefs.ts). */
  readonly gitDefaults: GitDefaultsPrefs;
  readonly sandboxAllow: SandboxAllowList;
  readonly commitSigning: CommitSigning;
  readonly midTurn: MidTurnHost;
  now(): number;
  /** Where an out-of-process agent reaches a session's Kestrel tools; null until the HTTP server is up. */
  mcpAccess(): ((sessionId: string) => { url: string; token: string }) | null;

  /** Send what changed on a session's live channel. */
  emitLive(id: string, patch: LivePatch): void;
  /** Run an action through the transcript and send what changed. */
  apply(id: string, rec: Live, action: TranscriptAction): void;
  /** Chain a side effect after the session's earlier ones. */
  queue(rec: Live, work: () => Promise<unknown>): void;
  setQueue(id: string, rec: Live, queue: SessionQueue): void;
  notice(id: string, text: string, level: 'info' | 'warning' | 'error'): void;
  /** What the session's agent reported (events.ts). */
  onEvent(id: string, rec: Live, event: AgentEvent): void;
  /** Send what is queued as the next turn, saying so when it cannot. */
  flushQueue(id: string): Promise<void>;
  /** A turn ended complete (not stopped): what follows on it that is not the turn's own (a ticket's summary proposal). Not waited for. */
  turnComplete(id: string): void;
  /** Nothing the agent's process ran is running any more. */
  endRunning(id: string): void;
  /** Resolves when every queued side effect for the session has run. */
  idle(id: string): Promise<void>;

  scratch(): string;
  sessionOrThrow(id: string): Promise<Session>;
  recordFor(session: Session): Promise<Live | null>;
  checkPlainFolderFree(project: Project, folder: ProjectFolder, sessions: readonly Session[], except?: string): void;
  toolHost(sessionId: string): KestrelToolHost;
  optionsFor(session: Session, rec: Live, forTurn?: boolean): Promise<StartOptions>;
  startOptions(sessionId: string, directory: string, branch: string | null, project: Project | null, folder: ProjectFolder | null, settings: SessionSettings, origin?: ChildOrigin): Promise<StartOptions>;
}
