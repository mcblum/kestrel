// One page of a conversation: its last N messages, or the N before a given message, so a reader (a
// phone over Kestrel Connect, later the desktop's own transcript) never has to take a long
// conversation whole to show its end (docs/designs/kestrel-connect.md, section 6). Pure.

/** Which part of a conversation: its end, or the messages before one (by `messageKey`). */
export type PageAsk = { last: number } | { before: string; limit: number };

export interface TranscriptPage<M> {
  messages: M[];
  /** The key of the first message on the page, to ask for the page before it; null when this page starts the conversation. */
  before: string | null;
  /** How many messages the conversation holds in all. */
  total: number;
}

/**
 * The key a message is paged by: its id, or for a stored sample message with none, its place
 * (`stored-<index>`, as `SessionRuntime.storedSnapshot` names it).
 */
export const messageKey = (message: { id?: string }, index: number): string => message.id ?? `stored-${index}`;

/** Why `ask` cannot be answered from these messages, or null. */
export function pageRefusal(messages: readonly { id?: string }[], ask: PageAsk): string | null {
  if ('last' in ask) return null;
  return messages.some((m, i) => messageKey(m, i) === ask.before) ? null : 'That message is no longer in the conversation; ask for its end again.';
}

/** The page `ask` names. A `before` that is not in the conversation gives an empty page (check `pageRefusal` first). */
export function transcriptPage<M extends { id?: string }>(messages: readonly M[], ask: PageAsk): TranscriptPage<M> {
  const end = 'last' in ask ? messages.length : messages.findIndex((m, i) => messageKey(m, i) === ask.before);
  if (end < 0) return { messages: [], before: null, total: messages.length };
  const size = 'last' in ask ? ask.last : ask.limit;
  const start = Math.max(0, end - size);
  // A message with no id is given its key, so the reader can ask for the page before it.
  const page = messages.slice(start, end).map((m, j) => (m.id === undefined ? { ...m, id: messageKey(m, start + j) } : m));
  return { messages: page, before: start > 0 ? messageKey(messages[start]!, start) : null, total: messages.length };
}
