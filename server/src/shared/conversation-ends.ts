// What is drawn at the end of a conversation rather than where it was sent, and what is not.
// Two rules, both pure:
//   - A next step the agent left (its recap, question and reply buttons) belongs at the end of the
//     turn. The agent may call the tool and then go on writing, which left the box in the middle of
//     the turn with text after it (Matt, 2026-11-18). While it is still open it is drawn after the
//     last message, once the turn has ended; once answered it stays where it was sent, spent.
//   - A session this one started is marked where it was started (`ChatMessage.started`). Sessions
//     started before that mark existed have none: those are listed at the end only while they
//     still need watching, so finished work does not sit under the conversation for good.
import type { ChatMessage, Link, SessionState } from '../model.ts';

type WithNext = Pick<ChatMessage, 'next'>;

/** A next step that still waits for an answer: not spent, and with replies to pick from. */
export const isOpenNextStep = (m: WithNext): boolean => Boolean(m.next && !m.next.done && m.next.replies.length > 0);

/**
 * The index of the message whose open next step is drawn at the end of the conversation, or null.
 * The latest open one. None while the agent is still working: the turn has not ended, so it is not
 * yet the user's move, and it is not drawn where it was sent either.
 */
export function nextStepAtEnd(messages: readonly WithNext[], working: boolean): number | null {
  if (working) return null;
  for (let i = messages.length - 1; i >= 0; i--) if (isOpenNextStep(messages[i]!)) return i;
  return null;
}

/** Whether the message at `index` is drawn where it was sent: an open next step is not (it is at the end, or waiting for the turn to end). */
export const drawnInPlace = (message: WithNext): boolean => !isOpenNextStep(message);

/** The sessions marked in the conversation where they were started. */
export const markedStarts = (messages: readonly Pick<ChatMessage, 'started'>[]): Set<string> => new Set(messages.flatMap((m) => (m.started ? [m.started.sessionId] : [])));

/**
 * The links listed at the end of a session's conversation: the sessions it started that have no
 * mark in the conversation (they predate it) and are not finished. `stateOf` gives a session's
 * state, or undefined when it is gone.
 */
export function linksAtEnd<L extends Pick<Link, 'parentId' | 'childId'> & Partial<Pick<Link, 'kind'>>>(links: readonly L[], sessionId: string, marked: ReadonlySet<string>, stateOf: (id: string) => SessionState | undefined): L[] {
  return links.filter((l) => {
    // A fork was made by the user, not started by this session's agent: it is not listed here.
    if (l.parentId !== sessionId || marked.has(l.childId) || l.kind === 'fork') return false;
    const state = stateOf(l.childId);
    return state !== undefined && state !== 'done';
  });
}
