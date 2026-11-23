import type { ReactNode } from 'react';
import { Ellipsis, Plus } from 'lucide-react';
import { opener } from '../route.ts';
import { openRowMenu, type RowKind } from '../components/sidebarMenuTarget.ts';

/** Below the button, its left edge level with the button's (as the sidebar's …). */
const MENU_GAP = 2;

/** The … beside the page's main action: the same menu as the container's sidebar row (menu.ts, sidebarMenuTarget.ts). */
function HeaderMore({ kind, id, name }: { kind: RowKind; id: string; name: string }) {
  const label = `More for ${name}`;
  return (
    <button
      type="button"
      className="secondary-button small header-more"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      onClick={(event) => {
        openRowMenu(kind, id, { from: event.currentTarget, gap: MENU_GAP }, true);
      }}
    >
      <Ellipsis aria-hidden />
    </button>
  );
}

/**
 * Compact header: the title, and at its right the one primary action (New session) and the …
 * menu; then one quiet line. No eyebrow, no hero.
 */
export function PageHeader({
  title,
  onNewSession,
  newLabel = 'New session',
  line,
  menu,
  actions,
  mark,
}: {
  title: string;
  /** `newTab` is a shift, Cmd or middle click. */
  onNewSession?: (newTab: boolean) => void;
  newLabel?: string;
  line?: ReactNode;
  /** The container whose sidebar menu the … opens. */
  menu?: { kind: RowKind; id: string };
  /** Other buttons for the right of the title (a page with no New session: Pull requests' Refresh). */
  actions?: ReactNode;
  /** What sits just before the title: the colour of the project, tag or workstream the page is of. */
  mark?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-top">
        <div className="page-head-title">
          {mark}
          <h1>{title}</h1>
        </div>
        {(onNewSession || menu || actions) && (
          <div className="page-head-actions">
            {actions}
            {onNewSession && (
              <button className="primary-button small" {...opener(onNewSession)}>
                <Plus aria-hidden /> {newLabel}
              </button>
            )}
            {menu && <HeaderMore kind={menu.kind} id={menu.id} name={title} />}
          </div>
        )}
      </div>
      {line && (
        <div className="page-head-line">
          <span className="page-head-text">{line}</span>
        </div>
      )}
    </header>
  );
}
