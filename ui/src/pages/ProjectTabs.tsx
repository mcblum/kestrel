// A project page's local tabs, Sessions and Settings: quiet underlined labels under the header,
// sections of this one project (not workspace tabs). Switching changes the path of the workspace tab
// in front and never opens another one; arrow keys, Home and End move between them. Each tab is left
// at its own scroll position and found there again.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { rememberScroll, scrollFor, tabForKey, type ScrollMemory } from '@kestrel/server/local-tabs';
import { projectSettings, type ProjectTab } from '@kestrel/server/routes';
import { showLocal } from '../route.ts';

const TABS: readonly ProjectTab[] = ['sessions', 'settings'];
const LABEL: Record<ProjectTab, string> = { sessions: 'Sessions', settings: 'Settings' };
export const tabId = (projectId: string, tab: ProjectTab) => `project-${projectId}-${tab}-tab`;
export const panelId = (projectId: string, tab: ProjectTab) => `project-${projectId}-${tab}-panel`;

/** The element the page scrolls in (the project page's main pane). */
const scroller = (el: HTMLElement | null) => el?.closest<HTMLElement>('.pane-main') ?? null;

export function ProjectTabs({ projectId, tab }: { projectId: string; tab: ProjectTab }) {
  const list = useRef<HTMLDivElement>(null);
  const memory = useRef<ScrollMemory>({});
  const shown = useRef(tab);
  shown.current = tab;

  // Where each tab is, kept as the page scrolls: however a tab is left (here, a link, a menu), the
  // position it was left at is known.
  useEffect(() => {
    const box = scroller(list.current);
    if (!box) return;
    const keep = () => (memory.current = rememberScroll(memory.current, shown.current, box.scrollTop));
    box.addEventListener('scroll', keep, { passive: true });
    return () => box.removeEventListener('scroll', keep);
  }, []);

  // A tab shown again is put back where it was left, before it paints.
  useLayoutEffect(() => {
    const box = scroller(list.current);
    if (box) box.scrollTop = scrollFor(memory.current, tab);
  }, [tab]);

  const go = (next: ProjectTab, focus = false) => {
    if (next !== tab) showLocal(next === 'settings' ? projectSettings(projectId) : { kind: 'project', id: projectId });
    if (focus) list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(projectId, next))}`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const next = tabForKey(TABS, tab, event.key);
    if (!next) return;
    event.preventDefault();
    go(next, true);
  };

  return (
    <div className="local-tabs" role="tablist" aria-label="Project" ref={list} onKeyDown={onKeyDown}>
      {TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          id={tabId(projectId, t)}
          aria-selected={t === tab}
          aria-controls={panelId(projectId, t)}
          tabIndex={t === tab ? 0 : -1}
          className={`local-tab${t === tab ? ' selected' : ''}`}
          onClick={() => go(t)}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}

/** One local tab's content. Sessions stays mounted while hidden, so its filters and search live on. */
export function ProjectPanel({ projectId, tab, shown, children }: { projectId: string; tab: ProjectTab; shown: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={panelId(projectId, tab)} aria-labelledby={tabId(projectId, tab)} hidden={!shown} className="local-panel">
      {children}
    </div>
  );
}
