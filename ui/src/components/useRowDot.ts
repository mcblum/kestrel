// The dot class for a session row or tab: what is waiting for the user there.
import { dotSeenAt, sessionDot, type RowDot } from '@kestrel/server/unread';
import type { SessionView } from '@kestrel/server/model';
import { useTabs } from '../tabsStore.ts';

const CLASS: Record<RowDot, string> = { 'needs-you': 'amber', unread: 'green', working: 'working', none: 'none' };
const LABEL: Record<RowDot, string> = { 'needs-you': 'Needs your answer', unread: 'New since you last looked', working: 'Working', none: '' };

/** `seen` is null until the first run has recorded what exists; nothing is unread before then. */
export const dotFor = (session: Pick<SessionView, 'id' | 'state' | 'updatedAt' | 'lastActivityAt'>, seen: Readonly<Record<string, number>> | null): RowDot => sessionDot(session, seen);

export function useRowDot(session: Pick<SessionView, 'id' | 'state' | 'updatedAt' | 'lastActivityAt'> | undefined): { className: string; label: string } {
  const seenAt = useTabs((v) => (session && v.seen ? v.seen[session.id] : undefined));
  const known = useTabs((v) => v.seen !== null);
  if (!session) return { className: 'none', label: '' };
  // The rule is unread.ts's; this row subscribes to its own entry only, so others' looks do not redraw it.
  const dot = dotSeenAt(session, !known, seenAt);
  return { className: CLASS[dot], label: LABEL[dot] };
}

export const rowDotClass = (dot: RowDot) => CLASS[dot];

/** What a container row's dot says, for its tooltip: the roll-up over the sessions in it. */
const ROLLUP: Record<string, string> = { amber: 'A session here needs your answer', green: 'A session here has something new since you last looked', working: 'A session here is working' };
export const rollupLabel = (className: string): string | undefined => ROLLUP[className];
