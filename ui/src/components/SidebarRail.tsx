// The sidebar as a narrow icon rail, drawn instead of the full sidebar when the window is too narrow
// for it (sidebarRail.ts). Icons only, each doing what its row in the full sidebar does: Overview,
// New session, Pull requests, Search, and Settings at the foot. Between them, the sessions that need a look:
// the pinned ones, then any waiting for an answer, as their initial with the row's dot (or, with no
// dot, its open request's icon: RowRequest.tsx); the title is in the tooltip. The rest is one
// click on the sidebar toggle away (the full sidebar, floating).
import { useRequestSide } from '../workingTree.ts';
import { TicketsRailButton } from './TicketsLink.tsx';
import { useSessionTint } from '../colours.ts';
import { Fragment, useMemo, type MouseEvent, type ReactNode } from 'react';
import { menuOrder, type MenuItem } from '@kestrel/server/sidebar';
import { Eye, GitPullRequest, LayoutDashboard, Plus, Search, Settings } from 'lucide-react';
import { hasReviewLink } from '@kestrel/server/review-settings';
import { useReviewSettings } from '../reviewSettings.ts';
import { useReviewsToLookAt } from './SidebarReviews.tsx';
import type { SessionView } from '@kestrel/server/model';
import { item } from '@kestrel/server/menu';
import { sidebarHomes } from '@kestrel/server/pinned-homes';
import { orderPinned } from '@kestrel/server/pinned-order';
import { selectsRow } from '@kestrel/server/routes';
import { railSessions, type RailSession } from '@kestrel/server/sidebar-mode';
import { sessionDot } from '@kestrel/server/unread';
import { runMenuAction } from '../commands.ts';
import { opener, openSession, openView, type Route } from '../route.ts';
import { useApp } from '../store.ts';
import { useSessionOrder, useTabs } from '../tabsStore.ts';
import { openRowMenu } from './sidebarMenuTarget.ts';
import { rowDotClass } from './useRowDot.ts';
import { asksForRequest } from '@kestrel/server/row-slot';
import { RowRequest } from './RowRequest.tsx';
import { isTypedText } from '../typed-text.ts';

const DOT_LABEL: Record<RailSession['dot'], string> = { 'needs-you': 'Needs your answer', unread: 'New since you last looked', working: 'Working', none: '' };

/** The sessions the rail lists, in PINNED's order and then newest first (shared/sidebar-mode.ts). */
function useRailSessions(): RailSession[] {
  const workspace = useApp((s) => s.workspace);
  const byId = useApp((s) => s.sessionsById);
  const seen = useApp((s) => s.seen);
  const mode = useSessionOrder();
  return useMemo(() => {
    if (!workspace) return [];
    const dotOf = (session: SessionView): RailSession => ({ id: session.id, dot: sessionDot(session, seen) });
    const pinned = orderPinned(sidebarHomes(workspace).pinned, mode, (id) => byId.get(id))
      .filter((row) => row.kind === 'session')
      .flatMap((row) => (byId.get(row.id) ? [dotOf(byId.get(row.id)!)] : []));
    const newest = [...workspace.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(dotOf);
    return railSessions(pinned, newest);
  }, [workspace, byId, seen, mode]);
}

/** What a rail button asks about before its session has loaded: nothing. */
const NO_SESSION = { id: '', title: '', worktreePath: null, branch: null, worktreeDiscarded: false };

function RailSessionButton({ entry, selected }: { entry: RailSession; selected: boolean }) {
  const session = useApp((s) => s.sessionsById.get(entry.id));
  const tint = useSessionTint(session);
  const side = useRequestSide(session ?? NO_SESSION);
  if (!session) return null;
  // A review says so in words too, as its row's hover card does: its violet initial is not the only sign.
  const tip = [session.review ? 'Code review' : '', session.title, DOT_LABEL[entry.dot]].filter(Boolean).join(' · ');
  const dot = rowDotClass(entry.dot);
  return (
    <button className={`rail-button rail-session${session.review ? ' review-session' : ''}${selected ? ' selected' : ''}${tint.className}`} style={tint.style} aria-label={tip} title={tip} aria-current={selected ? 'page' : undefined} data-menu-kind="session" data-menu-id={session.id} {...opener((newTab) => openSession(session.id, newTab))}>
      <span className="rail-initial" aria-hidden>
        {[...session.title.trim()][0]?.toUpperCase() ?? '·'}
      </span>
      {dot !== 'none' && <span className={`status-dot rail-dot ${dot}`} aria-hidden />}
      {asksForRequest(dot !== 'none', side.branch) && <RowRequest sessionId={session.id} updatedAt={session.updatedAt} className="rail-dot" />}
    </button>
  );
}

export function SidebarRail({ route, activeId, onSwitch }: { route: Route | null; activeId: string | null; onSwitch: () => void }) {
  const sessions = useRailSessions();
  const overview = selectsRow(route?.view ?? null, { kind: 'overview' });
  const requests = selectsRow(route?.view ?? null, { kind: 'pull-requests' });
  const settings = route?.view.kind === 'settings';
  const reviews = selectsRow(route?.view ?? null, { kind: 'code-reviews' });
  const reviewsLink = hasReviewLink(useReviewSettings());
  const newReviews = useReviewsToLookAt();
  // Right-click: the same menu the item's row has in the full sidebar.
  const sidebarPrefs = useTabs((v) => v.sidebar);
  const menu = useMemo(() => menuOrder(sidebarPrefs), [sidebarPrefs]);
  const onContextMenu = (event: MouseEvent) => {
    if (isTypedText(event.target)) return;
    event.preventDefault();
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-menu-kind]');
    if (el) openRowMenu(el.dataset.menuKind, el.dataset.menuId ?? '', { x: event.clientX, y: event.clientY });
  };
  // The same rows as the full sidebar's top menu, in the user's order (`menuOrder`).
  const railRows: Record<MenuItem, ReactNode> = {
    overview: (
      <button className={`rail-button${overview ? ' active' : ''}`} data-menu-kind="overview" aria-label="Overview" aria-current={overview ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'overview' }, newTab))}>
        <LayoutDashboard aria-hidden />
      </button>
    ),
    'new-session': (
      <button className="rail-button" aria-label="New session" title="New session ⌘N" {...opener((newTab) => void runMenuAction(item.newSession().action!, newTab))}>
        <Plus aria-hidden />
      </button>
    ),
    'pull-requests': (
      <button className={`rail-button${requests ? ' active' : ''}`} aria-label="Pull requests" title="Pull requests" aria-current={requests ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'pull-requests' }, newTab))}>
        <GitPullRequest aria-hidden />
      </button>
    ),
    'code-reviews': reviewsLink ? (
      <button className={`rail-button${reviews ? ' active' : ''}`} aria-label={newReviews ? `Code reviews, ${newReviews} to look at` : 'Code reviews'} title={newReviews ? `Code reviews · ${newReviews} to look at` : 'Code reviews'} aria-current={reviews ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'code-reviews' }, newTab))}>
        <Eye aria-hidden />
        {newReviews > 0 && <span className="status-dot rail-dot green" aria-hidden />}
      </button>
    ) : null,
    tickets: <TicketsRailButton active={route?.view.kind === 'tickets' || route?.view.kind === 'ticket'} />,
  };
  return (
    <aside className="sidebar-rail-bar" aria-label="Sidebar" onContextMenu={onContextMenu}>
      <div className="rail-top">
        {menu.map((id) => (
          <Fragment key={id}>{railRows[id]}</Fragment>
        ))}
        <button className="rail-button" aria-label="Search" title="Search ⌘K" onClick={onSwitch}>
          <Search aria-hidden />
        </button>
      </div>
      {sessions.length > 0 && (
        <nav className="rail-sessions" aria-label="Pinned and waiting sessions">
          {sessions.map((entry) => (
            <RailSessionButton key={entry.id} entry={entry} selected={entry.id === activeId} />
          ))}
        </nav>
      )}
      <button className={`rail-button rail-settings${settings ? ' active' : ''}`} aria-label="Settings" aria-current={settings ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'settings' }, newTab))}>
        <Settings aria-hidden />
      </button>
    </aside>
  );
}
