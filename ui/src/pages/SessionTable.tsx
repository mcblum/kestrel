import { contextMenu } from '../menuState.ts';
// The one table every session list uses: Session, Status, Updated (Project on lists that span
// projects; Group when any session in the list is in a group, `showGroup`; Status left out where a section's heading already says it, `showStatus`). Rows are memoized; a push that changes one session re-renders one row.
import { memo, type CSSProperties, type DragEvent } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { LinkKind, Project, SessionView, WorkspaceState } from '@kestrel/server/model';
import { statusOf, type Sort, type SortKey } from '@kestrel/server/status';
import { age, AGENT_LABEL, dotClass, filingMark, projectName, SESSION_MIME, statusText } from '../labels.ts';
import { FilingTag } from '../components/FilingTag.tsx';
import { PullRequestSummary } from '../components/PullRequestView.tsx';
import { usePullRequests } from '../components/details/sources.ts';
import { openPullRequest } from '../sessionView.ts';
import { opener, openSession, openTag } from '../route.ts';

/** Who started a session, for the line under its title: the handoff trail in one phrase. */
export function originOf(session: SessionView, ws: Pick<WorkspaceState, 'links' | 'sessions'>): string | null {
  const link = ws.links.find((l) => l.childId === session.id);
  const parent = link && ws.sessions.find((s) => s.id === link.parentId);
  if (!link || !parent) return null;
  return `${ORIGIN_TEXT[link.kind]} ${parent.title}`;
}

const ORIGIN_TEXT: Record<LinkKind, string> = { handoff: 'handed off from', delegate: 'delegated by', fork: 'forked from' };

/** The update worth showing under a title: what a running session just did, or why it waits. */
export function updateLine(session: SessionView): string {
  const status = statusOf(session);
  return status === 'working' || status === 'needs-you' || status === 'failed' || status === 'interrupted' ? session.note : '';
}

function SessionPullRequest({ session }: { session: SessionView }) {
  const source = usePullRequests(session.id);
  if (source.value.state !== 'ready' || source.value.value.pullRequests.length === 0) return null;
  return <span className="trow-pr"><PullRequestSummary sessionId={session.id} onRefresh={source.refresh} value={source.value} onOpen={(pr) => { openPullRequest(session.id, pr); openSession(session.id); }} /></span>;
}

function RowTags({ tags }: { tags: readonly string[] }) {
  if (!tags.length) return null;
  return <span className="trow-tags" aria-label="Tags">
    {tags.slice(0, 2).map(tag => <button type="button" className="trow-tag" key={tag} title={`Every session tagged ${tag}`} onClick={e => { e.stopPropagation(); opener(newTab => openTag(tag, newTab)).onClick(e); }} onAuxClick={e => { e.stopPropagation(); opener(newTab => openTag(tag, newTab)).onAuxClick(e); }}>{tag}</button>)}
    {tags.length > 2 && <button type="button" className="trow-tag trow-tag-more" aria-haspopup="menu" aria-label={`Show ${tags.length - 2} more tags`} onClick={e => {
      e.stopPropagation();
      contextMenu.openFrom(e.currentTarget, tags.slice(2).map(tag => ({ id: tag, label: tag })), { returnFocus: e.currentTarget, onPick: item => openTag(item.id) });
    }}>+{tags.length - 2}</button>}
  </span>;
}

const Row = memo(function Row({ session, projects, origin, showProject, showStatus, compact, group, depth = 0 }: { /** How far the row is indented in a tree (a workstream's page); 0 in a flat list. */ depth?: number; session: SessionView; projects: readonly Project[]; origin: string | null; showProject: boolean; showStatus: boolean; compact: boolean; /** Its group's name, '' for none; undefined when there is no Group column. */ group?: string }) {
  const mark = filingMark(session.filing.status, session.filing.discarded);
  const project = projectName(session, projects);
  const update = updateLine(session);
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(SESSION_MIME, session.id);
    event.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div className={`trow${compact ? ' inbox-row' : ''}${depth > 0 ? ' nested' : ''}`} role="row" aria-level={depth > 0 ? depth + 1 : undefined} draggable onDragStart={onDragStart} {...opener((newTab) => openSession(session.id, newTab))}>
      <span className="tcell tcell-main" style={depth > 0 ? ({ '--depth': depth } as CSSProperties) : undefined}>
        <span className="trow-title-line">
          <button type="button" className={`trow-title trow-title-button${compact ? ' inbox-title' : ''}`} title={compact ? session.title : undefined} onClick={e => { e.stopPropagation(); opener((newTab) => openSession(session.id, newTab)).onClick(e); }}>{session.title}</button>
          <RowTags tags={session.tags} />
        </span>
        <span className="trow-sub">
          <span>{AGENT_LABEL[session.agent]}</span>
          {compact && showProject && <span className="trow-inline-project">{project}<FilingTag mark={mark} /></span>}
          {update && <span className="trow-update">{update}</span>}
          {/* In a tree the indent already says who started it. */}
          {origin && depth === 0 && <span>{origin}</span>}
          {!showProject && <FilingTag mark={mark} />}
        </span>
      </span>
      {showStatus && (
        <span className="tcell tcell-status">
          <span className={`status-dot ${dotClass(session)}`} />
          {statusText(session)}
        </span>
      )}
      {showProject && !compact && (
        <span className="tcell tcell-project">
          {project}
          <FilingTag mark={mark} />
        </span>
      )}
      {group !== undefined && <span className="tcell tcell-group">{group}</span>}
      <span className="tcell tcell-pr">{session.branch && <SessionPullRequest session={session} />}</span>
      <span className="tcell tcell-age">{age(session.updatedAt)}</span>
    </div>
  );
});

interface Props {
  sessions: readonly SessionView[];
  workspace: WorkspaceState;
  showProject: boolean;
  /** When given, the column titles sort. */
  sort?: Sort;
  onSort?: (key: SortKey) => void;
  /** No column titles: for the compact sections on Overview. */
  bare?: boolean;
  /** The Status column; off where the section's heading already says every row's status. */
  showStatus?: boolean;
  /** The Group column: on where some session in the list is in a group (not on a group's own page). */
  showGroup?: boolean;
  /** Draw the list as a tree: how far each session is indented, by id (a workstream's page). Sessions are drawn in the order given. */
  depths?: ReadonlyMap<string, number>;
}

export function SessionTable({ sessions, workspace, showProject, sort, onSort, bare, showStatus = true, showGroup = false, depths }: Props) {
  const withGroup = showGroup && !bare;
  const groupName = (s: SessionView) => workspace.groups.find((g) => g.id === s.groupId)?.name ?? '';
  const head = (key: SortKey, label: string, className: string) => {
    const active = sort?.key === key;
    const content = (
      <>
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
      </>
    );
    return onSort ? (
      <button className={`thead-cell ${className}${active ? ' sorted' : ''}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => onSort(key)}>
        {content}
      </button>
    ) : (
      <span className={`thead-cell ${className}`}>{content}</span>
    );
  };
  return (
    <div className={`stable${showProject ? ' with-project' : ''}${withGroup ? ' with-group' : ''}${showStatus ? '' : ' no-status'}${bare ? ' compact' : ''}`} role="table">
      {!bare && (
        <div className="thead" role="row">
          {head('session', 'Session', 'tcell-main')}
          {showStatus && head('status', 'Status', 'tcell-status')}
          {showProject && head('project', 'Project', 'tcell-project')}
          {withGroup && <span className="thead-cell tcell-group">Group</span>}
          <span className="thead-cell tcell-pr">PR / MR</span>
          {head('updated', 'Updated', 'tcell-age')}
        </div>
      )}
      {sessions.map((s) => (
        <Row key={s.id} session={s} projects={workspace.projects} origin={originOf(s, workspace)} showProject={showProject} showStatus={showStatus} compact={!!bare} depth={depths?.get(s.id) ?? 0} {...(withGroup ? { group: groupName(s) } : {})} />
      ))}
    </div>
  );
}
