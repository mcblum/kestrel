// What's new after an update (server: whats-new/; docs/designs/kestrel.md, "What's new"). The server
// decides whether this copy's notes are due and pushes it (`whatsNew.due`); this opens them once the
// window has its restored tabs and the workspace, then tells the server they were shown, which pushes
// `due: null` to every window. Where they open is one rule each: a new tab just after the restored
// tab in front (shared/tabs.ts `openBeside`), in front unless that tab is a session waiting on the
// user (shared/whats-new-focus.ts `notesTakeFront`). Nothing is kept here but the notes being opened.
import { whatsNewPath } from '@kestrel/server/whats-new';
import { notesTakeFront } from '@kestrel/server/whats-new-focus';
import { appStore, call } from './store.ts';
import { tabActions, tabsView } from './tabsStore.ts';

/** The notes this window is opening (release and hash), so a push in between does not open them twice. */
let opening = '';

function openDue(): void {
  const { whatsNew, workspace } = appStore.get();
  const due = whatsNew?.due;
  if (!due || !workspace || !tabsView().loaded) return;
  const key = `${due.release}:${due.hash}`;
  if (key === opening) return;
  opening = key;
  const { tabs, activeId } = tabsView().state;
  tabActions.openBeside(whatsNewPath(), notesTakeFront(tabs.find((t) => t.id === activeId), workspace.sessions));
  void call('/api/whats-new/shown', { method: 'POST', body: JSON.stringify(due) }).catch((error: unknown) => {
    // Not recorded: they stay due, and open again on the next start rather than never.
    console.error('[kestrel] could not record that what is new was shown', error);
  });
}

/** Settings → General: "Show what's new after an update". The server pushes the new state. */
export const setWhatsNewEnabled = (enabled: boolean) => call('/api/whats-new', { method: 'PATCH', body: JSON.stringify({ enabled }) });

appStore.subscribe(openDue);
openDue();
