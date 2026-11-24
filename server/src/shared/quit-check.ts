// What quitting Kestrel would stop, for the shell's quit check (app/quit-guard.mjs). Quitting the
// app stops the server and every agent it runs, so before it ends the shell asks the server this
// one question, `GET /api/quit-check`, and keeps no count of its own.
//
// Working is a turn under way (Matt, 2026-11-24): an agent running (`statusOf` 'working'), or a turn
// paused on the agent's own card (an approval, a question, a plan), which a restart cuts off and
// whose card it closes (runtime/start-options.ts). A session whose turn is done does not block,
// whatever card it left: "If the turn is done and there's a card, it'll be there when I get back."
import type { ChatMessage, SessionView } from '../model.ts';
import { statusOf } from './status.ts';
import { turnUnderWay } from './turns.ts';

export interface QuitSession {
  id: string;
  title: string;
}

export interface QuitCheck {
  /** Sessions with a turn under way: quitting cuts that turn off. */
  working: QuitSession[];
}

type Checked = Pick<SessionView, 'id' | 'title' | 'state' | 'note'> & Partial<Pick<SessionView, 'request' | 'stopped'>>;

const named = (s: Checked): QuitSession => ({ id: s.id, title: s.title.trim() || 'Untitled session' });

/** Whether quitting now would cut this session's turn off. `messages`: its conversation (asked only for a session waiting on the user). */
export function isWorkingForQuit(session: Checked, messages: () => readonly ChatMessage[] | undefined): boolean {
  if (statusOf(session) === 'working') return true;
  return session.state === 'attention' && turnUnderWay(messages() ?? []);
}

export function quitCheck(sessions: readonly Checked[], messagesOf: (id: string) => readonly ChatMessage[] | undefined): QuitCheck {
  return { working: sessions.filter((s) => isWorkingForQuit(s, () => messagesOf(s.id))).map(named) };
}
