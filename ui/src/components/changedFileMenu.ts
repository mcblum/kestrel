// The right-click menu on a file in a session's Changes panel. The items come from
// @kestrel/server/file-menu; opening and showing in Finder go through the server (file-open-api.ts),
// which runs on the same Mac, so they work in the app and in a plain browser.
import type { ChangedFile } from '@kestrel/server/model';
import { changedFileMenu, filePick, type FileOpeners } from '@kestrel/server/file-menu';
import { runMenuAction } from '../commands.ts';
import { contextMenu } from '../menuState.ts';
import { ready } from '@kestrel/server/sourced';
import { fetchResource } from '../data/resources.ts';
import { act, appStore, call } from '../store.ts';

/** Where the menu's paths come from: the session and its working folder. */
export interface FileMenuSource {
  sessionId: string;
  folder: string | null;
}

const NONE: FileOpeners = { editors: [], reveal: false };
const EDITORS = '/api/editors';
const asOpeners = (raw: unknown) => ready(raw as FileOpeners);

/** The server's editors, held in the app store and asked for once; none (copies only) when it cannot say, and then asked again next time. */
export async function loadOpeners(): Promise<FileOpeners> {
  const held = () => appStore.get().resources.get(EDITORS);
  if (held()?.state !== 'ready') await fetchResource(EDITORS, asOpeners);
  const answer = held();
  return answer?.state === 'ready' ? (answer.value as FileOpeners) : NONE;
}

const post = (source: FileMenuSource, action: 'open-file' | 'reveal-file', body: Record<string, string>) =>
  act(() => call(`/api/sessions/${encodeURIComponent(source.sessionId)}/${action}`, { method: 'POST', body: JSON.stringify(body) }));

/** Opens the menu at the right-click. `select` shows the file's diff, as a left click on the row does. */
export async function openChangedFileMenu(x: number, y: number, file: ChangedFile, shown: boolean, source: FileMenuSource, select: () => void, row: HTMLElement): Promise<void> {
  const items = changedFileMenu(file, { ...(await loadOpeners()), folder: source.folder, shown });
  contextMenu.open(x, y, items, {
    returnFocus: row,
    onPick: (item) => {
      const pick = filePick(item, file);
      if (!pick) return void (item.action && runMenuAction(item.action));
      if (pick.kind === 'show-diff') return select();
      if (pick.kind === 'open') return void post(source, 'open-file', { path: file.path, editor: pick.editorId });
      void post(source, 'reveal-file', { path: pick.path });
    },
  });
}
