// What Kestrel knows about "Open in": the apps on this Mac that can open a folder (each with its
// icon), the one the button opens with one click, and what the user chose in Settings → Workflow.
// The server's answer (GET /api/folder-apps), held once in the app store by route; choosing a
// default writes back what the server stored, so the button and the setting show the same thing.
import type { FolderApp } from '@kestrel/server/file-menu';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { fetchResource, useResource } from '../data/resources.ts';
import { act, appStore, call, putResource } from '../store.ts';

export const FOLDER_APPS_PATH = '/api/folder-apps';

export interface FolderApps {
  apps: FolderApp[];
  /** The app the button opens with; null when nothing here can open a folder. */
  defaultApp: string | null;
  /** The user's own choice; null: Kestrel's (VS Code when it is installed). */
  chosen: string | null;
}

const NONE: FolderApps = { apps: [], defaultApp: null, chosen: null };

const asFolderApps = (raw: unknown): Sourced<FolderApps> => {
  const r = (raw ?? {}) as Partial<FolderApps>;
  return ready({ apps: Array.isArray(r.apps) ? r.apps : [], defaultApp: typeof r.defaultApp === 'string' ? r.defaultApp : null, chosen: typeof r.chosen === 'string' ? r.chosen : null });
};
/** What is installed does not change while Kestrel runs: a list that came back is not asked for again. */
const settled = (value: FolderApps) => value.apps.length > 0;

export function useFolderApps(): FolderApps {
  const answer = useResource(FOLDER_APPS_PATH, asFolderApps, '', settled).value;
  return answer.state === 'ready' ? answer.value : NONE;
}

/** The same answer, read where no component is drawn (a row's menu): null until the server has been asked. */
export function heldFolderApps(): FolderApps | null {
  const held = appStore.get().resources.get(FOLDER_APPS_PATH) as Sourced<FolderApps> | undefined;
  return held?.state === 'ready' ? held.value : null;
}

/** Ask for the apps when they are not held yet, so a menu opened next has them. */
export const loadFolderApps = (): Promise<void> => (heldFolderApps() ? Promise.resolve() : fetchResource(FOLDER_APPS_PATH, asFolderApps));

/** Choose the app "Open in" uses by default; null goes back to Kestrel's own choice. */
export async function chooseDefaultFolderApp(defaultApp: string | null): Promise<void> {
  const stored = await act(() => call<unknown>(FOLDER_APPS_PATH, { method: 'PATCH', body: JSON.stringify({ defaultApp }) }));
  if (stored) putResource(FOLDER_APPS_PATH, asFolderApps(stored));
}
