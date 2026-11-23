import { memo, useEffect, useRef, useState, type DragEvent } from 'react';
import { Code, Eye, Waypoints, GitPullRequest, LayoutDashboard, Plus, Tag, X, Ticket } from 'lucide-react';
import type { Tab } from '@kestrel/server/tabs';
import { openNewSession } from '../commands.ts';
import { useRowDot } from './useRowDot.ts';
import { drafts, useApp } from '../store.ts';
import { isOnlyTab } from '@kestrel/server/tabs';
import { tabActions, useTabs } from '../tabsStore.ts';
import { tabRoute } from '../route.ts';
import { viewTitle } from '../pages/viewTitle.ts';
import { tabMenuRow } from '@kestrel/server/tab-menu';
import { openRowMenu } from './sidebarMenuTarget.ts';

const TAB_MIME = 'application/x-kestrel-tab';

const TabButton = memo(function TabButton({ tab, index, active, pinned }: { tab: Tab; index: number; active: boolean; /** The only tab left: it has no close button. */ pinned: boolean }) {
  const session = useApp((s) => (tab.kind === 'session' ? s.sessionsById.get(tab.sessionId) : undefined));
  const [over, setOver] = useState(false);
  const route = tabRoute(tab);
  const workspace = useApp((s) => (route ? s.workspace : null));
  const title = route ? viewTitle(route.view, workspace) : tab.kind === 'new' ? 'New session' : (session?.title ?? 'Session');
  const row = useRowDot(session);
  // Nothing new to read: a faint ring holds the dot's place, so the title never shifts.
  const dot = row.className === 'none' ? { className: 'read', label: 'Nothing new' } : row;
  const unsent = tab.kind === 'new' && drafts.get(`tab:${tab.id}`).trim() !== '';
  // The tab in front is always reachable: brought into view when it becomes active.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(TAB_MIME, tab.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const accepts = (e: DragEvent) => !pinned && e.dataTransfer.types.includes(TAB_MIME);

  return (
    <div
      ref={ref}
      className={`tab${active ? ' active' : ''}${over ? ' drop-over' : ''}${pinned ? ' pinned' : ''}`}
      role="tab"
      aria-selected={active}
      draggable={!pinned}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(TAB_MIME);
        if (id && accepts(e)) (e.preventDefault(), tabActions.move(id, index));
      }}
      onMouseDown={(e) => e.button === 1 && !pinned && (e.preventDefault(), tabActions.close(tab.id))}
      // A right-click opens the menu of what the tab holds, the same as its sidebar row's (shared/tab-menu.ts).
      onContextMenu={(e) => {
        const row = tabMenuRow(tab, route?.view ?? null);
        if (!row) return;
        e.preventDefault();
        openRowMenu(row.kind, row.id, { x: e.clientX, y: e.clientY });
      }}
    >
      <button className="tab-main" tabIndex={active ? 0 : -1} onClick={() => tabActions.activate(tab.id)} title={title}>
        {route ? route.view.kind === 'tag' ? <Tag aria-hidden /> : route.view.kind === 'workstream' ? <Waypoints aria-hidden /> : route.view.kind === 'pull-requests' ? <GitPullRequest aria-hidden /> : route.view.kind === 'code-reviews' || route.view.kind === 'review-request' ? <Eye aria-hidden /> : route.view.kind === 'tickets' || route.view.kind === 'ticket' ? <Ticket aria-hidden /> : route.view.kind === 'code' ? <Code aria-hidden /> : <LayoutDashboard aria-hidden /> : tab.kind === 'new' ? <Plus aria-hidden /> : <span className={`status-dot ${dot.className}`} aria-label={dot.label || undefined} />}
        <span className="tab-title">{title}</span>
        {unsent && <span className="tab-unsent" title="Unsent message" />}
      </button>
      {!pinned && (
        <button className="tab-close" aria-label={`Close ${title}`} onClick={() => tabActions.close(tab.id)}>
          <X aria-hidden />
        </button>
      )}
    </div>
  );
});

export function TabStrip() {
  const tabs = useTabs((v) => v.state.tabs);
  const activeId = useTabs((v) => v.state.activeId);
  const onlyTab = useTabs((v) => isOnlyTab(v.state));
  return (
    <div className="tab-strip">
      <div className="tab-scroll" role="tablist" aria-label="Open tabs">
        {tabs.map((tab, i) => (
          <TabButton key={tab.id} tab={tab} index={i} active={tab.id === activeId} pinned={onlyTab} />
        ))}
      </div>
      <button className="tab-new" aria-label="New session" title="New session in a new tab (⌘ T)" onClick={() => openNewSession({}, true)}>
        <Plus aria-hidden />
      </button>
    </div>
  );
}
