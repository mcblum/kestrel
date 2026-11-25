// Where What's new opens after an update (docs/designs/kestrel.md, "What's new"). Apart from
// whats-new.ts so that file needs nothing else and the release script can read it as it is.
import { STATUS_DOT, statusOf, type Statused } from './status.ts';
import type { Tab } from './tabs.ts';

/**
 * Whether notes opening after an update come to the front. They open in a new tab just after the tab
 * the window restored in front (tabs.ts `openBeside`), and take the front unless that tab is a session
 * waiting on the user (its dot is amber: it needs an answer, or it failed); then they wait behind it.
 */
export function notesTakeFront(front: Tab | undefined, sessions: readonly (Statused & { id: string })[]): boolean {
  if (front?.kind !== 'session') return true;
  const session = sessions.find((s) => s.id === front.sessionId);
  return !session || STATUS_DOT[statusOf(session)] !== 'amber';
}
