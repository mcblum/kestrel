// What needs a window, and what a worker node says when it is asked for one (docs/designs/worker-nodes.md,
// section 3). One pure function: the server uses it where each of these is served (the tools, the routes),
// and every screen that shows a node's session uses it for the same words. Nothing here fails quietly: a
// node that cannot do something says "<name> has no screen." and what was asked.
import { hasNoWindow, type KestrelKind } from './host-kind.ts';

/** Everything that needs a window and so a screen. */
export type WindowThing = 'browser' | 'simulator' | 'open-in' | 'notification' | 'folder-chooser' | 'whats-new';

export const WINDOW_THINGS: readonly WindowThing[] = ['browser', 'simulator', 'open-in', 'notification', 'folder-chooser', 'whats-new'];

/** What was asked, in plain words, to follow "<name> has no screen." */
const ASKED: Record<WindowThing, string> = {
  browser: 'The browser pane and the browser tools need one.',
  simulator: 'The simulator pane and the simulator tools need one.',
  'open-in': 'Open in needs one: it starts an app on the screen of the computer it runs on.',
  notification: 'A desktop notification needs one. Phones of the account are still notified.',
  'folder-chooser': 'Choosing a folder needs one.',
  'whats-new': "What's new needs one.",
};

/** The refusal for each thing on a computer called `name`, or null where nothing is refused (the app refuses none). */
export type WindowRefusals = Readonly<Record<WindowThing, string | null>>;

export function needsWindow(kind: KestrelKind, name: string): WindowRefusals {
  const computer = name.trim() || 'This computer';
  const refuse = (thing: WindowThing): string | null => (hasNoWindow(kind) ? `${computer} has no screen. ${ASKED[thing]}` : null);
  return {
    browser: refuse('browser'),
    simulator: refuse('simulator'),
    'open-in': refuse('open-in'),
    notification: refuse('notification'),
    'folder-chooser': refuse('folder-chooser'),
    'whats-new': refuse('whats-new'),
  };
}
