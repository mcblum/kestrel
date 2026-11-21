// "Open in" on a hover card (a project's, a session's): the default app with one click, and every
// app from "Open in…", for the folder behind the row. The same apps, default and action as the
// panes' Open in button and the row's menu (`openInMenu`, `open-folder` by scope). Nothing is drawn
// when no app here can open a folder.
import { ExternalLink, FolderOpen } from 'lucide-react';
import { openInMenu } from '@kestrel/server/file-menu';
import { CARD_GAP, hoverCard, useHoverCard } from '../hoverCardState.ts';
import { contextMenu } from '../menuState.ts';
import { actions } from '../store.ts';
import { useFolderApps } from './folderApps.ts';

/** `scope` is the scope key of what the card is about: a session's id, or `project:<id>`. */
export function CardOpenIn({ scope }: { scope: string }) {
  const { apps, defaultApp } = useFolderApps();
  const card = useHoverCard();
  if (apps.length === 0) return null;
  const app = apps.find((a) => a.id === defaultApp) ?? null;
  return (
    <>
      {app && (
        <button type="button" className="menu-item card-line" title={`Open the folder in ${app.label}`} onClick={() => (hoverCard.close(), void actions.openFolder(scope, app.id))}>
          <ExternalLink aria-hidden />
          <span>Open in {app.label}</span>
        </button>
      )}
      <button
        type="button"
        className="menu-item card-line"
        aria-haspopup="menu"
        title="Open the folder in another app"
        onClick={(event) => {
          // The list takes the card's place beside the sidebar, its top where the card's was, moved
          // only as far as the window needs (Matt, 2026-11-19).
          const items = openInMenu(apps, scope, defaultApp);
          hoverCard.close();
          if (card) contextMenu.openBeside(card.anchor, items, { gap: CARD_GAP });
          else contextMenu.openFrom(event.currentTarget, items);
        }}
      >
        <FolderOpen aria-hidden />
        <span>Open in…</span>
      </button>
    </>
  );
}
