// The sidebar's WORKSTREAMS section: each piece of work that reaches across projects. A workstream
// is drawn as its lead: the session the work was asked in, which brought the others in and answers
// for the whole (shared/workstreams.ts, `workstreamShape`). There is no separate container row and
// no third conversation.
//   - The top row IS the lead session, and behaves as a session row does (Matt, 2026-11-20): its
//     first line is the session's title, it carries the session's pull request and changed-files
//     marks, hovering shows the session's card, a click opens its conversation, a right-click
//     opens the session's menu and a double-click renames the session. Its second line is what
//     makes it a workstream: the workstream's name and how many sessions it delegated to. The
//     chevron folds the sessions under it; folded, the row carries one dot for each kind of state
//     among its sessions (working, then waiting on you, then new), and unfolded the lead's own.
//     The workstream's own things are the two buttons at the row's end: ↗ its page, … its menu
//     (Rename there renames the workstream, on the second line).
//   - Under it, joined by the parent-to-child line, are the sessions the lead started (each with
//     its own), then any other member, most recent activity first at each level. Each is two
//     lines: its title, then its project and status.
//   - Workstream rows reorder by drag. The rows under one are references: each session stays in
//     its own home too. They take no drops and cannot be reordered; dragging one out to a group, a
//     project or PINNED moves the session itself, not the reference.
// Not drawn at all while there is no workstream.
import { useMemo, type ReactNode } from 'react';
import { Waypoints } from 'lucide-react';
import type { TreeNode, WorkspaceState, Workstream } from '@kestrel/server/model';
import { arrange } from '@kestrel/server/sidebar';
import { orderTree } from '@kestrel/server/session-order';
import { workstreamDots } from '@kestrel/server/status';
import { delegatedText, isComplete, workstreamShape, workstreamSummary } from '@kestrel/server/workstreams';
import { WORKSTREAM_MIME } from '../labels.ts';
import { cardTrigger } from '../hoverCardState.ts';
import { opener, openSession, openView, type Route } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { tabActions, useTabs } from '../tabsStore.ts';
import { Heading, useSectionOpen } from './SidebarHeading.tsx';
import { RenameInput } from './SidebarRename.tsx';
import { FoldChevron, RowMore, RowOpen } from './SidebarRowParts.tsx';
import { RowIcons } from './RowIcons.tsx';
import { InTag, InWorkstream, startDrag, useReorderTarget } from './sidebarDrag.ts';
import { rollupLabel, rowDotClass } from './useRowDot.ts';

const NO_ORDER: readonly string[] = [];
/** A workstream is open until folded: its fold key is in `collapsed` while it is shut, as a group's is. */
const foldKey = (id: string) => `workstream:${id}`;
/** What `renaming` holds while the lead session is renamed in the workstream's row; its own row elsewhere uses the session's id. */
const leadRename = (sessionId: string) => `workstream-lead:${sessionId}`;

interface BlockProps {
  workstream: Workstream;
  present: readonly string[];
  /** The workstream's page is the open page. */
  onPage: boolean;
  activeId: string | null;
  workspace: WorkspaceState;
  renderNode: (node: TreeNode) => ReactNode;
}

function WorkstreamBlock({ workstream, present, onPage, activeId, workspace, renderNode }: BlockProps) {
  const { id, name, sessionIds } = workstream;
  const open = useTabs((v) => !v.sidebar.collapsed.includes(foldKey(id)));
  const seen = useTabs((v) => v.seen);
  const renaming = useApp((s) => s.renaming === id);
  const byId = useApp((s) => s.sessionsById);
  // The lead, and under it the sessions it brought in, most recent activity first at each level.
  const shape = useMemo(() => workstreamShape(workstream, workspace.links), [workstream, workspace.links]);
  const renamingLead = useApp((s) => shape.leadId !== null && s.renaming === leadRename(shape.leadId));
  const under = useMemo(() => (open ? orderTree(shape.under, (sessionId) => byId.get(sessionId), 'recent', NO_ORDER) : []), [open, shape, byId]);
  const lead = shape.leadId ? byId.get(shape.leadId) : undefined;
  const viaReference = useApp((s) => lead !== undefined && s.openedFromReference === lead.id);
  // Folded, one dot per kind of state among its sessions; unfolded, the lead's alone (status.ts, `workstreamDots`).
  const dots = useMemo(() => workstreamDots(workspace.sessions, sessionIds, shape.leadId, !open, seen).map(rowDotClass), [workspace.sessions, sessionIds, shape.leadId, open, seen]);
  const summary = useMemo(() => workstreamSummary(sessionIds.flatMap((sessionId) => byId.get(sessionId) ?? [])), [sessionIds, byId]);
  const delegated = delegatedText(lead ? sessionIds.length - 1 : sessionIds.length);
  const reorder = useReorderTarget(WORKSTREAM_MIME, (moving, after) => moving !== id && tabActions.placeWorkstream(present, moving, id, after));
  // The row stands for the lead's conversation: it is the highlighted row when that was opened from
  // here (or the workstream's page is open), and only marks it as open when it was opened elsewhere.
  const leadOpen = lead !== undefined && activeId === lead.id;
  const state = onPage || (leadOpen && viaReference) ? ' active' : leadOpen ? ' open-elsewhere' : '';
  const toggle = () => tabActions.toggleCollapsed(foldKey(id));
  const openLead = (newTab: boolean) => {
    if (!lead) return openView({ kind: 'workstream', id }, newTab);
    actions.openedFrom(lead.id, true);
    openSession(lead.id, newTab);
  };
  return (
    <div className={`tag-block workstream-block${reorder.edge ? ` drop-${reorder.edge}` : ''}`} {...reorder.props}>
      <div className="fold-row">
        <button
          type="button"
          className={`side-link tag-link workstream-link${state}`}
          // A right-click is the session's menu, as on any session row; the … is the workstream's.
          data-menu-kind={lead ? 'session' : 'workstream'}
          data-menu-id={lead ? lead.id : id}
          draggable={!renaming && !renamingLead}
          onDragStart={startDrag(WORKSTREAM_MIME, id)}
          {...opener(openLead)}
          onDoubleClick={() => actions.startRename(lead ? leadRename(lead.id) : id)}
          {...(lead && !renaming && !renamingLead ? cardTrigger({ kind: 'session', id: lead.id, lineage: { text: `Leads the workstream ${name} · ${summary}` } }) : {})}
          aria-description={`Leads the workstream ${name}: ${summary}`}
        >
          <Waypoints aria-hidden />
          <span className="fold-label workstream-label">
            <span className="tree-main">
              {lead && renamingLead ? <RenameInput label="Session name" value={lead.title} onDone={(next) => next !== lead.title && void actions.renameSession(lead.id, next)} /> : lead ? lead.title : name}
            </span>
            <span className="tree-where">
              {renaming ? (
                <RenameInput label="Workstream name" value={name} onDone={(next) => next !== name && void actions.renameWorkstream(id, next)} />
              ) : (
                <>
                  {/* First, so a narrow sidebar that cuts the line still says it. */}
                  {isComplete(workstream) && 'Complete · '}
                  {lead ? `${name} · ${delegated}` : delegated}
                </>
              )}
            </span>
          </span>
          {/* The chevron is the fold; the row itself opens the lead's conversation. A span, since a button cannot hold a button. */}
          <span
            className="fold-toggle"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the sessions of ${name}`}
            onClick={(event) => (event.stopPropagation(), toggle())}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), event.stopPropagation(), toggle())}
          >
            <FoldChevron open={open} />
          </span>
          {dots.length > 0 && (
            <span className="row-dots row-dot">
              {dots.map((dot) => (
                <span key={dot} className={`status-dot ${dot}`} title={open ? undefined : rollupLabel(dot)} />
              ))}
            </span>
          )}
          {/* The lead's own pull request and changed files, as on its row anywhere else. */}
          {lead && <RowIcons session={lead} hasDot={dots.length > 0} />}
        </button>
        <RowOpen view={{ kind: 'workstream', id }} name={name} what="workstream" />
        <RowMore kind="workstream" id={id} name={name} />
      </div>
      {open && under.length > 0 && (
        <InTag.Provider value>
          <InWorkstream.Provider value>
            <ul className="tree tree-children">{under.map(renderNode)}</ul>
          </InWorkstream.Provider>
        </InTag.Provider>
      )}
    </div>
  );
}

export function SidebarWorkstreams({ workspace, route, activeId, renderNode }: { workspace: WorkspaceState; route: Route | null; activeId: string | null; renderNode: (node: TreeNode) => ReactNode }) {
  const order = useTabs((v) => v.sidebar.workstreamOrder ?? NO_ORDER);
  const workstreams = useMemo(() => arrange(workspace.workstreams, (w) => w.id, order), [workspace.workstreams, order]);
  const open = useSectionOpen('workstreams');
  if (workstreams.length === 0) return null;
  const shown = route?.view.kind === 'workstream' ? route.view.id : null;
  const present = workstreams.map((w) => w.id);
  return (
    <>
      <Heading title="WORKSTREAMS" id="workstreams" />
      {open && workstreams.map((w) => <WorkstreamBlock key={w.id} workstream={w} present={present} onPage={shown === w.id} activeId={activeId} workspace={workspace} renderNode={renderNode} />)}
    </>
  );
}
