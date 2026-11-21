// The full sidebar opened over the content from the rail (the toggle or ⌘B in a narrow window).
// It wraps the one Sidebar component; nothing here draws rows. It sits inside the window at the
// left, closes on Escape, on a press outside it and once the user has gone somewhere from it (the
// tab in front shows something else), takes keyboard focus when it opens and gives it back to the
// sidebar toggle when it closes.
import { useEffect, useRef, type ReactNode } from 'react';
import { setSidebarFloating } from '../sidebarRail.ts';
import { activeTab, useTabs } from '../tabsStore.ts';
import { escapeBelongsElsewhere } from './PaneArea.tsx';

/** Presses on these are not "outside": the toggle toggles it, and menus and cards opened from it belong to it. */
const PART_OF_IT = '.sidebar-toggle, .context-menu-host, .context-menu, .project-card, .picker-pop';
const FOCUSABLE = 'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])';

/** What the tab in front shows; when it changes while the sidebar floats, the user went somewhere. */
const destination = (v: Parameters<typeof activeTab>[0]): string => {
  const tab = activeTab(v);
  return `${tab.id}:${tab.kind === 'session' ? tab.sessionId : tab.kind === 'page' ? tab.path : 'new'}`;
};

export function SidebarFloat({ width, children }: { width: number; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const shownAt = useTabs(destination);
  const openedAt = useRef(shownAt);

  // Gone somewhere from it: close.
  useEffect(() => {
    if (shownAt !== openedAt.current) setSidebarFloating(false);
  }, [shownAt]);

  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeBelongsElsewhere(event)) return;
      event.preventDefault();
      setSidebarFloating(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && !root.contains(target) && !target.closest(PART_OF_IT)) setSidebarFloating(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      // Focus goes back to the toggle unless the user already put it somewhere else (a press outside).
      const active = document.activeElement;
      if (!active || active === document.body || root.contains(active)) document.querySelector<HTMLElement>('.sidebar-toggle')?.focus();
    };
  }, []);

  return (
    <div ref={panel} className="sidebar-float" style={{ width }}>
      {children}
    </div>
  );
}
