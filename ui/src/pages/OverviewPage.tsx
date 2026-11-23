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
import { useMemo } from 'react';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { FILTER_LABEL, emptyState, inView, overviewLine } from '@kestrel/server/status';
import { overviewSections, showsStatus } from '@kestrel/server/overview';
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

const OVERVIEW_HEADING = 'What will you build today?';

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
  const seen = useApp((s) => s.seen);
  const listed = useMemo(() => workspace.sessions.filter((s) => inView(s, { kind: 'overview' })), [workspace.sessions]);
  const { rows, counts } = useMemo(() => overviewSections(listed, seen), [listed, seen]);

  const empty = emptyState({ view: 'overview', shown: listed.length, unfiltered: listed.length, projects: workspace.projects.length, sessions: workspace.sessions.length });
  const newSession = (newTab: boolean) => void runMenuAction(item.newSession().action!, newTab);
  const addProject = () => openCreateProject();
  // No sessions yet: a first-session experience (starter, then the projects), never "nothing needs you".
  if (empty === 'first-session')
    return (
      <div className="page column">
        <PageHeader title={OVERVIEW_HEADING} line="Start in a project, or explore an idea without one." />
        {/* First run: the projects come first, several at once. */}
        {workspace.projects.length === 0 && <ProjectsOnboarding />}
        <StarterSurface />
        <ProjectTiles projects={workspace.projects} onAddProject={addProject} onAddFromFolder={() => openCreateProject(false, true)} />
      </div>
    );

  return (
    <div className="overview-page">
      <div className="overview-scroll">
        <div className="page column inbox-page overview-content">
          <PageHeader title="Overview" line={overviewLine(counts)} onNewSession={newSession} />
          {rows['needs-you'].length > 0 && (
            <Section title={FILTER_LABEL['needs-you']} count={counts['needs-you']}>
              <div className="queue">
                {rows['needs-you'].map((s) => (
                  <AttentionRow key={s.id} session={s} workspace={workspace} />
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
    </div>
  );
}
