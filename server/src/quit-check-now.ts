// The quit check as it stands now (shared/quit-check.ts): every session this computer runs that quitting would cut off
// or whose card a restart would close. One reading for the shell's `GET /api/quit-check` and a worker node's updater
// (node-update/updater.ts), which waits for the same sessions before it restarts (worker-nodes.md 4.2).
import type { ChatMessage } from './model.ts';
import { quitCheck, type Conversation, type QuitCheck } from './shared/quit-check.ts';
import type { Workspace } from './workspace.ts';

/** The live conversation of a session, where one runs (`SessionRuntime.overlay`). */
export type LiveMessages = (sessionId: string) => { messages: readonly ChatMessage[] } | null | undefined;

export async function quitCheckNow(workspace: Pick<Workspace, 'state' | 'storedDetail'>, live: LiveMessages | null): Promise<QuitCheck> {
  const state = await workspace.state();
  const sessions = [...state.sessions, ...state.archived.sessions];
  // The conversation of each session waiting on the user, to tell a paused turn from a finished one: the live copy where there is one.
  // With the steps stored for Kestrel's own cards: a card whose step is stored survives a restart.
  const conversations = new Map<string, Conversation | undefined>();
  for (const s of sessions) {
    if (s.state !== 'attention') continue;
    const stored = await workspace.storedDetail(s.id);
    const messages = live?.(s.id)?.messages ?? stored?.messages;
    conversations.set(s.id, messages ? { messages, steps: stored?.steps ?? [] } : undefined);
  }
  return quitCheck(sessions, (id) => conversations.get(id));
}
