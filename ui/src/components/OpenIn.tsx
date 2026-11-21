// "Open in" on the Changes and Files panes: one button in two parts, like the Create PR button.
// The first part names the default app with its icon and opens the code there with one click; the
// arrow beside it opens the menu of every app on this Mac that can open the code where it is now
// (the session's worktree, or the project's folder): editors, Finder and terminals, each with its
// own icon. The default is the user's choice in Settings → Workflow, else VS Code when it is
// installed (@kestrel/server/file-menu, `defaultFolderApp`). The menu's items come from the one
// place menus are defined (`openInMenu`).
import { ChevronDown, FolderOpen } from 'lucide-react';
import { openInMenu } from '@kestrel/server/file-menu';
import { contextMenu } from '../menuState.ts';
import { actions } from '../store.ts';
import { useFolderApps } from './folderApps.ts';

/** `scope` is the pane's scope key (a session or a project). `what` names the folder for the tooltips: "this session's folder". */
export function OpenIn({ scope, what }: { scope: string; what: string }) {
  const { apps, defaultApp } = useFolderApps();
  const app = apps.find((a) => a.id === defaultApp) ?? null;
  return (
    <span className="pane-open-in" role="group" aria-label="Open in another app">
      <button type="button" className="pane-open-in-app" disabled={!app} title={app ? `Open ${what} in ${app.label}` : 'Nothing here can open a folder'} onClick={() => app && void actions.openFolder(scope, app.id)}>
        {app?.icon ? <img src={app.icon} alt="" aria-hidden /> : <FolderOpen aria-hidden />}
        {app ? app.label : 'Open in'}
      </button>
      <button
        type="button"
        className="pane-open-in-more"
        title={`Open ${what} in another app`}
        aria-label={`Open ${what} in another app`}
        aria-haspopup="menu"
        onClick={(event) => {
          const box = event.currentTarget.parentElement!.getBoundingClientRect();
          contextMenu.open(box.left, box.bottom + 4, openInMenu(apps, scope, defaultApp));
        }}
      >
        <ChevronDown aria-hidden />
      </button>
    </span>
  );
}
