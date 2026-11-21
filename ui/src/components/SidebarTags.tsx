// The sidebar's TAGS section: every tag in use, in the order the user dragged them into (a tag not
// placed yet comes first, then the rest alphabetically). A tag row behaves as a group or project row
// does (SidebarRowParts.tsx): a click on its name folds its list of sessions open or shut, flat,
// most recent first when the sidebar sorts that way (shared/session-order.ts) and otherwise in the
// tag page's order (`tagSessionIds`), with the sidebar's own session rows; its dot is the
// group roll-up over those sessions (`tagDot`); its … and its right-click menu open the tag page.
// Tags are additional, unlike pins: a session listed under a tag stays in its own home too. Tags
// reorder by drag as every sidebar list does; a session dropped on a tag's row gets that tag. Not
// drawn at all while no session has a tag.
import { useMemo, type DragEvent, type ReactNode } from 'react';
import { Tag } from 'lucide-react';
import type { SessionView } from '@kestrel/server/model';
import { arrange } from '@kestrel/server/sidebar';
import { orderSessions } from '@kestrel/server/session-order';
import { tagDot, tagSessionIds } from '@kestrel/server/status';
import { hasTag, sameTag, tagCounts, tagKey, type TagCount } from '@kestrel/server/tags';
import { SESSION_MIME, TAG_MIME } from '../labels.ts';
import type { Route } from '../route.ts';
import { actions } from '../store.ts';
import { tabActions, useSessionOrder, useTabs } from '../tabsStore.ts';
import { Heading, useSectionOpen } from './SidebarHeading.tsx';
import { FoldChevron, foldClick, RowMore, RowOpen } from './SidebarRowParts.tsx';
import { carries, InTag, startDrag, useDragHighlight, useReorderTarget } from './sidebarDrag.ts';
import { rollupLabel, rowDotClass } from './useRowDot.ts';

const NO_ORDER: readonly string[] = [];

/** A session row dropped on a tag's row gets the tag (unless it has it already). */
function useTagDrop(tag: string, sessions: readonly SessionView[]) {
  const [over, setOver] = useDragHighlight(false);
  const accepts = (event: DragEvent) => carries(event, SESSION_MIME);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setOver(false),
      onDrop: (event: DragEvent) => {
        setOver(false);
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const id = event.dataTransfer.getData(SESSION_MIME);
        const session = sessions.find((s) => s.id === id);
        if (session && !hasTag(session.tags, tag)) void actions.addTag(id, tag);
      },
    },
  };
}

interface TagProps {
  entry: TagCount;
  present: readonly string[];
  active: boolean;
  sessions: readonly SessionView[];
  renderSession: (id: string) => ReactNode;
}

function TagBlock({ entry, present, active, sessions, renderSession }: TagProps) {
  const { tag, count } = entry;
  const key = tagKey(tag);
  const fold = `open:tag:${key}`;
  const open = useTabs((v) => v.sidebar.collapsed.includes(fold));
  const seen = useTabs((v) => v.seen);
  const mode = useSessionOrder();
  const ids = useMemo(() => {
    if (!open) return [];
    const tagged = tagSessionIds(sessions, tag);
    if (mode === 'custom') return tagged;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return orderSessions(tagged.flatMap((id) => byId.get(id) ?? []), mode, null).map((s) => s.id);
  }, [open, sessions, tag, mode]);
  const dot = rowDotClass(useMemo(() => tagDot(sessions, tag, seen), [sessions, tag, seen]));
  const reorder = useReorderTarget(TAG_MIME, (moving, after) => moving !== key && tabActions.placeTag(present, moving, key, after));
  const drop = useTagDrop(tag, sessions);
  return (
    <div className={`tag-block${reorder.edge ? ` drop-${reorder.edge}` : ''}`} {...reorder.props}>
      <div className="fold-row">
        <button
          type="button"
          className={`side-link tag-link${active ? ' active' : ''}${drop.over ? ' drop-over' : ''}`}
          aria-expanded={open}
          title={`${tag} · ${count} session${count === 1 ? '' : 's'}`}
          data-menu-kind="tag"
          data-menu-id={tag}
          draggable
          onDragStart={startDrag(TAG_MIME, key)}
          {...drop.props}
          {...foldClick({ kind: 'tag', id: tag }, () => tabActions.toggleCollapsed(fold))}
        >
          <Tag aria-hidden />
          <span className="fold-label">{tag}</span>
          <FoldChevron open={open} />
          {dot !== 'none' && <span className={`status-dot row-dot ${dot}`} title={rollupLabel(dot)} />}
        </button>
        <RowOpen view={{ kind: 'tag', id: tag }} name={tag} what="tag" />
        <RowMore kind="tag" id={tag} name={tag} />
      </div>
      {open && ids.length > 0 && (
        <InTag.Provider value>
          <ul className="tree flat">{ids.map(renderSession)}</ul>
        </InTag.Provider>
      )}
    </div>
  );
}

export function SidebarTags({ sessions, route, renderSession }: { sessions: readonly SessionView[]; route: Route | null; renderSession: (id: string) => ReactNode }) {
  const order = useTabs((v) => v.sidebar.tagOrder ?? NO_ORDER);
  const counts = useMemo(() => arrange(tagCounts(sessions), (c) => tagKey(c.tag), order), [sessions, order]);
  const open = useSectionOpen('tags');
  if (counts.length === 0) return null;
  const shown = route?.view.kind === 'tag' ? route.view.id : null;
  const present = counts.map((c) => tagKey(c.tag));
  return (
    <>
      <Heading title="TAGS" id="tags" />
      {open && counts.map((entry) => <TagBlock key={entry.tag} entry={entry} present={present} active={shown !== null && sameTag(shown, entry.tag)} sessions={sessions} renderSession={renderSession} />)}
    </>
  );
}
