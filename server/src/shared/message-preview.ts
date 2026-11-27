// Long messages from other sessions are drawn as a preview (issue 77). A child's report back, a guest's
// hand-back, work sent with `ask_session`, a note, and the brief a child starts with can each be pages
// long; the conversation shows the first part of one, with Show all to open it in place and Show less
// to fold it again. Which messages, and where the preview ends, are decided here once; whether one is
// open is the window's view state (ui/src/expandedMessages.ts), never the server's. Pure.
import type { ChatMessage } from '../model.ts';

/** The most characters a preview shows. */
export const PREVIEW_CHARS = 900;
/** The most lines a preview shows. */
export const PREVIEW_LINES = 10;
/** A message is folded only when Show all would add at least this much more: never for a few words. */
const SLACK = 1.3;

/**
 * Whether a message came from somewhere other than the user's own typing: another session (a note, work
 * it sent, a brief it started a child with) or Kestrel passing on another session's news (an info line,
 * which is how a report back and a hand-back arrive).
 */
export function fromElsewhere(message: Pick<ChatMessage, 'byAgent' | 'from' | 'notice'>): boolean {
  return Boolean(message.byAgent || message.from || message.notice === 'info');
}

/** Where the `n`th line break is, or -1 when the text has fewer. */
function nthBreak(text: string, n: number): number {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = text.indexOf('\n', at + 1);
    if (at < 0) return -1;
  }
  return at;
}

/**
 * The first part of `text` to show folded, or null when the text is short enough to show whole. It ends
 * at a line's end, or at a word's, when one is near enough; the caller marks it as cut.
 */
export function previewOf(text: string): string | null {
  const lineCut = nthBreak(text, PREVIEW_LINES);
  const longByLines = lineCut >= 0 && nthBreak(text, Math.ceil(PREVIEW_LINES * SLACK)) >= 0;
  const longByChars = text.length > PREVIEW_CHARS * SLACK;
  if (!longByLines && !longByChars) return null;
  const limit = lineCut >= 0 ? Math.min(lineCut, PREVIEW_CHARS) : PREVIEW_CHARS;
  if (limit >= text.length) return null;
  const head = text.slice(0, limit);
  // Cut at the end of a line already: it is the whole of the first lines.
  if (text[limit] === '\n') return head.trimEnd();
  // Prefer the end of a line, then of a word, when it keeps most of what fits.
  const line = head.lastIndexOf('\n');
  const word = head.search(/\s\S*$/);
  const cut = line >= limit / 2 ? line : word >= limit / 2 ? word : limit;
  return head.slice(0, cut).trimEnd();
}

/** The preview of a message that is folded when long, or null when it is drawn whole. */
export function messagePreview(message: Pick<ChatMessage, 'byAgent' | 'from' | 'notice' | 'text'>): string | null {
  return fromElsewhere(message) ? previewOf(message.text) : null;
}
