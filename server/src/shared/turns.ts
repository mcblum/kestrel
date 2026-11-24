// Where the turns of a conversation begin and end, and which message carries a finished turn's
// footer (how long it took, when it finished, copy the response). A turn starts with the user's
// message (or a notice from Kestrel that woke the agent, stamped `sentAt`); messages sent together
// (a queue flushed as one turn) start the same turn, but a message after a turn that ended unanswered
// (stopped before the agent said anything) starts a new one. A message the user sent into a running turn
// (`midTurn`, shared/mid-turn.ts) starts none: it is part of the turn it went into, which runs on and
// ends once (its footer times the whole turn, and Fork from it copies through its end). It ends when the agent finishes, is stopped or
// fails; the runtime stamps that on the message that started it (`turnEndedAt`). Pure.
import type { ChatMessage } from '../model.ts';

/** The footer of one finished turn. */
export interface TurnFooter {
  /** Index of the turn's last message: the footer is drawn under it. */
  at: number;
  /** When the turn started and ended, ms since 1970. Absent on turns stored before turns were timed (never made up). */
  timing?: { startedAt: number; endedAt: number };
  /** The agent's text in the turn, in order, as it wrote it, joined by blank lines. Empty when it wrote none. */
  markdown: string;
  /** What forking from this turn needs to know (shared/fork.ts `forkRefusal`). */
  fork: TurnFork;
}

/** A turn as Fork sees it. Primitives only, so a footer that did not change compares equal. */
export interface TurnFork {
  /** The id of the message that started the turn: how the server is told which turn. Null when it has none. */
  turn: string | null;
  /** The conversation's last turn: forking from it copies the conversation as it stands, as before 0.0.18. */
  latest: boolean;
  /** The agent's own point for this turn is known (`ChatMessage.forkPoint`), so an earlier turn can be forked from. */
  point: boolean;
}

/** Whether a message starts (or joins the start of) a turn. */
export const startsTurn = (m: ChatMessage): boolean => m.midTurn === undefined && (m.author === 'you' || m.sentAt !== undefined);

/** Something the agent said in a turn: its text, not tool steps, cards or Kestrel's notices. */
const isResponseText = (m: ChatMessage): boolean => m.author === 'agent' && !m.notice && !m.suggestion && Boolean(m.text.trim());

/** Still going: text streaming, or a card waiting for the user. */
const isOpen = (m: ChatMessage): boolean => Boolean(m.streaming || (m.input && !m.input.resolved));

export interface Span {
  /** First message of the turn (its first starter). */
  start: number;
  /** First message after the starters: where the agent's part begins. */
  replies: number;
  /** Last message of the turn. */
  end: number;
}

/** The turns in order. Messages before the first starter belong to no turn. */
export function turnSpans(messages: readonly ChatMessage[]): readonly Span[] {
  const spans: Span[] = [];
  let current: Span | null = null;
  messages.forEach((m, i) => {
    if (startsTurn(m)) {
      // A starter right after another starter joins its turn, unless that turn already ended (stopped
      // before the agent said anything): the next message starts a turn of its own.
      if (current && current.replies === i && !messages[i - 1]!.turnEndedAt) {
        current.end = i;
        current.replies = i + 1;
        return;
      }
      current = { start: i, replies: i + 1, end: i };
      spans.push(current);
      return;
    }
    if (current) current.end = i;
  });
  return spans;
}

function timingOf(starters: readonly ChatMessage[]): TurnFooter['timing'] {
  const startedAt = starters[0]?.sentAt;
  const ends = starters.map((m) => m.turnEndedAt).filter((t): t is number => t !== undefined);
  if (startedAt === undefined || ends.length === 0) return undefined;
  const endedAt = Math.max(...ends);
  return endedAt >= startedAt ? { startedAt, endedAt } : undefined;
}

/**
 * The footers of the finished turns. A turn is finished once it was stamped ended, or (stored before
 * turns were timed) when nothing in it is still open and it is not the turn the agent is working
 * on (`working`: the session is running). A turn that waits on an unanswered card is not finished.
 */
export function turnFooters(messages: readonly ChatMessage[], working: boolean): TurnFooter[] {
  const spans = turnSpans(messages);
  const footers: TurnFooter[] = [];
  spans.forEach((span, n) => {
    if (span.replies > span.end) return; // the agent has not answered yet
    const starters = startersOf(messages, span);
    const replies = messages.slice(span.replies, span.end + 1);
    const stamped = starters.some((m) => m.turnEndedAt !== undefined);
    const last = n === spans.length - 1;
    if (replies.some(isOpen)) return;
    if (!stamped && last && working) return;
    const markdown = replies.filter(isResponseText).map((m) => m.text.trim()).join('\n\n');
    const timing = timingOf(starters);
    if (!markdown && !timing) return;
    footers.push({ at: span.end, ...(timing ? { timing } : {}), markdown, fork: turnFork(starters, last) });
  });
  return footers;
}

/** The agent's point for a turn, from its starters (the last one is stamped), or null. */
export const forkPointOf = (starters: readonly ChatMessage[]): string | null => starters.findLast((m) => m.forkPoint)?.forkPoint ?? null;

/** What Fork needs to know of a turn, given its starters and whether it is the conversation's last. */
export function turnFork(starters: readonly ChatMessage[], latest: boolean): TurnFork {
  const turn = starters[0]?.id ?? null;
  return { turn, latest, point: turn !== null && forkPointOf(starters) !== null };
}

/** The starters of a turn: the messages from its start up to where the agent's part begins. */
export const startersOf = (messages: readonly ChatMessage[], span: Span): readonly ChatMessage[] => messages.slice(span.start, span.replies);

/**
 * The turn under way (the last one started) ends at `point` in the agent's own conversation:
 * stamped on the same message as `turnEndedAt`. Null when there is nothing to stamp or it is stamped so already.
 */
export function markForkPoint(messages: readonly ChatMessage[], point: string): { index: number; message: ChatMessage } | null {
  const index = messages.findLastIndex(startsTurn);
  if (index < 0 || messages[index]!.forkPoint === point) return null;
  return { index, message: { ...messages[index]!, forkPoint: point } };
}

/** The message a turn ending at `now` is stamped on: the last one that started a turn and is not stamped yet. */
export function endTurn(messages: readonly ChatMessage[], now: number): { index: number; message: ChatMessage } | null {
  const index = messages.findLastIndex(startsTurn);
  if (index < 0 || messages[index]!.turnEndedAt !== undefined) return null;
  return { index, message: { ...messages[index]!, turnEndedAt: now } };
}

/** How long a turn took: "48s", "2m 14s", "1h 03m". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Whether the agent's turn is still under way: the last turn started has not been stamped as ended.
 * True on a turn paused on the agent's own card (an approval, a question, a plan), which a restart
 * cuts off; false once it ended, whatever cards it left. With no turn recorded it cannot be known to
 * have ended, so it counts as under way.
 */
export function turnUnderWay(messages: readonly ChatMessage[]): boolean {
  const index = messages.findLastIndex(startsTurn);
  return index < 0 || messages[index]!.turnEndedAt === undefined;
}
