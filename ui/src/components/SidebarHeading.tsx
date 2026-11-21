// A sidebar section heading (SESSIONS, PROJECTS, TAGS, PINNED) that folds its section. The fold is
// remembered with the rest of the sidebar (`collapsed`). `add`, when given, is the "+" beside it.
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { MenuItem } from '@kestrel/server/menu';
import { runMenuAction } from '../commands.ts';
import { opener } from '../route.ts';
import { tabActions, useTabs } from '../tabsStore.ts';

export function Heading({ title, id, add, menuKind }: { title: string; id: string; add?: MenuItem; /** The right-click menu this heading has of its own (sidebarMenu), when it has one. */ menuKind?: string }) {
  const open = useTabs((v) => !v.sidebar.collapsed.includes(id));
  return (
    <div className="side-heading" data-menu-kind={menuKind} data-no-menu={add || menuKind ? undefined : true}>
      <button className="heading-toggle" aria-expanded={open} onClick={() => tabActions.toggleCollapsed(id)}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        {title}
      </button>
      {add && (
        <button className="icon-button" aria-label={add.label} title={add.label} {...opener((newTab) => add.action && void runMenuAction(add.action, newTab))}>
          <Plus />
        </button>
      )}
    </div>
  );
}

/** Whether a section is open, for the lists under the headings. */
export const useSectionOpen = (id: string): boolean => useTabs((v) => !v.sidebar.collapsed.includes(id));
