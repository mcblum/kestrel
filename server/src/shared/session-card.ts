// What the hover card on a sidebar session row says, as plain lines (the project card's counterpart,
// project-card.ts). Everything comes from what the sidebar already knows: no session is opened to
// draw it. The row's own tooltip used to carry most of this; since the row's hover shows the
// Archive button over its dot and icons, the card is where it is said. Pure; the card draws it.
import { whenText } from './when.ts';
import type { LinkKind } from '../model.ts';

export interface SessionCardInput {
  title: string;
  /** The project it is filed in, or null for a session with no project. */
  project: string | null;
  /** Its group's name, or null when it is in none. */
  group: string | null;
  agent: string;
  /** The status in words ("Working", "Needs you"), and what the row's dot says when that differs ("New output"). */
  status: string;
  dot: string;
  /** The session's one-line note: what it is doing or waiting on. */
  note: string;
  /** "pending", "handed off" or "discarded" (labels.ts filingMark), or null. */
  mark: string | null;
  branch: string | null;
  /** When it last did something (session-order.ts activityAt). */
  activityAt: number;
}

export interface SessionCardLines {
  title: string;
  /** "Kestrel · November launch", "No project". */
  place: string;
  /** "Claude · Working · New output". */
  status: string;
  /** The note, when it says more than the status. */
  note: string | null;
  branch: string | null;
  /** "Last active today 14:05", and the instant it names. */
  when: string;
  at: number;
}

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function sessionCardLines(input: SessionCardInput, now: number): SessionCardLines {
  const place = [input.project ?? 'No project', input.group, input.mark ? capital(input.mark) : null].filter(Boolean).join(' · ');
  const dot = input.dot.toLowerCase();
  const repeats = !dot || dot.includes(input.status.toLowerCase()) || input.status.toLowerCase().includes(dot);
  const status = [input.agent, input.status, repeats ? null : input.dot].filter(Boolean).join(' · ');
  const note = input.note.trim();
  return {
    title: input.title,
    place,
    status,
    note: note && note.toLowerCase() !== input.status.toLowerCase() ? note : null,
    branch: input.branch,
    when: `Last active ${whenText(input.activityAt, now)}`,
    at: input.activityAt,
  };
}

const CAME_FROM: Readonly<Record<LinkKind, string>> = { handoff: 'Handed off from', delegate: 'Part of', fork: 'Forked from' };

/**
 * How a session names the one it came from: "Handed off from X" when the work moved to it, "Part of
 * X" when X delegated it, "Forked from X" when it carries on from a copy of X's conversation. Said
 * the same way in the sidebar, the hover card and the conversation.
 */
export const cameFromText = (kind: LinkKind, parentTitle: string): string => `${CAME_FROM[kind]} ${parentTitle}`;
