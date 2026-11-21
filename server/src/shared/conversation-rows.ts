// The conversation as a list of rows, the unit the UI virtualizes (only the rows near the screen are
// on the page) and memoizes (a row is drawn again only when what it shows changed). Issue 8, "Long
// conversations stay fast". One row is what used to be drawn at one message's place: the message
// itself (or the fold that starts there), the footer of a turn that ends there, and the sub-agent
// card when it sits under that message. Folded messages and open next steps have no row of their
// own unless a footer or the card needs their place. Pure; the drawing rules stay where they were
// (conversation-folds.ts, turns.ts, conversation-ends.ts).
import type { ChatMessage } from '../model.ts';
import { drawnInPlace } from './conversation-ends.ts';
import { foldConversation, foldRoles, type Fold } from './conversation-folds.ts';
import { turnFooters, type TurnFooter } from './turns.ts';

/**
 * How many messages before a fold it reads besides its members: the lead text just before it, and
 * the tool line before a picture that names it (the picture viewer's caption looks back this far).
 */
export const FOLD_LOOK_BACK = 4;

interface RowBase {
  /** Stable across updates: the message's id where it has one. */
  key: string;
  /** The message the row stands at. */
  index: number;
  /** The footer of the turn that ends at this message. */
  footer?: TurnFooter;
  /** The sub-agent card is drawn under this row. */
  anchored: boolean;
}

/** A message drawn as itself; `textOnly` when its tool lines are drawn in the fold after it. */
export interface MessageRow extends RowBase {
  kind: 'message';
  message: ChatMessage;
  textOnly: boolean;
}

/** A folded stretch, drawn where it begins. `reads` are the messages it reads, from index `from`. */
export interface FoldRow extends RowBase {
  kind: 'fold';
  fold: Fold;
  from: number;
  reads: readonly ChatMessage[];
}

/** A place where nothing of the message is drawn but its turn's footer or the sub-agent card is. */
export interface PlaceRow extends RowBase {
  kind: 'place';
}

export type ConversationRow = MessageRow | FoldRow | PlaceRow;

const keyOf = (messages: readonly ChatMessage[], index: number) => messages[index]?.id ?? `at-${index}`;

/**
 * The rows of a conversation, in order. `anchorAt` is the message the sub-agent card sits under, or
 * -1; under the last message it is drawn after the conversation instead, so no row carries it.
 */
export function conversationRows(messages: readonly ChatMessage[], working: boolean, anchorAt = -1): ConversationRow[] {
  const roles = foldRoles(foldConversation(messages));
  const footers = new Map(turnFooters(messages, working).map((f) => [f.at, f]));
  const rows: ConversationRow[] = [];
  messages.forEach((message, index) => {
    const role = roles.get(index);
    const base = { key: keyOf(messages, index), index, ...(footers.has(index) ? { footer: footers.get(index)! } : {}), anchored: anchorAt === index && index !== messages.length - 1 };
    if (role?.kind === 'fold') {
      const from = Math.max(0, role.fold.start - FOLD_LOOK_BACK);
      rows.push({ ...base, key: `fold-${base.key}`, kind: 'fold', fold: role.fold, from, reads: messages.slice(from, role.fold.members.at(-1)! + 1) });
    } else if (role?.kind !== 'folded' && drawnInPlace(message)) {
      rows.push({ ...base, kind: 'message', message, textOnly: role?.kind === 'text-only' });
    } else if (base.footer || base.anchored) {
      rows.push({ ...base, key: `place-${base.key}`, kind: 'place' });
    }
  });
  return rows;
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function sameFooter(a: TurnFooter | undefined, b: TurnFooter | undefined): boolean {
  if (!a || !b) return a === b;
  const fork = a.fork.turn === b.fork.turn && a.fork.latest === b.fork.latest && a.fork.point === b.fork.point;
  return fork && a.at === b.at && a.markdown === b.markdown && a.timing?.startedAt === b.timing?.startedAt && a.timing?.endedAt === b.timing?.endedAt;
}

function sameFold(a: Fold, b: Fold): boolean {
  return a.start === b.start && a.lead === b.lead && sameList(a.members, b.members) && sameList(a.approvals, b.approvals) && sameList(a.steps, b.steps) && a.pictures.length === b.pictures.length && a.pictures.every((p, i) => p.message === b.pictures[i]!.message && p.name === b.pictures[i]!.name);
}

/** Whether two rows draw the same thing (messages compared by identity: the store keeps unchanged ones). */
export function sameRow(a: ConversationRow, b: ConversationRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.index !== b.index || a.anchored !== b.anchored || !sameFooter(a.footer, b.footer)) return false;
  if (a.kind === 'message') return a.message === (b as MessageRow).message && a.textOnly === (b as MessageRow).textOnly;
  if (a.kind === 'fold') return a.from === (b as FoldRow).from && sameFold(a.fold, (b as FoldRow).fold) && sameList(a.reads, (b as FoldRow).reads);
  return true;
}

/**
 * `next` with every row that draws the same as before replaced by the earlier object, so a row
 * that did not change keeps its identity and a memoized row is not drawn again. Returns `prev`
 * itself when nothing changed.
 */
export function shareRows(prev: readonly ConversationRow[], next: readonly ConversationRow[]): readonly ConversationRow[] {
  const byKey = new Map(prev.map((r) => [r.key, r]));
  const shared = next.map((row) => {
    const before = byKey.get(row.key);
    return before && sameRow(before, row) ? before : row;
  });
  return sameList(shared, prev) ? prev : shared;
}

/** Rough heights before a row is measured, in px: close enough that the scroll bar does not jump much. */
const ESTIMATE = { line: 26, charsPerLine: 90, message: 40, codeBlock: 120, fold: 44, footer: 22, place: 8, steps: 34 } as const;

/** A guess at a row's height before it is on the page; the real height replaces it once measured. */
export function estimateRowHeight(row: ConversationRow): number {
  const footer = row.footer ? ESTIMATE.footer : 0;
  if (row.kind === 'place') return ESTIMATE.place + footer;
  if (row.kind === 'fold') return ESTIMATE.fold + footer;
  const { text, activity } = row.message;
  const lines = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / ESTIMATE.charsPerLine)), 0);
  const blocks = Math.floor((text.match(/```/g)?.length ?? 0) / 2);
  const steps = activity?.length && !row.textOnly ? ESTIMATE.steps : 0;
  return ESTIMATE.message + (text ? lines * ESTIMATE.line : 0) + blocks * ESTIMATE.codeBlock + steps + footer;
}
