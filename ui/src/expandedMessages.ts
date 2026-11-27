// Which long messages from other sessions the user opened with Show all (shared/message-preview.ts).
// View state, not server data: this window's own, kept while it is open so a row that scrolls out of
// the virtualized list (MessageList.tsx) and back stays as the user left it. Keyed by session and message.
import { useSyncExternalStore } from 'react';

let open: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const keyOf = (sessionId: string, messageId: string) => `${sessionId}\n${messageId}`;
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Open or fold one message. */
export function setExpanded(sessionId: string, messageId: string, on: boolean): void {
  const key = keyOf(sessionId, messageId);
  if (open.has(key) === on) return;
  const next = new Set(open);
  if (on) next.add(key);
  else next.delete(key);
  open = next;
  listeners.forEach((l) => l());
}

/** Whether the user opened this message whole. A row reads only its own answer, so others do not redraw. */
export function useExpanded(sessionId: string, messageId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (messageId ? open.has(keyOf(sessionId, messageId)) : false));
}
