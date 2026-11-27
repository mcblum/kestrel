import { bindingFor, formatBinding } from '@kestrel/server/shortcuts';
import { TicketsLink } from './TicketsLink.tsx';
import { isMac, useShortcuts } from '../shortcuts.ts';
import { memo, createContext, useContext, useMemo, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { setupLeftText, useSetupLeft } from '../setupList.ts';
import { Settings, Folder, FolderOpen, FolderX, GitPullRequest, LayoutDashboard, Search, Plus } from 'lucide-react';
import type { Group, Project, SessionView, TreeNode, WorkspaceState } from '@kestrel/server/model';
import { emptyListKind, nestedIds, projectRowIds, sidebarHomes, type PinnedRow, type SidebarHomes } from '@kestrel/server/pinned-homes';
import { EmptyList, RowPlus } from './SidebarCreate.tsx';
import { SidebarWorkstreams } from './SidebarWorkstreams.tsx';
import { RenameInput } from './SidebarRename.tsx';
import { SIDEBAR_WIDTH, arrange, menuOrder, type MenuItem } from '@kestrel/server/sidebar';
import { activityAt, orderSessions, orderTree } from '@kestrel/server/session-order';
import { foldRows } from '@kestrel/server/sidebar-fold';
import { orderPinned } from '@kestrel/server/pinned-order';
import { activeHome, treeContains } from '@kestrel/server/active-home';
import { summaryDot } from '@kestrel/server/unread';
import { dotFor, rollupLabel, rowDotClass, useRowDot } from './useRowDot.ts';
import { offersArchive } from '@kestrel/server/row-slot';
import { RowIcons } from './RowIcons.tsx';
import { useMachineName } from '../machines.ts';
import '../styles/machines.css';
import '../styles/away-projects.css';
import { RowArchive } from './RowArchive.tsx';
import { dropGroup, dropProject, dropSession, draggedGroupProject, draggedSessionIsHere, joinGroup, unpinIfPinned } from './sidebarDrops.ts';
import { carries, draggingId, InPinned, InReviews, InTag, InWorkstream, lowerHalf, startDrag, useDragHighlight, useReorderTarget, type Edge } from './sidebarDrag.ts';
import { item } from '@kestrel/server/menu';
import { runMenuAction } from '../commands.ts';
import { StatusArea } from './StatusArea.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';
import { Heading } from './SidebarHeading.tsx';
import { SidebarTags } from './SidebarTags.tsx';
import { SidebarPins } from './SidebarPins.tsx';
import { SidebarTickets } from './SidebarTickets.tsx';
import { hasTicketSection, ticketsOn } from '@kestrel/server/tickets';
import { ticketLeadIn } from '../tickets.ts';
import { ReviewRequestRow, ReviewsLink, SidebarReviews } from './SidebarReviews.tsx';
import { openedText, requestNumberLabel, reviewingIds, reviewRowDetail, type ReviewMark } from '@kestrel/server/review-requests';
import { OthersSaidNote } from './OthersSaid.tsx';
import { hasReviewLink, hasReviewSection } from '@kestrel/server/review-settings';
import { useReviewSettings } from '../reviewSettings.ts';
import { useMinuteNow } from '../useNow.ts';
import { cardTrigger } from '../hoverCardState.ts';
import { cameFromText } from '@kestrel/server/session-card';
import { HoverCardHost } from './HoverCard.tsx';
import { FoldChevron, foldClick, RowMore, RowOpen } from './SidebarRowParts.tsx';
import { openRowMenu } from './sidebarMenuTarget.ts';
import { filingMark, GROUP_MIME, MENU_MIME, projectName, PROJECT_MIME, SESSION_MIME, statusText, UNSCOPED } from '../labels.ts';
import { opener, openSession, openView, type Route, type View } from '../route.ts';
import { selectsRow } from '@kestrel/server/routes';
import { useProjectTint, useSessionTint } from '../colours.ts';
import { actions, appStore, useApp } from '../store.ts';
import { notHere } from '../awayProjects.ts';
import { tabActions, useSessionOrder, useTabs } from '../tabsStore.ts';
import { isTypedText } from '../typed-text.ts';

const UNGROUPED = 'ungrouped';
const InProject = createContext(false);

/** The open page selects this row (a project's folders page selects the project): routes.ts. */
const isView = (route: Route | null, view: View) => selectsRow(route?.view ?? null, view);

// ---- one session row, and its children ----------------------------------------------

/** A list's session lookup for ordering (shared/session-order.ts). */
const useLookup = () => {
  const byId = useApp((s) => s.sessionsById);
  return useMemo(() => (id: string) => byId.get(id), [byId]);
};

/** Everything a session row no longer shows, for screen readers (the hover card shows it on screen). */
function sessionTip(session: SessionView, projects: readonly Project[], dotLabel: string, lineage: string | null): string {
  const project = projectName(session, projects);
  const mark = filingMark(session.filing.status, session.filing.discarded);
  const state = statusText(session);
  return [
    ...(session.review ? ['Code review'] : []),
    session.title,
    project === UNSCOPED ? 'No project' : project,
    dotLabel && dotLabel !== state ? `${state} · ${dotLabel}` : state,
    ...(mark ? [mark.label[0]!.toUpperCase() + mark.label.slice(1)] : []),
    ...(lineage ? [lineage] : []),
  ].join(' · ');
}

/** A review session's second line: its request's project (or repository), number, who asked and what other reviewers said; the number alone once the request is no longer listed. */
function ReviewWhere({ review, fallback, inProject }: { review: ReviewMark; fallback: string; /** Under its own project: the project is not named again. */ inProject: boolean }) {
  const request = useApp((s) => s.reviewRequests.requests.find((r) => r.key === review.key));
  const project = useApp((s) => (request?.projectId ? s.workspace?.projects.find((p) => p.id === request.projectId)?.name : undefined));
  const now = useMinuteNow();
  // With how long ago the request was opened, as its request row had.
  if (!request) return <>{inProject ? requestNumberLabel(review) : `${fallback} ${requestNumberLabel(review)}`}</>;
  // With what other reviewers said, as its request row had.
  return (
    <>
      {[reviewRowDetail(request, project, { place: !inProject }), openedText(request, now)].filter(Boolean).join(' · ')}
      <OthersSaidNote request={request} className="review-said" />
    </>
  );
}

const TreeRow = memo(function TreeRow({ node, depth, activeId, rootId, groupId, parentId }: { node: TreeNode; depth: number; activeId: string | null; /** The top session of this row's tree. */ rootId: string; /** The group this row is listed in; `undefined` in a project's list, where a drop only reorders. */ groupId: string | null | undefined; /** The row this one is drawn under, if any. */ parentId?: string }) {
  const [edge, setEdge] = useDragHighlight<Edge>(null);
  const session = useApp((s) => s.sessionsById.get(node.sessionId));
  const projects = useApp((s) => s.workspace?.projects);
  const relatedId = node.movedFrom ?? (node.via ? parentId : undefined);
  const relatedTitle = useApp((s) => (relatedId ? s.sessionsById.get(relatedId)?.title : undefined));
  const dot = useRowDot(session);
  const machine = useMachineName(session?.runsOn);
  const renaming = useApp((s) => s.renaming === node.sessionId);
  const inPinned = useContext(InPinned);
  const inProject = useContext(InProject);
  const inTag = useContext(InTag);
  const inReviews = useContext(InReviews);
  const inWorkstream = useContext(InWorkstream);
  // One row is the highlighted one: the row the session was opened from. Under a workstream or a
  // tag a row is a reference; the session's own row is the highlighted one unless a reference was
  // used to open it, and the other only marks that the session is open.
  const reference = inTag || inWorkstream;
  const viaReference = useApp((s) => s.openedFromReference === node.sessionId);
  // Sorted by most recent, rows show no place to drop between them: a session drag passes on to
  // the list around them, which moves it there if it came from elsewhere.
  const reorders = useSessionOrder() === 'custom';
  // A coloured tag or group colours the title, over the review colour (Settings → Colours; colours.ts).
  const tint = useSessionTint(session);
  if (!session || !projects) return null;
  const isOpen = activeId === session.id;
  const primary = isOpen && (reference ? viaReference : !viaReference);
  const delegates = node.children.filter((c) => c.via === 'delegate').length;
  const lineage = relatedTitle
    ? cameFromText(node.via === 'delegate' && !node.movedFrom ? 'delegate' : 'handoff', relatedTitle)
    : delegates > 0
      ? `Delegated to ${delegates} session${delegates === 1 ? '' : 's'}`
      : null;
  // A top-level row of the Sessions list also takes a group dropped beside it; elsewhere a group
  // drag passes on to the group block or the list around it.
  const takesGroup = groupId === null;
  const accepts = (event: DragEvent) => reorders && !inPinned && !inTag && !inReviews && (carries(event, SESSION_MIME) || (takesGroup && carries(event, GROUP_MIME)));
  return (
    // --depth sets the row's inset (--side-label-x plus one --side-indent per level) and where the
    // line from its parent is drawn (sidebar-rhythm.css). The row's button inherits it.
    <li style={{ '--depth': depth } as CSSProperties}>
      {/* The row's button, with its Archive button laid over its right end on hover (sidebar-rows.css). */}
      <div className="tree-row-box">
        <button
          className={`tree-row${session.review ? ' review-session' : ''}${session.review && !inWorkstream ? ' review-row' : ''}${isOpen ? (primary ? ' selected' : ' open-elsewhere') : ''}${inWorkstream ? ' reference' : ''}${session.filing.status === 'hidden' ? ' dimmed' : ''}${edge ? ` drop-${edge}` : ''}${tint.className}`}
          style={tint.style}
          draggable={!renaming}
          onDragStart={startDrag(SESSION_MIME, session.id)}
          onDragOver={(event) => {
            if (!accepts(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setEdge(lowerHalf(event) ? 'after' : 'before');
          }}
          onDragLeave={() => setEdge(null)}
          onDrop={(event) => {
            setEdge(null);
            if (!accepts(event)) return;
            event.preventDefault();
            event.stopPropagation();
            const group = takesGroup ? event.dataTransfer.getData(GROUP_MIME) : '';
            if (group) return void dropGroup(group, rootId, lowerHalf(event));
            const id = event.dataTransfer.getData(SESSION_MIME);
            if (id) void dropSession(id, rootId, groupId, lowerHalf(event));
          }}
          data-menu-kind="session"
          data-menu-id={session.id}
          {...opener((newTab) => (actions.openedFrom(session.id, reference), openSession(session.id, newTab)))}
          // A double-click renames, as on every row that has a name of its own. A reference row
          // (under a workstream or a tag) is renamed in the session's own row, not here.
          onDoubleClick={reference ? undefined : () => actions.startRename(session.id)}
          {...(renaming ? {} : cardTrigger({ kind: 'session', id: session.id, lineage: lineage ? { text: lineage, sessionId: relatedTitle ? relatedId : undefined } : null }))}
          aria-description={sessionTip(session, projects, dot.label, delegates > 0 && !relatedTitle ? `${lineage}; drag to move them together` : lineage)}
        >
          {renaming && !reference ? (
            <span className="tree-title">
              <RenameInput label="Session name" value={session.title} onDone={(name) => name !== session.title && void actions.renameSession(session.id, name)} />
            </span>
          ) : (
            <span className="tree-title">
              {/* A reference under a workstream is two lines: what it is, then, quieter, its project and status. */}
              {inWorkstream ? (
                <>
                  <span className="tree-main">{session.title}</span>
                  <span className="tree-where">
                    {projectName(session, projects)} · {statusText(session)}
                  </span>
                </>
              ) : session.review ? (
                // A review also says which request and who asked; outside its project, where too.
                <>
                  <span className="tree-main">{session.title}</span>
                  <span className="tree-where">
                    <ReviewWhere review={session.review} fallback={projectName(session, projects)} inProject={inProject} />
                  </span>
                </>
              ) : (
                session.title
              )}
            </span>
          )}
          {machine && <span className="row-machine" title={`Runs on ${machine}`}>{machine}</span>}
          {dot.className !== 'none' && <span className={`status-dot row-dot ${dot.className}`} aria-label={dot.label || undefined} title={dot.label || undefined} />}
          {/* A review always says where it stands: with nothing new and nothing waiting, a quiet ring with its status. */}
          {dot.className === 'none' && session.review && !inWorkstream ? <span className="status-dot row-dot idle" role="img" aria-label={statusText(session)} title={statusText(session)} /> : <RowIcons session={session} hasDot={dot.className !== 'none'} />}
        </button>
        {offersArchive(session.state, renaming) && <RowArchive sessionId={session.id} title={session.title} />}
      </div>
      {node.children.length > 0 && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeRow key={child.sessionId} node={child} depth={depth + 1} activeId={activeId} rootId={rootId} groupId={groupId} parentId={session.id} />
          ))}
        </ul>
      )}
    </li>
  );
});

/** A session drawn on its own, without what hangs under it (a project's list, a tag's). */
const flatNode = (sessionId: string): TreeNode => ({ sessionId, via: null, movedFrom: null, children: [] });
/** A row of a project's list: the session, with the same-project sessions it delegated to under it. */
const projectNode = (sessionId: string, homes: SidebarHomes): TreeNode => ({ ...flatNode(sessionId), children: homes.nestedInProject.get(sessionId) ?? [] });

function countNodes(nodes: readonly TreeNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

/** A drop target for dragged sessions. Returns the props to spread and whether a drag is over it. */
function useDrop(groupId: string) {
  const [over, setOver] = useDragHighlight(false);
  const recent = useSessionOrder() === 'recent';
  // Sorted by most recent, a member dragged within its own group goes nowhere: the drag stops here,
  // so the list around the group does not take it either.
  const ownMember = (event: DragEvent) => recent && carries(event, SESSION_MIME) && draggedSessionIsHere((s) => s.groupId === groupId);
  const accepts = (event: DragEvent) => carries(event, SESSION_MIME) && !ownMember(event);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (ownMember(event)) event.stopPropagation();
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        const id = event.dataTransfer.getData(SESSION_MIME);
        setOver(false);
        if (ownMember(event)) event.stopPropagation();
        if (!id || !accepts(event)) return;
        event.preventDefault();
        unpinIfPinned('session', id);
        void joinGroup(id, groupId);
      },
    },
  };
}

// ---- a folder (group) with its tree ----------------------------------------------------

/**
 * A group and its tree. Folded, it still shows the open session if that is in it, alone below its
 * row. `only`: drawn folded with just that session, whatever its own fold (a folded section or
 * project that holds the open session keeps the group's row: active-home.ts).
 */
const FolderBlock = memo(function FolderBlock({ group, tree, route, activeId, only }: { group: Group; tree: readonly TreeNode[]; route: Route | null; activeId: string | null; only?: string }) {
  const unfolded = useTabs((v) => !v.sidebar.collapsed.includes(group.id));
  const open = unfolded && !only;
  const kept = only ?? (!open && activeId && treeContains(tree, activeId) ? activeId : null);
  const setOpen = (_next: boolean) => tabActions.toggleCollapsed(group.id);
  const [before, setBefore] = useDragHighlight(false);
  // The top edge of a group's row means "put it above this group", not "into it".
  const nearTop = (event: DragEvent) => event.clientY < event.currentTarget.getBoundingClientRect().top + 7;
  const renaming = useApp((s) => s.renaming === group.id);
  const setRenaming = (on: boolean) => actions.startRename(on ? group.id : null);
  const drop = useDrop(group.id);
  // Sorted by most recent, sessions are not placed among groups: the whole row drops into the group.
  // A project's group is not in the Sessions list: there is no place above it to drop into.
  const placesAbove = useSessionOrder() === 'custom' && !group.projectId;
  // Another group dragged here lands above or below this one, never inside it.
  const reorder = useReorderTarget(GROUP_MIME, (id, after) => void dropGroup(id, group.id, after, group.projectId ?? null));
  const container = { groupId: group.id, ...(group.projectId ? { projectId: group.projectId } : {}) };
  // Under PINNED the pinned row around this block takes every drop.
  const takesDrops = !useContext(InPinned);
  const view: View = { kind: 'group', id: group.id };
  // The rows drawn here; sessions pinned on their own are drawn under PINNED instead.
  const count = countNodes(tree);
  const members = useApp((st) => st.workspace?.sessions.filter((x) => x.groupId === group.id).length ?? count);
  const pinnedAway = members - count;
  // A group shows yellow or green when any session in it does, however deep in its tree.
  const seen = useApp((s) => s.seen);
  const sessionsById = useApp((st) => st.sessionsById);
  const dot = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: readonly TreeNode[]) => nodes.forEach((n) => (ids.push(n.sessionId), walk(n.children)));
    walk(tree);
    return rowDotClass(summaryDot(ids.flatMap((id) => (sessionsById.get(id) ? [dotFor(sessionsById.get(id)!, seen)] : []))));
  }, [tree, sessionsById, seen]);
  const Icon = open ? FolderOpen : Folder;
  const tip = [
    group.name,
    `${count} session${count === 1 ? '' : 's'}`,
    ...(pinnedAway > 0 ? [`${pinnedAway} more pinned`] : []),
    ...(group.auto ? ['Made when a session split its work across projects'] : []),
  ].join(' · ');

  const commitRename = (value: string) => {
    setRenaming(false);
    if (value.trim() && value.trim() !== group.name) void actions.renameGroup(group.id, value);
  };

  return (
    <div
      className={`folder-block${drop.over ? ' drop-over' : ''}${reorder.edge ? ` drop-${reorder.edge}` : ''}`}
      onDragOver={(event) => takesDrops && (reorder.props.onDragOver(event), drop.props.onDragOver(event))}
      onDragLeave={(event) => takesDrops && (reorder.props.onDragLeave(event), drop.props.onDragLeave(event))}
      onDrop={(event) => takesDrops && (reorder.props.onDrop(event), drop.props.onDrop(event))}
    >
      <div
        className={`side-link folder-row${isView(route, view) ? ' active' : ''}${before ? ' drop-before' : ''}`}
        data-menu-kind="folder"
        data-menu-id={group.id}
        draggable={!renaming}
        onDragStart={startDrag(GROUP_MIME, group.id)}
        onDragOver={(event) => setBefore(placesAbove && takesDrops && carries(event, SESSION_MIME) && nearTop(event))}
        onDragLeave={() => setBefore(false)}
        onDrop={(event) => {
          setBefore(false);
          if (!takesDrops || !placesAbove) return;
          const id = event.dataTransfer.getData(SESSION_MIME);
          if (!id || !nearTop(event)) return; // anywhere else on the row drops into the group
          event.preventDefault();
          event.stopPropagation();
          void dropSession(id, group.id, null, false);
        }}
      >
        {renaming ? (
          // The icon and the chevron stay and the box takes the name's place, so nothing in the row moves.
          <span className="folder-name renaming">
            <Icon aria-hidden />
            <input
              className="inline-input"
              defaultValue={group.name}
              autoFocus
              aria-label="Group name"
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') commitRename(e.currentTarget.value);
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
            <FoldChevron open={open} />
          </span>
        ) : (
          <button
            className="folder-name"
            aria-expanded={open}
            title={tip}
            {...foldClick(view, () => setOpen(!open))}
            onDoubleClick={() => setRenaming(true)}
          >
            <Icon aria-hidden />
            <span>{group.name}</span>
            <FoldChevron open={open} />
          </button>
        )}
        {!renaming && (
          <span className="folder-actions">
            <RowOpen view={view} name={group.name} what="group" />
            <RowMore kind="folder" id={group.id} name={group.name} />
            <RowPlus container={container} name={group.name} />
          </span>
        )}
        {dot !== 'none' && <span className={`status-dot row-dot ${dot}`} title={rollupLabel(dot)} />}
      </div>
      {!open && kept && (
        <ul className="tree">
          <TreeRow node={flatNode(kept)} depth={0} activeId={activeId} rootId={kept} groupId={group.id} />
        </ul>
      )}
      {open &&
        (tree.length > 0 ? (
          <ul className="tree">
            {tree.map((node) => (
              <TreeRow key={node.sessionId} node={node} depth={0} activeId={activeId} rootId={node.sessionId} groupId={group.id} />
            ))}
          </ul>
        ) : (
          // An empty group shows nothing under it (its + on hover starts a session there); one whose
          // sessions are all pinned still says so.
          <EmptyList kind={emptyListKind(members, count) === 'all-pinned' ? 'all-pinned' : null} container={container} />
        ))}
    </div>
  );
});

type ListItem = { id: string; group: Group; node: null } | { id: string; group: null; node: TreeNode };

/** Whether the SESSIONS section has anything to draw: a group in the Sessions list that is not pinned, or a session at home there. */
const hasSessionsSection = (workspace: WorkspaceState, homes: SidebarHomes): boolean => (homes.trees.ungrouped ?? []).length > 0 || workspace.groups.some((g) => !g.projectId && !homes.pinnedGroups.has(g.id));

/**
 * The Sessions list: groups and ungrouped sessions. Custom order: together, in the order the user
 * left them. Most recent: the sessions newest first, then the groups in the user's order.
 */
function SessionList({ workspace, homes, route, activeId }: { workspace: WorkspaceState; homes: SidebarHomes; route: Route | null; activeId: string | null }) {
  const order = useTabs((v) => v.sidebar.order);
  const mode = useSessionOrder();
  const lookup = useLookup();
  const [over, setOver] = useDragHighlight(false);
  const items = useMemo((): ListItem[] => {
    // A pinned group is drawn under PINNED, not here. The ungrouped tree holds only what is drawn
    // here: pinned sessions and those at home in a project's list are already cut out (sidebarHomes).
    // A project's groups are drawn in that project's list.
    const groups = workspace.groups.filter((g) => !g.projectId && !homes.pinnedGroups.has(g.id)).map((group): ListItem => ({ id: group.id, group, node: null }));
    const nodes = homes.trees[UNGROUPED] ?? [];
    if (mode === 'custom') return arrange([...groups, ...nodes.map((node): ListItem => ({ id: node.sessionId, group: null, node }))], (x) => x.id, order);
    const loose = orderTree(nodes, lookup, mode, order).map((node): ListItem => ({ id: node.sessionId, group: null, node }));
    // Sessions first: below an open group they would read as its last members.
    return [...loose, ...arrange(groups, (x) => x.id, order)];
  }, [workspace.groups, homes, order, mode, lookup]);
  // Sorted by most recent, a session already listed here (in no group) has nowhere to move to.
  // A project's group stays in its project: the Sessions list does not take it.
  const accepts = (event: DragEvent) => (carries(event, GROUP_MIME) && draggedGroupProject() !== null) || (carries(event, SESSION_MIME) && !(mode === 'recent' && draggedSessionIsHere((s) => s.groupId === null)));
  return (
    <div
      className={`session-list${over ? ' drop-over' : ''}`}
      onDragOver={(event) => {
        // A group block inside took it (most recent: only that block lights up).
        if (!accepts(event) || (mode === 'recent' && event.defaultPrevented)) return setOver(false);
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (event.defaultPrevented || !accepts(event)) return; // a row or a group took it
        const group = event.dataTransfer.getData(GROUP_MIME);
        const id = event.dataTransfer.getData(SESSION_MIME);
        if (!group && !id) return;
        event.preventDefault();
        if (group) void dropGroup(group, null, true);
        else void dropSession(id, null, null, true);
      }}
    >
      {items.map((x) =>
        x.group ? (
          <FolderBlock key={x.id} group={x.group} tree={orderTree(homes.trees[x.id] ?? [], lookup, mode, order)} route={route} activeId={activeId} />
        ) : (
          <ul key={x.id} className="tree flat">
            <TreeRow node={x.node} depth={0} activeId={activeId} rootId={x.id} groupId={null} />
          </ul>
        ),
      )}

      <div className="list-end" aria-hidden />
    </div>
  );
}

// ---- projects: derived from where work landed -------------------------------------------

/** A folded project still shows the open session if it is in it: alone, or below its group's folded row. */
function KeptInProject({ activeId, rows, groups, homes, route }: { activeId: string; rows: readonly SessionView[]; groups: readonly Group[]; homes: SidebarHomes; route: Route | null }) {
  // One of the list's rows, or a session drawn under one (a delegate in the same project).
  if (rows.some((x) => x.id === activeId || treeContains(homes.nestedInProject.get(x.id) ?? [], activeId))) return <KeptRow id={activeId} />;
  const group = groups.find((g) => treeContains(homes.trees[g.id] ?? [], activeId));
  return group ? <FolderBlock group={group} tree={homes.trees[group.id] ?? []} route={route} activeId={activeId} only={activeId} /> : null;
}

/** The open session's row on its own, below the folded thing that holds it. */
function KeptRow({ id }: { id: string }) {
  return (
    <ul className="tree flat">
      <TreeRow node={flatNode(id)} depth={0} activeId={id} rootId={id} groupId={undefined} />
    </ul>
  );
}

/**
 * A project and, when opened, the sessions at home in its list (filed under it, in no group, not
 * nested under a parent in the Sessions list: sidebarHomes). Clicking the name opens or folds it.
 */
function ProjectBlock({ project, workspace, homes, leaveOut, route, activeId, only }: { project: Project; workspace: WorkspaceState; homes: SidebarHomes; /** Sessions drawn under PINNED instead. */ leaveOut: ReadonlySet<string>; route: Route | null; activeId: string | null; /** Drawn folded with only the open session's row (and its group's): its section is folded. */ only?: boolean }) {
  const key = `open:${project.id}`;
  const unfolded = useTabs((v) => v.sidebar.collapsed.includes(key));
  const open = unfolded && !only;
  const order = useTabs((v) => v.sidebar.order);
  const mode = useSessionOrder();
  const lookup = useLookup();
  const seen = useApp((s) => s.seen);
  const renaming = useApp((s) => s.renaming === project.id);
  // The project's own colour, if it has one (Settings → Colours; colours.ts).
  const tint = useProjectTint(project.id);
  const inProjectList = homes.inProjectList;
  const rows = useMemo(() => {
    const ids = new Set(projectRowIds(workspace.sessions, project.id, inProjectList, leaveOut));
    return orderSessions(workspace.sessions.filter((x) => ids.has(x.id)), mode, order);
  }, [workspace.sessions, project.id, inProjectList, leaveOut, order, mode]);
  // Its own groups, above its loose sessions, in the order the user left them; pinned ones are drawn under PINNED.
  const groups = useMemo(() => arrange(workspace.groups.filter((g) => g.projectId === project.id && !homes.pinnedGroups.has(g.id)), (g) => g.id, order), [workspace.groups, project.id, homes, order]);
  const grouped = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  // What needs the user first; quiet sessions and anything past the first few behind "N more" (shared/sidebar-fold.ts).
  const moreKey = `more:${project.id}`;
  const showAll = useTabs((v) => v.sidebar.collapsed.includes(moreKey));
  const fold = useMemo(() => {
    const split = foldRows(rows.map((session) => ({ id: session.id, dot: dotFor(session, seen), activityAt: activityAt(session), session })), { now: Date.now(), activeId });
    return { shown: split.shown.map((x) => x.session), folded: split.folded.map((x) => x.session) };
  }, [rows, seen, activeId]);
  const drawn = showAll ? [...fold.shown, ...fold.folded] : fold.shown;
  // The row lights up for anything in it, its groups' sessions too.
  // The row lights up for anything drawn in it: its rows, what is nested under them, its groups' sessions.
  const nested = useMemo(() => new Set(nestedIds(rows.map((x) => x.id), homes.nestedInProject)), [rows, homes.nestedInProject]);
  const dot = rowDotClass(summaryDot([...rows, ...workspace.sessions.filter((x) => nested.has(x.id) || (x.groupId !== null && grouped.has(x.groupId)))].map((x) => dotFor(x, seen))));
  // Another project dragged here lands above or below this one.
  const reorder = useReorderTarget(PROJECT_MIME, (id, after) => dropProject(id, project.id, after));
  // It also takes a Sessions-list group (which moves into the project), and one of its own
  // sessions dragged out of one of its groups (which leaves the group).
  const [over, setOver] = useDragHighlight(false);
  // Only another computer has it: listed, opened, never dropped into, renamed or started in here.
  const elsewhere = project.away ? notHere.mark(project) : null;
  const takes = (event: DragEvent): boolean => {
    if (elsewhere) return false;
    if (carries(event, GROUP_MIME)) return draggedGroupProject() === null;
    if (!carries(event, SESSION_MIME)) return false;
    const id = draggingId(SESSION_MIME);
    const session = id ? appStore.get().sessionsById.get(id) : undefined;
    return !!session && (session.landedIn ?? session.startedIn) === project.id && session.groupId !== null && grouped.has(session.groupId);
  };
  // Under PINNED the pinned row around this block takes every drop.
  const takesDrops = !useContext(InPinned);
  const view: View = { kind: 'project', id: project.id };
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      reorder.props.onDragOver(event);
      if (event.defaultPrevented || !takes(event)) return setOver(false);
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      reorder.props.onDragLeave(event);
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      setOver(false);
      if (event.defaultPrevented) return; // a group or a row inside took it
      reorder.props.onDrop(event);
      if (event.defaultPrevented || !takes(event)) return;
      event.preventDefault();
      const group = event.dataTransfer.getData(GROUP_MIME);
      const id = event.dataTransfer.getData(SESSION_MIME);
      if (!open) tabActions.toggleCollapsed(key); // show where it went
      if (group) void dropGroup(group, null, true, project.id);
      else if (id) void actions.moveSession(id, null);
    },
  };
  return (
    <InProject.Provider value><div className={`project-block${reorder.edge ? ` drop-${reorder.edge}` : ''}${over ? ' drop-over' : ''}${tint.className}`} style={tint.style} {...(takesDrops ? dropProps : {})}>
      {/* No title tooltip: the hover card (ProjectCard.tsx) says where it lives and more. */}
      <div className="fold-row" {...cardTrigger({ kind: 'project', id: project.id })}>
        <button
          className={`side-link${isView(route, view) ? ' active' : ''}${tint.className}`}
          style={tint.style}
          aria-expanded={open}
          data-menu-kind="project"
          data-menu-id={project.id}
          draggable={!renaming}
          onDragStart={startDrag(PROJECT_MIME, project.id)}
          {...foldClick(view, () => tabActions.toggleCollapsed(key))}
          onDoubleClick={() => !elsewhere && actions.startRename(project.id)}
        >
          <span className="repo-icon">{project.name[0]}</span>
          <span className="fold-label">{renaming ? <RenameInput label="Project name" value={project.name} onDone={(name) => name !== project.name && void actions.renameProject(project.id, name)} /> : project.name}</span>
          <FoldChevron open={open} />
          {elsewhere && (
            <span className="row-elsewhere" role="img" aria-label={elsewhere} title={elsewhere}>
              <FolderX aria-hidden />
            </span>
          )}
          {dot !== 'none' && <span className={`status-dot row-dot ${dot}`} title={rollupLabel(dot)} />}
        </button>
        {!renaming && <RowOpen view={view} name={project.name} what="project" />}
        {!renaming && <RowMore kind="project" id={project.id} name={project.name} />}
        {!renaming && !elsewhere && <RowPlus container={{ projectId: project.id }} name={project.name} />}
      </div>
      {open && groups.map((group) => <FolderBlock key={group.id} group={group} tree={orderTree(homes.trees[group.id] ?? [], lookup, mode, order)} route={route} activeId={activeId} />)}
      {!open && activeId && <KeptInProject activeId={activeId} rows={rows} groups={groups} homes={homes} route={route} />}
      {open &&
        (rows.length > 0 ? (
          <ul className="tree flat">
            {drawn.map((x) => (
              <TreeRow key={x.id} node={projectNode(x.id, homes)} depth={0} activeId={activeId} rootId={x.id} groupId={undefined} />
            ))}
            {fold.folded.length > 0 && (
              <li className="fold-more">
                <button type="button" onClick={() => tabActions.toggleCollapsed(moreKey)} aria-expanded={showAll}>
                  {showAll ? 'Show fewer' : `${fold.folded.length} more`}
                </button>
              </li>
            )}
          </ul>
        ) : null)}
    </div></InProject.Provider>
  );
}

const NO_ORDER: readonly string[] = [];

/** The Projects list, in the order the user dragged them into; new projects come first. */
function ProjectList({ workspace, homes, route, activeId }: { workspace: WorkspaceState; homes: SidebarHomes; route: Route | null; activeId: string | null }) {
  const order = useTabs((v) => v.sidebar.projectOrder ?? NO_ORDER);
  // A pinned project is drawn under PINNED, not here.
  const projects = useMemo(() => arrange(workspace.projects.filter((p) => !homes.pinnedProjects.has(p.id)), (p) => p.id, order), [workspace.projects, homes, order]);
  return (
    <>
      {projects.map((project) => (
        <ProjectBlock key={project.id} project={project} workspace={workspace} homes={homes} leaveOut={homes.away} route={route} activeId={activeId} />
      ))}
    </>
  );
}

/** The sidebar's right edge: drag to resize, double-click for the usual width, arrow keys when focused. */
function ResizeHandle() {
  const width = useTabs((v) => v.sidebar.width ?? SIDEBAR_WIDTH.initial);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => tabActions.setSidebarWidth(e.clientX - left);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => tabActions.setSidebarWidth(SIDEBAR_WIDTH.initial)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') tabActions.setSidebarWidth(width - 16);
        if (e.key === 'ArrowRight') tabActions.setSidebarWidth(width + 16);
      }}
    />
  );
}

/** Where everything is drawn once pins are taken into account (shared/pinned-homes.ts). */
/** The sessions leading a listed ticket, as "session=key" pairs in one string, while the sidebar has a TICKETS section; else empty. One string, so the homes are worked out again only when it changes. */
function useTicketLeadsKey(): string {
  return useApp((s) => {
    if (!hasTicketSection({ on: ticketsOn(s.tickets), show: s.tickets.settings.show })) return '';
    return s.tickets.tickets.flatMap((t) => {
      const lead = ticketLeadIn(s, t.key);
      return lead ? [`${lead}=${t.key}`] : [];
    }).join(' ');
  });
}

function useHomes(workspace: WorkspaceState | null, reviewsSection: boolean): SidebarHomes | null {
  const requests = useApp((s) => s.reviewRequests.requests);
  const ticketLeadsKey = useTicketLeadsKey();
  // The same set while the same sessions are reviewing, so the homes are not worked out again for nothing.
  const reviewingKey = useMemo(() => [...reviewingIds(workspace?.sessions ?? [], requests)].join(' '), [workspace?.sessions, requests]);
  // The keys still listed, as one string for the same reason.
  const listedKey = useMemo(() => requests.map((r) => r.key).join(' '), [requests]);
  return useMemo(() => {
    if (!workspace) return workspace;
    const reviewing = new Set(reviewingKey ? reviewingKey.split(' ') : []);
    const reviewKeyOf = new Map(workspace.sessions.flatMap((s) => (s.review && reviewing.has(s.id) ? [[s.id, s.review.key] as const] : [])));
    const ticketLeads = new Map(ticketLeadsKey ? ticketLeadsKey.split(' ').map((pair) => pair.split('=') as [string, string]) : []);
    return sidebarHomes({ ...workspace, reviewing, reviewKeyOf, listedReviews: new Set(listedKey ? listedKey.split(' ') : []), reviewsSection, ticketLeads });
  }, [workspace?.pins, workspace?.trees, workspace?.sessions, reviewingKey, listedKey, reviewsSection, ticketLeadsKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** PINNED's rows in the session order: dragged, or newest activity first (shared/pinned-order.ts). */
function usePinnedRows(workspace: WorkspaceState, homes: SidebarHomes): PinnedRow[] {
  const mode = useSessionOrder();
  const lookup = useLookup();
  return useMemo(() => orderPinned(homes.pinned, mode, lookup), [homes, mode, lookup]);
}

/** One row of PINNED, drawn as the same item is drawn in its own list. */
function PinnedItem({ row, workspace, homes, route, activeId, only }: { row: PinnedRow; workspace: WorkspaceState; homes: SidebarHomes; route: Route | null; activeId: string | null; /** PINNED is folded: draw only what keeps the open session in sight. */ only?: string }) {
  const order = useTabs((v) => v.sidebar.order);
  const mode = useSessionOrder();
  const lookup = useLookup();
  if (only && (row.kind === 'session' || row.kind === 'review')) return <KeptRow id={only} />;
  // A pinned request with no review yet is its request row; with one, it is that session's row.
  if (row.kind === 'review' && !row.node) return <PinnedRequest requestKey={row.id} route={route} />;
  // The pinned row's own place comes from PINNED's order (usePinnedRows); what hangs under it follows the session order.
  if (row.kind === 'session' || row.kind === 'review')
    return (
      <ul className="tree flat">
        <TreeRow node={orderTree([row.node!], lookup, mode, order)[0]!} depth={0} activeId={activeId} rootId={row.node!.sessionId} groupId={undefined} />
      </ul>
    );
  if (row.kind === 'group') {
    const group = workspace.groups.find((g) => g.id === row.id);
    return group ? <FolderBlock group={group} tree={orderTree(workspace.trees[group.id] ?? [], lookup, mode, order)} route={route} activeId={activeId} only={only} /> : null;
  }
  const project = workspace.projects.find((p) => p.id === row.id);
  // A pinned project leaves out what pinned session rows already draw.
  return project ? <ProjectBlock project={project} workspace={workspace} homes={homes} leaveOut={homes.inSessionRows} route={route} activeId={activeId} only={!!only} /> : null;
}

/** A pinned request nobody has started on, drawn as it is under CODE REVIEWS. */
function PinnedRequest({ requestKey, route }: { requestKey: string; route: Route | null }) {
  const request = useApp((s) => s.reviewRequests.requests.find((r) => r.key === requestKey));
  return request ? <ReviewRequestRow request={request} active={route?.view.kind === 'review-request' && route.view.id === requestKey} /> : null;
}

/** The PINNED row that draws session `id` (itself, or the pinned group or project it is in). */
function pinnedHolder(rows: readonly PinnedRow[], workspace: WorkspaceState, homes: SidebarHomes, id: string): PinnedRow | undefined {
  const projectOf = workspace.sessions.find((s) => s.id === id)?.filing.projectId;
  return rows.find((row) =>
    row.kind === 'session' || row.kind === 'review' ? (row.node ? treeContains([row.node], id) : false) : row.kind === 'group' ? treeContains(workspace.trees[row.id] ?? [], id) : projectOf === row.id && !homes.inSessionRows.has(id),
  );
}

/**
 * What a folded section still shows: the open session's row, below the folded group or project row
 * it is in (active-home.ts says where it is drawn). Collapsing never hides where you are.
 */
function KeptInSection({ section, workspace, homes, route, activeId }: { section: 'sessions' | 'projects'; workspace: WorkspaceState; homes: SidebarHomes; route: Route | null; activeId: string | null }) {
  const home = activeHome(homes, workspace.groups, workspace.sessions, activeId);
  if (!activeId || !home || home.section !== section) return null;
  if (home.section === 'projects') {
    const project = workspace.projects.find((p) => p.id === home.projectId);
    return project ? <ProjectBlock project={project} workspace={workspace} homes={homes} leaveOut={homes.away} route={route} activeId={activeId} only /> : null;
  }
  const group = home.groupId ? workspace.groups.find((g) => g.id === home.groupId) : undefined;
  return group ? <FolderBlock group={group} tree={homes.trees[group.id] ?? []} route={route} activeId={activeId} only={activeId} /> : <KeptRow id={activeId} />;
}

/** What is left of Set up this computer, as a number at the far right of the Settings row; nothing when nothing is. */
function SetupLeft() {
  const left = useSetupLeft();
  if (left === 0) return null;
  return (
    <span className="setup-left" aria-label={setupLeftText(left)} title={setupLeftText(left)}>
      {left}
    </span>
  );
}

export function Sidebar({ route, activeId, onSwitch }: { route: Route | null; activeId: string | null; onSwitch: () => void }) {
  const workspace = useApp((s) => s.workspace);
  const collapsed = useTabs((v) => v.sidebar.collapsed);
  const seen = useApp((s) => s.seen);
  const homes = useHomes(workspace, hasReviewSection(useReviewSettings()));
  if (!workspace || !homes) return <aside className="studio-sidebar" />;
  return <SidebarBody workspace={workspace} homes={homes} collapsed={collapsed} route={route} activeId={activeId} onSwitch={onSwitch} />;
}

/** One row of the top menu: dragged by itself, and a place another row can be dropped beside (Matt, 2026-11-22). A row that is not shown takes no room. */
function MenuSlot({ id, children }: { id: MenuItem; children: React.ReactNode }) {
  const reorder = useReorderTarget(MENU_MIME, (moving, after) => tabActions.placeMenuItem(moving, id, after));
  return (
    <div className={`menu-slot${reorder.edge ? ` drop-${reorder.edge}` : ''}`} draggable onDragStart={startDrag(MENU_MIME, id)} {...reorder.props}>
      {children}
    </div>
  );
}

function SidebarBody({ workspace, homes, collapsed, route, activeId, onSwitch }: { workspace: WorkspaceState; homes: SidebarHomes; collapsed: readonly string[]; route: Route | null; activeId: string | null; onSwitch: () => void }) {
  const pinnedRows = usePinnedRows(workspace, homes);
  const searchShortcut = formatBinding(bindingFor(useShortcuts(), 'switch'), isMac());
  // Where review requests are shown (Settings → Code reviews): the section, the row for their page, or both.
  const reviewSettings = useReviewSettings();
  const reviewsSection = hasReviewSection(reviewSettings);
  const sidebarPrefs = useTabs((v) => v.sidebar);
  const menu = useMemo(() => menuOrder(sidebarPrefs), [sidebarPrefs]);
  // Folded PINNED still shows the open session if it is drawn there.
  const keptPin = activeId ? pinnedHolder(pinnedRows, workspace, homes, activeId) : undefined;

  // Right-click anywhere in the sidebar: the item under the pointer decides the menu. The
  // browser's own menu is suppressed here and nowhere else.
  const onContextMenu = (event: MouseEvent) => {
    if (isTypedText(event.target)) return;
    event.preventDefault();
    // A heading with nothing to create (PINNED) has no menu: the sidebar's own "New…" items do not belong to it.
    if ((event.target as HTMLElement).closest('[data-no-menu]')) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-menu-kind]');
    openRowMenu(el?.dataset.menuKind, el?.dataset.menuId ?? '', { x: event.clientX, y: event.clientY });
  };

  const nav = (view: View, label: string, icon: React.ReactNode) => (
    <button className={`side-link${isView(route, view) ? ' active' : ''}`} data-menu-kind={view.kind === 'overview' ? 'overview' : undefined} {...opener((newTab) => openView(view, newTab))}>
      {icon}
      <span className="link-label">{label}</span>
    </button>
  );

  // The top menu's rows by id; the user's order decides where each is drawn (`menuOrder`).
  const menuRows: Record<MenuItem, React.ReactNode> = {
    overview: nav({ kind: 'overview' }, 'Overview', <LayoutDashboard aria-hidden />),
    'new-session': (
      <button className="side-link" {...opener((newTab) => void runMenuAction(item.newSession().action!, newTab))}>
        <Plus aria-hidden />
        <span className="link-label">New session</span>
      </button>
    ),
    'pull-requests': nav({ kind: 'pull-requests' }, 'Pull requests', <GitPullRequest aria-hidden />),
    'code-reviews': hasReviewLink(reviewSettings) ? <ReviewsLink active={isView(route, { kind: 'code-reviews' })} /> : null,
    tickets: <TicketsLink active={route?.view.kind === 'tickets' || route?.view.kind === 'ticket'} />,
  };

  return (
    <aside className="studio-sidebar" onContextMenu={onContextMenu}>
      <div className="studio-brand">
        <span className="sidebar-wordmark">kestrel</span>
        <button className="brand-search" onClick={onSwitch} title={`Search${searchShortcut ? ` ${searchShortcut}` : ''}`}>
          <Search aria-hidden />
          <span>Search</span>
        </button>
      </div>
      {/* The top menu: matching rows, then a gap, then the lists. New session is right below Overview (Matt, 2026-11-21): what is done most is not under the lists of what waits. */}
      <div className="top-menu">
        {menu.map((id) => (
          <MenuSlot key={id} id={id}>
            {menuRows[id]}
          </MenuSlot>
        ))}
      </div>
      <nav aria-label="Sessions and projects" className="side-scroll">
        <SidebarPins rows={pinnedRows} render={(row) => <PinnedItem row={row} workspace={workspace} homes={homes} route={route} activeId={activeId} />} kept={keptPin && activeId ? <PinnedItem row={keptPin} workspace={workspace} homes={homes} route={route} activeId={activeId} only={activeId} /> : null} />
        {reviewsSection && <SidebarReviews route={route} rows={homes.reviews} activeId={activeId} limit={reviewSettings.sidebarLimit} renderSession={(node) => <TreeRow node={node} depth={0} activeId={activeId} rootId={node.sessionId} groupId={undefined} />} />}
        <SidebarTickets route={route} rows={homes.tickets} activeId={activeId} renderSession={(node) => <TreeRow node={node} depth={0} activeId={activeId} rootId={node.sessionId} groupId={undefined} />} />
        {/* What the user is in the middle of comes first: the work that reaches across projects, then the directory. */}
        <SidebarWorkstreams workspace={workspace} route={route} activeId={activeId} renderNode={(node) => <TreeRow key={node.sessionId} node={node} depth={1} activeId={activeId} rootId={node.sessionId} groupId={undefined} />} />
        {/* Groups that span projects and sessions with no project. Not drawn while there are none: a new group is made from the sidebar's right-click menu. */}
        {hasSessionsSection(workspace, homes) && (
          <>
            <Heading title="SESSIONS" id="sessions" add={item.newFolder()} />
            {collapsed.includes('sessions') ? <KeptInSection section="sessions" workspace={workspace} homes={homes} route={route} activeId={activeId} /> : <SessionList workspace={workspace} homes={homes} route={route} activeId={activeId} />}
          </>
        )}

        <Heading title="PROJECTS" id="projects" add={item.addProject()} />
        {collapsed.includes('projects') ? <KeptInSection section="projects" workspace={workspace} homes={homes} route={route} activeId={activeId} /> : <ProjectList workspace={workspace} homes={homes} route={route} activeId={activeId} />}

        <SidebarTags sessions={workspace.sessions} route={route} renderSession={(id) => <TreeRow key={id} node={flatNode(id)} depth={0} activeId={activeId} rootId={id} groupId={undefined} />} />
      </nav>
      <StatusArea />
      <UpdateNotice />
      <button className={`side-link settings-link${route?.view.kind === 'settings' ? ' active' : ''}`} {...opener((newTab) => openView({ kind: 'settings' }, newTab))}>
        <Settings aria-hidden /> Settings…
        <SetupLeft />
      </button>
      <ResizeHandle />
      <HoverCardHost />
    </aside>
  );
}
