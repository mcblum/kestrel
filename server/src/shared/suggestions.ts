// Optional actions (design doc: "Optional actions (suggestions)"). The session's model can drop
// one into the conversation with the `suggest` tool; it never blocks the turn and never makes the
// session need the user. Kestrel decides whether the user is asked (suggestions/registry.ts) and does
// the work when a button is pressed. Pure and shared with the UI.
//
// A suggestion lives in the conversation as a message of its own, at the point it was raised: open,
// it draws nothing there (the card sits at the foot, above the message box); once answered or
// dismissed it is one quiet line, with Undo where its kind supports it. Being part of the
// conversation, it is stored and restored with it, by every persistence backend.
import type { ChatMessage } from '../model.ts';

export type SuggestionState = 'open' | 'answered' | 'dismissed' | 'expired';

export interface SuggestionButton {
  id: string;
  label: string;
  /** Drawn as the main choice; the others are quieter. */
  primary?: boolean;
  /**
   * A checkbox drawn beside this button (Autopilot's "Merge it when it is green"): ticked, pressing the
   * button sends `id`, another button of the same card, instead. A window draws it; a phone, which shows
   * every button, offers that one as it is.
   */
  toggle?: { id: string; label: string; checked: boolean };
  /**
   * Choices drawn with this button as one group of checkboxes (Autopilot's Merge it when it is green and Watch
   * the target branch's pipeline), each ticked or not to begin with. A client that knows them draws them instead
   * of `toggle` and sends the ticked ones' ids with the answer (`toggles`); one that does not uses `toggle`.
   */
  toggles?: SuggestionToggle[];
  /** Not drawn as a button of its own in the window: it is reached through another's `toggle`. */
  folded?: boolean;
}

/** One checkbox of a button's group of choices (`SuggestionButton.toggles`). */
export interface SuggestionToggle {
  id: string;
  label: string;
  checked: boolean;
}

/**
 * Names the user may choose on the card before pressing a button (a tag card's tags): the ones
 * offered to click, the ones chosen to begin with, and the buttons that take the choice. The window
 * draws them as chips with a field to type more into, and sends what is chosen with the answer
 * (`picks`); an answer without any, as a phone sends, takes `chosen`.
 */
export interface SuggestionPicks {
  /** What the names are. */
  of: 'tag';
  /** Chosen when the card appears: what the model suggested. */
  chosen: string[];
  /** Others to choose with one click. */
  offered: string[];
  /** The ids of the buttons that act on the choice; the others ignore it. */
  buttons: string[];
}

export interface Suggestion {
  id: string;
  /** The session whose conversation it is in. */
  sessionId: string;
  /**
   * The session it is about and acts on, when that is another one: a delegate child's card about its pull
   * request, shown on the top of its tree (shared/request-cards.ts). Absent: the session it is in.
   */
  about?: string;
  /** Which entry of the registry owns it ("tag"). */
  kind: string;
  title: string;
  /** One line under the title, in quiet text. */
  reason?: string;
  /**
   * The text the action would send somewhere, whole (a ticket comment), as Markdown: drawn under the
   * title so the user reads what they are allowing before they allow it. Absent from older servers.
   */
  detail?: string;
  /** Names to choose from before answering; absent from most kinds and from older servers. */
  picks?: SuggestionPicks;
  /** What the model proposed, as the kind validated it. */
  payload: Record<string, unknown>;
  buttons: SuggestionButton[];
  state: SuggestionState;
  /** The button pressed, when answered or dismissed. */
  answer?: string;
  createdAt: number;
  answeredAt?: number;
  /** The quiet line left in the conversation once it is answered, dismissed or expired. */
  line?: string;
  /** What Undo needs, owned by the kind. Present only while Undo is offered. */
  undo?: Record<string, unknown>;
  /** Applied by a standing rule ("Always"): never shown as a card. */
  auto?: boolean;
  /** A session the line names: drawn as a link that opens it. */
  opens?: string;
  /** A web address the line names (a pull request that was opened): drawn as a link beside the line, not in its text. */
  link?: string;
}

/** A suggestion's message id in the conversation. */
export const suggestionMessageId = (id: string): string => `suggestion-${id}`;

/** Every suggestion in a conversation, oldest first. */
export function suggestionsIn(messages: readonly Pick<ChatMessage, 'suggestion'>[]): Suggestion[] {
  return messages.flatMap((m) => (m.suggestion ? [m.suggestion] : []));
}

/**
 * The suggestions still waiting for the user, oldest first: the first is the card, the rest wait behind it.
 * `applies`, when given, leaves out one that no longer applies though the server has not withdrawn it yet
 * (a card about a request the window already holds as merged; shared/request-cards.ts).
 */
export function openSuggestions(messages: readonly Pick<ChatMessage, 'suggestion'>[], applies?: (s: Suggestion) => boolean): Suggestion[] {
  return suggestionsIn(messages).filter((s) => s.state === 'open' && (!applies || applies(s)));
}

/** What the card at the foot shows: the oldest open suggestion, and how many more wait behind it. */
export function shownSuggestion(messages: readonly Pick<ChatMessage, 'suggestion'>[] | undefined, applies?: (s: Suggestion) => boolean): { suggestion: Suggestion; waiting: number } | null {
  const open = openSuggestions(messages ?? [], applies);
  return open.length ? { suggestion: open[0]!, waiting: open.length - 1 } : null;
}

/** The buttons in the order they are drawn: the primary one first, the rest as given. */
export function orderedButtons(buttons: readonly SuggestionButton[]): SuggestionButton[] {
  return [...buttons.filter((b) => b.primary), ...buttons.filter((b) => !b.primary)];
}

const ID = /^[\w-]{1,100}$/;
const MAX_PICKS = 20;
const PICK_MAX = 200;

/** The `picks` of an answer as a request may send them: a short list of short texts. What each may be is the kind's to say. */
export const isPicks = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_PICKS && value.every((v) => typeof v === 'string' && v.length <= PICK_MAX);

/** A suggestion or button id from a request: short, no separators. */
export const isSuggestionId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

const MAX_TOGGLES = 10;
/** The `toggles` of an answer as a request may send them: a short list of ids. Which may be ticked is the button's to say. */
export const isToggles = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_TOGGLES && value.every(isSuggestionId);
