// What quitting Kestrel would stop or lose, for the shell's quit check (app/quit-guard.mjs).
// Quitting the app stops the server and every agent it runs, so before it ends the shell asks the
// server this one question, `GET /api/quit-check`, and keeps no count of its own.
//
// Two things hold a quit up (Matt, 2026-11-24), said apart in the dialog:
//   - working: a turn under way. An agent running (`statusOf` 'working'), or a turn paused on the
//     agent's own card (an approval, a question, a plan), which a restart cuts off and whose card it
//     closes (runtime/start-options.ts).
//   - waiting: its turn is done, but one of Kestrel's own cards is still open (`InputCard.kestrel`)
//     that a restart would close. Such a card (handoff, delegate, spawn, ask_session,
//     move_to_project, start_review, add_project, a role's fallback preset) normally has its step
//     stored and survives a restart (shared/waiting-steps.ts), so it holds nothing up. Two cannot: a
//     card raised by an older Kestrel, which stored no step, and one whose answer is being carried
//     out right now, which a restart cuts off part way.
// Any other card a finished turn left survives a restart and holds nothing up: "If the turn is done
// and there's a card, it'll be there when I get back."
//
// Only a session this computer runs holds a quit up (Matt, 2026-11-27: "only sessions running on that
// machine count as 'working'"). Quitting stops this server's agents and no others, so a session on
// another computer of the account (`runsOn`, drawn here from the replica) never counts and is never
// named, whatever its state. `runsHere` says which; the window's update notice counts by `workingHere`.
import type { ChatMessage, SessionView } from '../model.ts';
import { statusOf } from './status.ts';
import { turnUnderWay } from './turns.ts';
import { survives, type WaitingStep } from './waiting-steps.ts';

export interface QuitSession {
  id: string;
  title: string;
}

export interface QuitCheck {
  /** Sessions with a turn under way: quitting cuts that turn off. */
  working: QuitSession[];
  /** Sessions whose turn is done with one of Kestrel's own cards open: quitting closes that card. */
  waiting: QuitSession[];
}

type Checked = Pick<SessionView, 'id' | 'title' | 'state' | 'note'> & Partial<Pick<SessionView, 'request' | 'stopped' | 'runsOn'>>;
type Hold = 'working' | 'waiting' | null;

const named = (s: Checked): QuitSession => ({ id: s.id, title: s.title.trim() || 'Untitled session' });

/** Whether this computer runs the session, so quitting here would stop it: never one on another computer of the account. */
export const runsHere = (session: Pick<Checked, 'runsOn'>): boolean => !session.runsOn;

/**
 * The sessions with an agent running on this computer: what the window can tell at a glance, without the
 * conversations (the update notice holds Restart while there are any). The quit check itself asks `quitCheck`.
 */
export const workingHere = <S extends Checked>(sessions: readonly S[]): S[] => sessions.filter((s) => runsHere(s) && statusOf(s) === 'working');

/** Whether one of Kestrel's own cards is open in the conversation that a restart would close: one with no stored step waiting on it. */
export const hasOpenKestrelCard = (messages: readonly ChatMessage[], steps: readonly WaitingStep[] = []): boolean => messages.some((m) => m.input?.kestrel === true && !m.input.resolved && !survives(steps, m.input.id));

/** What the quit check reads of a session waiting on the user. */
export interface Conversation {
  messages: readonly ChatMessage[];
  steps?: readonly WaitingStep[];
}

/**
 * What quitting now would do to this session: cut its turn off ('working'), close one of Kestrel's
 * own cards ('waiting'), or nothing. `messages`: its conversation, asked only for a session waiting on the user.
 */
export function quitHold(session: Checked, conversation: () => Conversation | undefined): Hold {
  if (statusOf(session) === 'working') return 'working';
  if (session.state !== 'attention') return null;
  const { messages = [], steps = [] } = conversation() ?? {};
  if (turnUnderWay(messages)) return 'working';
  return hasOpenKestrelCard(messages, steps) ? 'waiting' : null;
}

export function quitCheck(sessions: readonly Checked[], messagesOf: (id: string) => Conversation | undefined): QuitCheck {
  const check: QuitCheck = { working: [], waiting: [] };
  for (const s of sessions) {
    if (!runsHere(s)) continue;
    const hold = quitHold(s, () => messagesOf(s.id));
    if (hold) check[hold].push(named(s));
  }
  return check;
}
