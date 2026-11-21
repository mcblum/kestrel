// Fork: a new session that carries on from a copy of another's conversation, made by the agent's own
// SDK, in a worktree of its own cut from the old session's branch. The old session and any workstream
// it is in are not touched. Who may fork, and what the copy is called, are decided here, so the
// session menu, the turn foot and the server always agree.
import { AGENT_LABEL, type Agent, type ChatMessage } from '../model.ts';
import { forkPointOf, startersOf, turnFork, turnSpans, type TurnFork } from './turns.ts';

/**
 * Which agents can copy a conversation into a new one through their own SDK: Claude with the Agent
 * SDK's `forkSession`, Codex with app-server's `thread/fork`. Nothing is faked for the others (no
 * transcript pasted into a prompt).
 */
export const FORKS: Readonly<Record<Agent, boolean>> = { claude: true, codex: true, opencode: false };

const WHILE_WORKING = 'Wait for the turn to end';
const cannotFork = (agent: Agent): string => `${AGENT_LABEL[agent]} cannot fork a conversation`;
/** An earlier turn whose agent point Kestrel does not have: forking there would start from the wrong place. */
export const NO_FORK_POINT = 'Kestrel has no record of where this turn ends in the agent’s conversation (it was recorded before Kestrel kept that, or copied in by an earlier fork). Fork from a later turn';

/**
 * Why a session cannot be forked now, or null when it can. A fork is made at a turn boundary only:
 * `working` is a turn running or waiting on the user, and it holds for every turn. `turn` is the turn
 * to fork from (absent: the end of the conversation, as the session menu forks): an earlier turn
 * needs the agent's own point for it. Said as a menu hint and a tooltip.
 */
export function forkRefusal(session: { agent: Agent; working: boolean; turn?: TurnFork }): string | null {
  if (!FORKS[session.agent]) return cannotFork(session.agent);
  if (session.working) return WHILE_WORKING;
  const turn = session.turn;
  return turn && !turn.latest && !turn.point ? NO_FORK_POINT : null;
}

/** What a fork copies of the conversation, and from where the agent copies its own. */
export interface ForkCut {
  messages: readonly ChatMessage[];
  /** The agent's point to copy through; absent: the whole conversation. */
  at?: string;
  /** Forked from a turn before the last: the files are as they are now, ahead of the conversation. */
  earlier: boolean;
}

/**
 * The conversation through the turn started by message `turnId` (absent: all of it). The last turn
 * is the whole conversation, as before turns had points; an earlier one ends with that turn and needs
 * its point. Throws the reason when it cannot be done (`refuse` makes the error).
 */
export function forkCut(messages: readonly ChatMessage[], turnId: string | undefined, refuse: (reason: string) => Error): ForkCut {
  if (turnId === undefined) return { messages, earlier: false };
  const spans = turnSpans(messages);
  const n = spans.findIndex((span) => startersOf(messages, span).some((m) => m.id === turnId));
  if (n < 0) throw refuse('That turn is not in the conversation');
  const span = spans[n]!;
  const starters = startersOf(messages, span);
  const latest = n === spans.length - 1;
  if (latest) return { messages, earlier: false };
  const at = forkPointOf(starters);
  if (!at || !turnFork(starters, latest).point) throw refuse(NO_FORK_POINT);
  return { messages: messages.slice(0, span.end + 1), at, earlier: true };
}

const FORK_MARK = ' (fork)';
const TITLE_MAX = 70;
const UNTITLED = 'Untitled';

/** The old title with " (fork)" once: a fork of a fork is not "(fork) (fork)". Within the title length. */
export function forkTitle(title: string): string {
  let base = title.trim();
  while (base.endsWith(FORK_MARK)) base = base.slice(0, -FORK_MARK.length).trimEnd();
  if (!base) base = UNTITLED;
  const room = TITLE_MAX - FORK_MARK.length;
  return `${base.length > room ? `${base.slice(0, room - 1)}…` : base}${FORK_MARK}`;
}

/** Said in the fork when the old worktree had changes that were not committed: they are not lost, they stayed there. */
export function uncommittedNotice(oldTitle: string, count: number): string {
  const changes = `${count} uncommitted change${count === 1 ? '' : 's'}`;
  return `“${oldTitle}” had ${changes} in its worktree when this fork was made. ${count === 1 ? 'It stays' : 'They stay'} there: this fork’s worktree has the commits only.`;
}

/** Said in a fork made from an earlier turn: the conversation goes back, the files do not. */
export const EARLIER_TURN_NOTICE = 'This fork’s conversation starts from that turn; the files are as they are now, with the work of the later turns in them.';
