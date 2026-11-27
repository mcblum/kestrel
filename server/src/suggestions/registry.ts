// The kinds of optional action Kestrel knows. The model only names a kind and gives a payload; the
// kind validates the payload, decides the buttons, decides whether the user is asked at all (its
// policy), and does the work when a button is pressed. The model never defines what a button does.
//
// Adding a kind: write a SuggestionKind (see tag-kind.ts, or note-kind.ts for the smallest one) and
// list it in `suggestionKinds`. The UI needs nothing more: the card draws any kind's title, reason
// and buttons, and the line left in the conversation is the kind's `line`.
import type { ChatMessage, WorkspaceState } from '../model.ts';
import type { Suggestion, SuggestionButton, SuggestionPicks } from '../shared/suggestions.ts';
import type { SuggestionPrefs } from './prefs.ts';

/** What a kind may read and change while it decides or handles a button. */
export interface KindContext {
  sessionId: string;
  /** The session's conversation now (its earlier suggestions are in it). */
  messages: readonly ChatMessage[];
  workspace: {
    state(): Promise<WorkspaceState>;
    tagSession(id: string, tag: string): Promise<readonly string[]>;
    untagSession(id: string, tag: string): Promise<readonly string[]>;
  };
  prefs: SuggestionPrefs;
}

/** What a kind would show: everything of a Suggestion the kind owns. */
export interface Draft {
  title: string;
  reason?: string;
  /** The text the action would send, whole (`Suggestion.detail`). */
  detail?: string;
  /** Names the user may choose before answering (`Suggestion.picks`). */
  picks?: SuggestionPicks;
  payload: Record<string, unknown>;
  buttons: SuggestionButton[];
}

/**
 * The kind's decision about a proposal.
 * - refuse: the payload is wrong or not allowed; the model gets a tool error saying why.
 * - skip: nothing is shown; the model is told why, so it stops trying.
 * - show: the card is shown; with `apply`, that button is pressed at once instead (a standing "Always").
 */
export type Proposal = { type: 'refuse'; reason: string } | { type: 'skip'; text: string } | { type: 'show'; draft: Draft; apply?: string };

/** What pressing a button did. `undo` (kept on the suggestion) offers Undo on its line. */
export interface Pressed {
  state: 'answered' | 'dismissed';
  line: string;
  undo?: Record<string, unknown>;
  /** A session the line names, drawn as a link to it. */
  opens?: string;
  /** A web address the line names (`Suggestion.link`). */
  link?: string;
}

export interface SuggestionKind {
  readonly kind: string;
  /** The button the card's small x stands for (the kind's "not now"). */
  readonly dismiss: string;
  /** Raised by Kestrel only: the `suggest` tool refuses it. */
  readonly kestrelOnly?: boolean;
  propose(ctx: KindContext, payload: Record<string, unknown>): Promise<Proposal>;
  /** `picks`: what the user chose on a card that has `picks`; absent when the answer sent none. */
  press(ctx: KindContext, suggestion: Suggestion, button: string, picks?: readonly string[]): Promise<Pressed>;
  /** Reverses what a press did; returns the new line. Absent: the kind has no Undo. */
  undo?(ctx: KindContext, suggestion: Suggestion): Promise<string>;
}

const KIND_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export class SuggestionRegistry {
  private readonly kinds: ReadonlyMap<string, SuggestionKind>;

  constructor(kinds: readonly SuggestionKind[]) {
    const bad = kinds.find((k) => !KIND_NAME.test(k.kind));
    if (bad) throw new Error(`Suggestion kind "${bad.kind}" is not a valid name.`);
    this.kinds = new Map(kinds.map((k) => [k.kind, k]));
  }

  /** The kinds the model may use, by name. */
  names(): string[] {
    return [...this.kinds.keys()];
  }

  /** The kind, or why there is none. */
  get(kind: unknown): SuggestionKind | { reason: string } {
    const found = typeof kind === 'string' ? this.kinds.get(kind) : undefined;
    return found ?? { reason: `Unknown suggestion kind${typeof kind === 'string' ? ` "${kind.slice(0, 40)}"` : ''}. Kinds: ${this.names().join(', ')}.` };
  }
}
