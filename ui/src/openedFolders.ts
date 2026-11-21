// Folders opened with Kestrel from outside (dropped on its Dock icon): they are shown on the Create
// project page, added to its folder list. They wait here until that page takes them, so they arrive
// whether the page was already open (with whatever was typed in it kept) or is opened for them.
import { openCreateProject } from './projectNav.ts';
import { currentRoute } from './route.ts';

let waiting: readonly string[] = [];
const listeners = new Set<() => void>();

/** Hand every waiting folder to the caller and forget them. */
export function takeOpenedFolders(): readonly string[] {
  const taken = waiting;
  waiting = [];
  return taken;
}

/** Called when folders arrive; the Create project page adds them to its list. */
export function onOpenedFolders(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Show Create project with these folders added: the page in front if it already is, else opened like "Add project". */
export function openFoldersInCreateProject(paths: readonly string[]): void {
  if (paths.length === 0) return;
  waiting = [...waiting, ...paths];
  // On the page's "Several from a folder" way in, the one-project form is not there to take them.
  const view = currentRoute().view;
  if (view.kind !== 'new-project' || view.from === 'folder') openCreateProject();
  for (const listener of listeners) listener();
}
