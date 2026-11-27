// Project, group, tag, Unscoped and All sessions: one compact header, one filter row, one table, in
// one column. Project, group and tag pages share the header (title, one quiet line, New session and the
// … menu at the right) and a narrower column. A project page adds two local tabs under its header,
// Sessions and Settings; the Sessions panel stays mounted while Settings shows, so its filters and
// search are as they were left (ProjectTabs.tsx keeps each tab's scroll).
import { useMemo, useState } from 'react';
import { Folder } from 'lucide-react';
import type { WorkspaceState } from '@kestrel/server/model';
import { item } from '@kestrel/server/menu';
import { DEFAULT_SORT, NO_FILTERS, applyFilters, countByFilter, emptyState, hasFilters, inView, sortSessions, type Filters, type Sort, type SortKey } from '@kestrel/server/status';
import { runMenuAction } from '../commands.ts';
import { AGENT_LABEL, projectName } from '../labels.ts';
import type { View } from '../route.ts';
import { actions } from '../store.ts';
import { GroupContext, ProjectContext } from '../components/ScopeContext.tsx';
import { ProjectChanges } from '../components/ProjectChanges.tsx';
import { EmptyState } from './EmptyState.tsx';
import { FilterBar } from './FilterBar.tsx';
import { PageHeader } from './PageHeader.tsx';
import { ProjectColourPicker, TagColourPicker } from '../components/ColoursSetting.tsx';
import { ScopePage } from './ScopePage.tsx';
import { SessionTable } from './SessionTable.tsx';
import { viewTitle } from './viewTitle.ts';
import { openCreateProject } from '../projectNav.ts';
import { ProjectFolderLine } from './ProjectFolderLine.tsx';
import { ProjectPanel, ProjectTabs } from './ProjectTabs.tsx';
import { ProjectSettingsTab } from './ProjectSettingsTab.tsx';
import { projectTabOf } from '@kestrel/server/routes';
import { ProjectElsewhereAdd, ProjectElsewhereEmpty, ProjectElsewhereLine } from './ProjectElsewhere.tsx';
import { notHere } from '../awayProjects.ts';
import '../styles/away-projects.css';

const sessionCount = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

export function ListPage({ view, workspace }: { view: Exclude<View, { kind: 'overview' } | { kind: 'attention' } | { kind: 'pull-requests' } | { kind: 'settings' } | { kind: 'move' } | { kind: 'new-project' } | { kind: 'code' } | { kind: 'workstream' } | { kind: 'review-request' } | { kind: 'code-reviews' } | { kind: 'tickets' } | { kind: 'ticket' } | { kind: 'whats-new' }>; workspace: WorkspaceState }) {
  const [filters, setFilters] = useState<Filters>(() => view.kind === 'all' && view.filter ? { ...NO_FILTERS, status: view.filter } : NO_FILTERS);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const inScope = useMemo(() => workspace.sessions.filter((s) => inView(s, view)), [workspace.sessions, view]);
  const counts = useMemo(() => countByFilter(inScope), [inScope]);
  const rows = useMemo(() => {
    const haystack = (s: (typeof inScope)[number]) => `${s.title} ${projectName(s, workspace.projects)} ${workspace.groups.find((g) => g.id === s.groupId)?.name ?? ''} ${AGENT_LABEL[s.agent]} ${s.note} ${s.tags.join(' ')}`;
    return sortSessions(applyFilters(inScope, filters, haystack), sort, (s) => projectName(s, workspace.projects));
  }, [inScope, filters, sort, workspace]);

  const title = viewTitle(view, workspace);
  const project = view.kind === 'project' ? workspace.projects.find((p) => p.id === view.id) : undefined;
  const group = view.kind === 'group' ? workspace.groups.find((g) => g.id === view.id) : undefined;
  const empty = emptyState({ view: view.kind, shown: rows.length, unfiltered: inScope.length, projects: workspace.projects.length, sessions: workspace.sessions.length });
  const newSession = (newTab: boolean) => void runMenuAction(item.newSession(view.kind === 'project' ? { projectId: view.id } : view.kind === 'group' ? { groupId: view.id } : {}).action!, newTab);

  // Only another computer of the account has it: no folder, settings or changes here (account-sessions.md, 10.2).
  const elsewhere = project?.away ? project : null;
  const line = elsewhere ? (
    <ProjectElsewhereLine project={elsewhere} />
  ) : project ? (
    <ProjectFolderLine project={project} />
  ) : group ? (
    sessionCount(inScope.length)
  ) : view.kind === 'unscoped' ? (
    'No project yet. These sessions work in a scratch folder and hand off to change a project.'
  ) : view.kind === 'tag' ? (
    `Every session tagged ${title}, wherever it is filed.`
  ) : undefined;
  const menu = project ? { kind: 'project' as const, id: project.id } : group ? { kind: 'folder' as const, id: group.id } : view.kind === 'tag' ? { kind: 'tag' as const, id: view.id } : undefined;
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'updated' ? 'desc' : 'asc' }));

  const tagged = view.kind === 'tag';
  const tab = projectTabOf(view);
  const sessions = (
    <>
      {inScope.length > 0 && <FilterBar counts={counts} filters={filters} onChange={setFilters} />}
      {tagged && inScope.length === 0 ? (
        <div className="empty">
          <h2>No session is tagged “{title}” now</h2>
        </div>
      ) : elsewhere && inScope.length === 0 ? (
        <ProjectElsewhereEmpty project={elsewhere} />
      ) : empty && empty !== 'filtered' ? (
        <EmptyState kind={empty} name={title} onNewSession={newSession} onAddProject={() => openCreateProject()} onClearFilters={() => setFilters(NO_FILTERS)} />
      ) : empty === 'filtered' ? (
        <EmptyState kind="filtered" onNewSession={newSession} onAddProject={() => undefined} onClearFilters={() => setFilters(NO_FILTERS)} />
      ) : (
        <SessionTable sessions={rows} workspace={workspace} showProject={view.kind !== 'project'} showGroup={view.kind !== 'group' && inScope.some((s) => s.groupId !== null)} sort={view.kind === 'all' ? sort : undefined} onSort={view.kind === 'all' ? onSort : undefined} />
      )}
      {hasFilters(filters) && rows.length > 0 && <p className="filter-note">{rows.length} of {inScope.length} shown</p>}
    </>
  );
  const page = (
    <div className={`page column${menu ? ' collection' : ''}`}>
      <PageHeader
        title={title}
        onNewSession={view.kind === 'unscoped' || tagged ? undefined : newSession}
        line={line}
        menu={menu}
        // A project's, group's or tag's colour, as one circle in the corner (Settings → Colours has the same).
        mark={project && !elsewhere ? <ProjectColourPicker projectId={project.id} name={project.name} /> : tagged ? <TagColourPicker tag={view.id} /> : undefined}
      />
      {project && !elsewhere ? (
        <>
          <ProjectTabs projectId={project.id} tab={tab} />
          <ProjectPanel projectId={project.id} tab="sessions" shown={tab === 'sessions'}>
            {sessions}
          </ProjectPanel>
          {tab === 'settings' && (
            <ProjectPanel projectId={project.id} tab="settings" shown>
              <ProjectSettingsTab project={project} section={view.kind === 'project' ? view.section : undefined} />
            </ProjectPanel>
          )}
        </>
      ) : (
        <>
          {elsewhere && <ProjectElsewhereAdd project={elsewhere} />}
          {sessions}
        </>
      )}
    </div>
  );
  if (project)
    return (
      <ScopePage
        scope={{ kind: 'project', id: project.id }}
        noDirectory={project.folders.length === 0}
        {...(elsewhere ? { elsewhere: notHere.noFolder(elsewhere) } : {})}
        bar={
          <>
            <span className="bar-item bar-project" title={project.name}>
              <span className="bar-path">{project.name}</span>
            </span>
          </>
        }
        changes={elsewhere ? undefined : <ProjectChanges projectId={project.id} />}
        context={<ProjectContext project={project} sessions={inScope.length} />}
      >
        {page}
      </ScopePage>
    );
  if (group)
    return (
      <ScopePage
        scope={{ kind: 'group', id: group.id }}
        bar={
          <>
            <span className="bar-item bar-project" title={group.name}>
              <Folder aria-hidden />
              <span className="bar-path">{group.name}</span>
            </span>
            {group.auto && <span className="bar-item">Created by a delegate</span>}
          </>
        }
        context={<GroupContext group={group} sessions={inScope} />}>
        {page}
      </ScopePage>
    );
  return page;
}
