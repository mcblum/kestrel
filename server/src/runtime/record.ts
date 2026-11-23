// The in-memory record of one live session, and the small pure helpers around it.
import type { Guest, Review } from '../shared/worktree-guests.ts';
import type { RoleRun } from '../shared/who-does-what.ts';
import type { SlashCommand } from '../shared/slash-commands.ts';
import type { AgentEvent, AgentHandle } from '../agents/types.ts';
import type { ChangedFile, ChatMessage, LivePatch, SessionDetail, SessionSettings } from '../model.ts';
import { DEFAULT_PERMISSION } from '../shared/permissions.ts';
import { applySubagent, type SubAgent } from '../shared/subagents.ts';
import type { Launch } from './workdir.ts';
import { EMPTY_QUEUE, type QueuedMessage, type SessionQueue } from '../shared/queue.ts';
import type { SessionUsage } from '../shared/details.ts';
import type { ContextUsage } from '../shared/context-usage.ts';

export interface Live {
  messages: ChatMessage[];
  files: ChangedFile[];
  /** Why `files` could not be read from the worktree the last time it was asked; null when it was. Live only. */
  filesProblem: string | null;
  agentOutput: string;
  kestrelTools: SessionDetail['kestrelTools'];
  kestrelMissing: string[];
  agentSessionId: string | null;
  handle: AgentHandle | null;
  base: string | null;
  settings: SessionSettings;
  /** What the agent reported spending; null until a turn reports a cost. */
  usage: SessionUsage | null;
  pendingInput: Set<string>;
  /** Approval cards raised by Kestrel itself (delegate, spawn); resolved with the user's choice. */
  kestrelRequests: Map<string, (approved: boolean) => void>;
  /** Messages for this session from other sessions, delivered with its next turn. */
  inbox: string[];
  /** The sessions whose news waits in the inbox, or was sent as a turn of its own (a review's findings). Not stored. */
  newsFrom: string[];
  /** The sessions whose news the turn now running (or last run) was given: what a next step it leaves is about. Not stored. */
  turnNewsFrom: string[];
  /** Messages held for the next turn (shared/queue.ts): another session's, and the few of the user's the agent could not take mid-turn. */
  queue: SessionQueue;
  /**
   * The user's messages sent into the running turn that the agent has not said it read, in order
   * (runtime/mid-turn.ts): held again if the run ends without reading them. Live only.
   */
  midTurn: readonly QueuedMessage[];
  /** The user stopped it: do not wake it for a child's news. Cleared by the next reply. */
  stopped: boolean;
  /** Helpers the agent started inside its own process. Live only: never stored. */
  subagents: SubAgent[];
  /** The message the sub-agent card sits under; null puts it at the end. */
  subagentsAfter: string | null;
  /** The user has written since these helpers finished: the next one starts a new card. */
  subagentsStale: boolean;
  /** The latest meaningful thing the agent did, shown on its row while it works. Written at most once a second. */
  latestNote: string;
  noteTimer: NodeJS.Timeout | null;
  /** Waiting for the current turn to end (draft-a-summary). Resolved on done or failed. */
  turnWaiters: (() => void)[];
  refreshing: boolean;
  refreshAgain: boolean;
  persistTimer: NodeJS.Timeout | null;
  /** One pending refresh per session, outside the chain, so a burst of edits is one diff. */
  refreshTimer: NodeJS.Timeout | null;
  /** Side effects for one session run in order. */
  chain: Promise<unknown>;
  /** A new session still deciding its title and making its worktree; null once its agent is started (or failed to). */
  launching: Promise<void> | null;
  /** Aborts the start in `launching` (the user pressed Stop); null when nothing is starting. */
  launchAbort: AbortController | null;
  /** Stopped before its agent started: how to start it when the user replies. Live only. */
  unstarted: Launch | null;
  /** The agent was asked for its slash commands in this server run (once is enough: a run replaces the list itself). */
  slashAsked: boolean;
  /** The slash commands the agent last listed; stored, so the message box can offer them before the agent next runs. */
  slashCommands: SlashCommand[];
  /** Started by `spawn`. Stored: nothing else records it, and its shell stays confined after a restart. */
  spawned: boolean;
  /** It works in another session's worktree, as that session's guest (shared/worktree-guests.ts). Stored. */
  guest: Guest | null;
  /** A review of this session's work, when one was started (shared/worktree-guests.ts). Stored. */
  review: Review | null;
  /** It was started for a role: the part it was given and who has been tried, so the part can go to the role's next choice (shared/who-does-what.ts). Stored. */
  roleRun: RoleRun | null;
  /** Its settings were changed by Kestrel while a turn ran (a lead moving to the Orchestrate preset): the agent is rebuilt with them before its next turn. Live only. */
  rebuild: boolean;
  /** The user picked this session's model, effort or fast mode themselves, when starting it or since: Kestrel does not move it to another (shared/who-does-what.ts). Stored. */
  modelChosen: boolean;
  /** It was told what leading means for its model (moved, or kept on its agent): said once. Live only. */
  orchestrateTold: boolean;
  /** The user chose "Allow all outside the sandbox" here. Stored, and handed to the agent each time it starts. */
  outsideAllowed: boolean;
  /** Sessions that asked this one for work (`ask_session`) and have not heard how its turn ended. Stored. */
  askers: string[];
  /** How full the context window was when last measured. Live only: asked again after a restart. */
  context: ContextUsage | null;
  /**
   * The agent went quiet on background work it left running (a `phase` event): its turn has ended for
   * the user, so the run's own `done`, when that work ends, only settles the accounts. Cleared by the next message.
   */
  endedForUser: boolean;
  /**
   * The turn now running (or last run) was started by the user writing here, not by Kestrel (a
   * delegated brief, news, another session's ask): its end is not news for the delegate parent
   * (`parentHears`, shared/turn-reports.ts). Live only: after a restart a turn counts as not the user's.
   */
  turnByUser: boolean;
}

export function newRecord(stored: Partial<Live> | null, base: string | null): Live {
  return {
    messages: [],
    files: [],
    filesProblem: null,
    agentOutput: '',
    kestrelTools: 'unknown',
    kestrelMissing: [],
    agentSessionId: null,
    handle: null,
    base,
    settings: { model: '', permission: DEFAULT_PERMISSION },
    usage: null,
    pendingInput: new Set(),
    kestrelRequests: new Map(),
    inbox: [],
    newsFrom: [],
    turnNewsFrom: [],
    queue: EMPTY_QUEUE,
    midTurn: [],
    stopped: false,
    subagents: [],
    subagentsAfter: null,
    subagentsStale: false,
    latestNote: '',
    noteTimer: null,
    turnWaiters: [],
    refreshing: false,
    refreshAgain: false,
    persistTimer: null,
    refreshTimer: null,
    chain: Promise.resolve(),
    launching: null,
    launchAbort: null,
    unstarted: null,
    slashAsked: false,
    slashCommands: [],
    spawned: false,
    guest: null,
    review: null,
    roleRun: null,
    rebuild: false,
    modelChosen: false,
    orchestrateTold: false,
    askers: [],
    outsideAllowed: false,
    context: null,
    endedForUser: false,
    turnByUser: false,
    ...stored,
  };
}

/**
 * Helpers the agent runs in its own process are listed in the conversation, under the message
 * that started them. Helpers started in the same turn share one card. Once the user has
 * written again and none is still working, the next helper starts a new card. They travel on
 * the session's own channel, like the rest of its output: the patch to send is returned.
 */
export function trackSubagent(rec: Live, event: Extract<AgentEvent, { type: 'tool' }>): LivePatch {
  const fresh = event.status === 'started' && (rec.subagents.length === 0 || rec.subagentsStale);
  if (fresh) rec.subagentsStale = false;
  rec.subagents = applySubagent(fresh ? [] : rec.subagents, event);
  if (fresh) rec.subagentsAfter = rec.messages.at(-1)?.id ?? null;
  return { subagents: rec.subagents, subagentsAfter: rec.subagentsAfter };
}

/** The fields of a settings change that are set, so an absent one keeps the session's value. */
export function definedChange(change: Partial<SessionSettings>): Partial<SessionSettings> {
  return Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as Partial<SessionSettings>;
}

/** Same model, effort, fast mode and permission (an absent effort is the empty one, an absent fast mode is off). */
export function sameSettings(a: SessionSettings, b: SessionSettings): boolean {
  return a.model === b.model && a.permission === b.permission && (a.effort ?? '') === (b.effort ?? '') && (a.fast ?? false) === (b.fast ?? false);
}

/** Starting (no agent yet) or in a turn: either way a new message waits. */
export const isWorking = (rec: Live | null | undefined): boolean => !!rec && (rec.launching !== null || !!rec.handle?.busy());

const NOTE_MAX = 120;

/** The first line of a message, without markdown decoration, as one short status line. */
export function noteFromText(text: string): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/^[#>*\-\s`]+/, '').replace(/[*`]/g, '').trim();
  return line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1)}…` : line;
}

/** The time shown beside a message. */
export const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ANSWER_LABEL_MAX = 400;

/** Answers to a question card, short: `Question → Answer; Question → Answer`. */
export function answersLabel(answers: Record<string, string>): string {
  const label = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('; ') || 'Answered';
  return label.length > ANSWER_LABEL_MAX ? `${label.slice(0, ANSWER_LABEL_MAX - 1)}…` : label;
}

/** Text of the agent's latest message in a conversation (not a line from Kestrel), or empty. */
export function lastAgentTextOf(messages: readonly Pick<ChatMessage, 'author' | 'notice' | 'text'>[]): string {
  return messages.findLast((m) => m.author === 'agent' && !m.notice && m.text)?.text ?? '';
}
