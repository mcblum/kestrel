// A message the user writes while the agent works goes to the agent at once, for it to read within
// the turn it is in, as Claude Code does (Matt, 2026-11-19; design doc, "A message while the agent
// works"). Only in a few cases does Kestrel hold it instead, and it says why. This file is the one
// place those rules and their words live. Pure: the runtime (runtime/mid-turn.ts) and the UI read it.
//
// Only messages the user types go in mid-turn. What another session sends (`ask_session`, news of a
// child) still waits for the turn to end: it is an instruction from another agent, and folding it into
// a turn the agent is in the middle of could confuse both; the user's own words are the ones worth
// interrupting for. The one exception is a note from another session (`send_note`, shared/notes.ts):
// information, not work, which goes in mid-turn by the same means.

/** Why a message the user wrote is held instead of going to the agent at once. */
export type HoldWhy =
  /** A card above waits for the user's answer: the message goes once it is answered. */
  | 'card'
  /** It changes the model, effort, speed or permission mode, which only a new turn can take. */
  | 'settings'
  /** A slash command runs as a turn of its own. */
  | 'command'
  /** The agent could not take it at that moment (its turn was ending, or it takes no messages mid-turn). */
  | 'busy'
  /** Messages held earlier are still waiting: a new one waits behind them, so the order stays. */
  | 'behind'
  /** It went in, but the turn ended before the agent read it (the user pressed Stop, or the turn failed). */
  | 'unread';

/** How far a message sent into a running turn got: sent to the agent, then read by it (where the agent says). */
export type MidTurnState = 'sent' | 'read';

export interface HoldCheck {
  /** A card waits for the user's answer. */
  cardPending: boolean;
  /** The message carries a settings change that differs from the session's settings. */
  changesSettings: boolean;
  /** The text is a slash command. */
  slashCommand: boolean;
  /** Held messages are waiting already. */
  heldBefore: boolean;
  /** The agent takes messages mid-turn at all (`AgentHandle.sendNow`), and is up to take one. */
  canTake: boolean;
}

/** Why a message written now, during a turn, is held; null when it goes to the agent at once. */
export function holdWhy(c: HoldCheck): HoldWhy | null {
  if (c.heldBefore) return 'behind';
  if (c.cardPending) return 'card';
  if (c.changesSettings) return 'settings';
  if (c.slashCommand) return 'command';
  if (!c.canTake) return 'busy';
  return null;
}

/** Held for a reason that may clear within the turn (a card answered, the agent able to take it): tried again when a card is answered. */
export const retriesMidTurn = (why: HoldWhy | undefined): boolean => why === 'card' || why === 'behind' || why === 'busy';

/** A slash command: the message starts with "/" and a name. */
export const isSlashCommand = (text: string): boolean => /^\/[A-Za-z0-9]/.test(text.trim());

/** What the strip above the message box says of held messages, from why the first one is held. */
export function heldHint(why: HoldWhy | undefined, running: boolean, held: boolean, n: number): string {
  const they = n === 1 ? 'It goes' : 'They go';
  if (held || !running) return why === 'unread' ? 'Not read: the turn ended before the agent got to it. Send it again, edit it or remove it.' : 'Not sent: the turn they waited for was stopped, failed or interrupted.';
  switch (why) {
    case 'card':
      return `${they} to the agent once you have answered above.`;
    case 'settings':
      return `${they} when this turn ends: a new model, effort or mode starts with the next turn.`;
    case 'command':
      return `${they} when this turn ends: a slash command runs as a turn of its own.`;
    case 'unread':
      return `The agent did not read ${n === 1 ? 'it' : 'them'} before the turn ended. ${they} as the next turn.`;
    case 'busy':
    case 'behind':
      return `${they} when this turn ends: the agent could not take ${n === 1 ? 'it' : 'them'} in the middle of it.`;
    default:
      // Only another session's messages: they always wait for the turn to end.
      return `${they} when this turn ends.`;
  }
}

/** The quiet words under a message sent into a running turn. */
export const midTurnLabel = (state: MidTurnState): string => (state === 'read' ? 'Read by the agent' : 'Sent while it worked');
