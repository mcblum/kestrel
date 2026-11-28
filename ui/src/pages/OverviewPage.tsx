// Overview: decide where to intervene next. Compact heading, then what needs you, what finished
// that you have not read, what is working, what is ready to review, and what finished recently
// (shared/overview.ts decides the section of each session). Counts live on the headings. A
// section's table shows a Status column only when its rows can differ (`showsStatus`).
import { sizeText } from '@kestrel/server/stale-worktrees';
import { Archive, ArrowRight } from 'lucide-react';
import { useWorktrees } from '../components/worktrees.ts';
import { opener, openView } from '../route.ts';
import { useApp } from '../store.ts';
import { openCreateProject } from '../projectNav.ts';
import { SessionCanvas } from './SessionCanvas.tsx';
import { type ReactNode, useMemo, useState } from 'react';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { FILTER_LABEL, emptyState, inView, overviewLine } from '@kestrel/server/status';
import { overviewSections, showsStatus } from '@kestrel/server/overview';
import { attentionBySession } from '@kestrel/server/request-attention';
import { useAttentionPrefs } from '../attentionPrefs.ts';
import { runMenuAction } from '../commands.ts';
import { item } from '@kestrel/server/menu';
import { AttentionRow } from './AttentionRow.tsx';
import { ActivityGarden } from './ActivityGarden.tsx';
import { PageHeader } from './PageHeader.tsx';
import { ProjectTiles } from './ProjectTiles.tsx';
import { ProjectsOnboarding } from './ProjectsOnboarding.tsx';
import { StarterSurface } from './StarterSurface.tsx';
import { SessionTable } from './SessionTable.tsx';
import './overview.css';

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="page-section">
      <h2>
        {title} <span className="section-count">· {count}</span>
      </h2>
      {children}
    </section>
  );
}

/** A section of session rows, left out when it has none. */
function TableSection({ title, count, rows, workspace, children }: { title: string; count: number; rows: readonly SessionView[]; workspace: WorkspaceState; children?: React.ReactNode }) {
  if (rows.length === 0) return null;
  return (
    <Section title={title} count={count}>
      <SessionTable sessions={rows} workspace={workspace} showProject showStatus={showsStatus(rows)} bare />
      {children}
    </Section>
  );
}

/**
 * A quiet notice when some session worktrees can be cleaned up, leading to Settings → Worktrees.
 * Kestrel only suggests: nothing is removed from here.
 */
function WorktreeCleanupNotice() {
  const held = useApp((s) => s.workspace?.sessions.filter((x) => x.worktreePath && !x.worktreeDiscarded).length ?? 0);
  const loaded = useWorktrees(String(held));
  const stale = loaded.state === 'ready' ? loaded.value.summary.stale : null;
  if (!stale?.count) return null;
  return (
    <div className="overview-notice">
      <Archive className="overview-notice-icon" aria-hidden />
      <p className="overview-notice-message">
        {stale.count} worktree{stale.count === 1 ? '' : 's'} available for cleanup
        {stale.bytes > 0 && <span className="overview-notice-detail"> · {sizeText(stale.bytes)}</span>}
      </p>
      <button type="button" className="secondary-button small" aria-label="Review worktrees available for cleanup" {...opener((newTab) => openView({ kind: 'settings', section: 'worktrees' }, newTab))}>
        Review <ArrowRight aria-hidden />
      </button>
    </div>
  );
}

export function OverviewPage({ workspace }: { workspace: WorkspaceState }) {
  const [visual, setVisual] = useState(() => new URLSearchParams(location.search).get('view') === 'visualizer' || sessionStorage.getItem('overview-mode') === 'visualizer');
  const switcher = <div className="overview-switch" role="group" aria-label="Overview layout">
    {['Dashboard', 'Visualizer'].map((label, i) => <button type="button" key={label} aria-pressed={visual === Boolean(i)} onClick={() => {
      setVisual(Boolean(i));
      sessionStorage.setItem('overview-mode', label.toLowerCase());
    }}>{label}</button>)}
  </div>;
  const seen = useApp((s) => s.seen);
  const pullRequests = useApp((s) => s.pullRequests);
  const listed = useMemo(() => workspace.sessions.filter((s) => inView(s, { kind: 'overview' })), [workspace.sessions]);
  // Idle sessions whose pull request needs the user (its checks failed): listed under Needs you.
  const attentionPrefs = useAttentionPrefs();
  const attention = useMemo(() => attentionBySession(listed, (id) => pullRequests.get(id), attentionPrefs), [listed, pullRequests, attentionPrefs]);
  const { rows, counts } = useMemo(() => overviewSections(listed, seen, attention), [listed, seen, attention]);

  const empty = emptyState({ view: 'overview', shown: listed.length, unfiltered: listed.length, projects: workspace.projects.length, sessions: workspace.sessions.length });
  const newSession = (newTab: boolean) => void runMenuAction(item.newSession().action!, newTab);
  const addProject = () => openCreateProject();
  let content: ReactNode;
  if (visual) {
    content = <SessionCanvas sessions={listed} workspace={workspace} needs={rows['needs-you']} />;
  } else if (empty === 'first-session') {
    content = (
      <div className="page column">
        <section className="page-section">
          <h2>What will you build today?</h2>
          <div className="page-head-line">Start in a project, or explore an idea without one.</div>
        </section>
        {/* First run: the projects come first, several at once. */}
        {workspace.projects.length === 0 && <ProjectsOnboarding />}
        <StarterSurface />
        <ProjectTiles projects={workspace.projects} onAddProject={addProject} onAddFromFolder={() => openCreateProject(false, true)} />
      </div>
    );
  } else {
    content = (
      <>
        <div className="overview-scroll">
          <div className="page column inbox-page overview-content">
            <PageHeader line={overviewLine(counts)} onNewSession={newSession} />
            {rows['needs-you'].length > 0 && (
              <Section title={FILTER_LABEL['needs-you']} count={counts['needs-you']}>
                <div className="queue">
                  {rows['needs-you'].map((s) => (
                    <AttentionRow key={s.id} session={s} workspace={workspace} attention={attention.get(s.id) ?? null} />
                  ))}
                </div>
              </Section>
            )}
            <WorktreeCleanupNotice />
            <TableSection title="Unread" count={counts.unread} rows={rows.unread} workspace={workspace} />
            <TableSection title={FILTER_LABEL.working} count={counts.working} rows={rows.working} workspace={workspace} />
            <TableSection title={FILTER_LABEL.review} count={counts.review} rows={rows.review} workspace={workspace} />
            <TableSection title={FILTER_LABEL.interrupted} count={counts.interrupted} rows={rows.interrupted} workspace={workspace} />
            <TableSection title="Recently done" count={counts.done} rows={rows.done} workspace={workspace}>
              {counts.done > rows.done.length && (
                <button type="button" className="link-button overview-view-all" aria-label="View all done sessions" {...opener((newTab) => openView({ kind: 'all', filter: 'done' }, newTab))}>
                  View all <ArrowRight aria-hidden />
                </button>
              )}
            </TableSection>
          </div>
        </div>
        <footer className="overview-activity" aria-label="Recent activity">
          <div className="column"><ActivityGarden workspace={workspace} /></div>
        </footer>
      </>
    );
  }

  return (
    <div className="overview-page">
      <div className="overview-header">
        <div className="column"><PageHeader title="Overview" actions={switcher} /></div>
      </div>
      <div className="overview-body">{content}</div>
    </div>
  );
}
