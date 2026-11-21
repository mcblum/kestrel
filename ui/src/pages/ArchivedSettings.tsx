// Settings → Archived: everything out of sight, with how to bring it back. An archived workstream
// lists the archived sessions it points at under itself (`groupArchived`), folded until asked for.
import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { groupArchived, matchingArchivedGroups, restoreWorkstreamLabel, workstreamArchiveDetail, type ArchivedGroup } from '@kestrel/server/archived-rows';
import { NO_FOLDER_YET, projectPath } from '@kestrel/server/project-folders';
import { isComplete } from '@kestrel/server/workstreams';
import { actions, useApp } from '../store.ts';
import { homePath } from './viewTitle.ts';
import { useArchivedQuery } from '../archivedQuery.ts';

interface Row {
  kind: 'workstream' | 'project' | 'group' | 'session';
  id: string;
  name: string;
  detail: string;
  /** It can be restored by itself; a session hidden with its project or group says which (`because`). */
  restore: boolean;
  because: string;
  session: SessionView | null;
}

/** One row per archived thing. A session hidden only because its project or group is archived is restored by restoring that. */
function archivedRows(workspace: WorkspaceState): Row[] {
  const { sessions, projects, groups } = workspace.archived;
  const archivedIds = new Set(sessions.map((s) => s.id));
  const project = (id: string | null) => [...workspace.projects, ...projects].find((p) => p.id === id);
  const plain = { restore: true, because: '', session: null };
  return [
    // A workstream is archived as a grouping only: a session of it is here only when it was archived itself.
    ...workspace.archivedWorkstreams.map((w): Row => ({ ...plain, kind: 'workstream', id: w.id, name: w.name, detail: workstreamArchiveDetail(w.sessionIds.length, w.sessionIds.filter((id) => archivedIds.has(id)).length, isComplete(w)) })),
    ...projects.map((p): Row => ({ ...plain, kind: 'project', id: p.id, name: p.name, detail: projectPath(p) ? homePath(projectPath(p)!) : NO_FOLDER_YET })),
    ...groups.map((g): Row => ({ ...plain, kind: 'group', id: g.id, name: g.name, detail: '' })),
    ...sessions.map((s): Row => {
      const inProject = projects.some((p) => p.id === (s.filing.projectId ?? s.startedIn));
      const inGroup = groups.some((g) => g.id === s.groupId);
      return { kind: 'session', id: s.id, name: s.title, detail: project(s.filing.projectId ?? s.startedIn)?.name ?? 'No project', restore: !inProject && !inGroup, because: inProject ? 'project' : 'group', session: s };
    }),
  ];
}

function restore(group: ArchivedGroup<Row>): void {
  const { row } = group;
  if (row.kind === 'workstream') void actions.archiveWorkstream(row.id, false, group.restoreWith.length > 0);
  else void actions.archive(row.kind, row.id, false);
}

function RowLine({ group, child, open, onToggle }: { group: ArchivedGroup<Row>; child?: boolean; open?: boolean; onToggle?: () => void }) {
  const { row } = group;
  return (
    <li className={child ? 'archive-child' : undefined}>
      <span className="archive-kind">{row.kind}</span>
      <span className="archive-name">{row.name}</span>
      {onToggle && (
        <button type="button" className="archive-fold" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the archived sessions of ${row.name}`} onClick={onToggle}>
          <ChevronRight aria-hidden />
        </button>
      )}
      <small>{row.detail}</small>
      {row.restore ? (
        <button className="link-button" onClick={() => restore(group)}>
          {row.kind === 'workstream' ? restoreWorkstreamLabel(group.restoreWith.length) : 'Restore'}
        </button>
      ) : (
        <small className="archive-why">hidden with its {row.because}</small>
      )}
      {row.session && (
        <button className="link-button danger" onClick={() => actions.deleteSession(row.session!)}>
          Delete…
        </button>
      )}
    </li>
  );
}

export function ArchivedSettings() {
  const workspace = useApp((s) => s.workspace);
  const all = useMemo(() => (workspace ? groupArchived(archivedRows(workspace), workspace.archivedWorkstreams) : []), [workspace]);
  // What is typed and which workstreams are unfolded are this page's own; the rows come from the workspace in the store.
  const [query, setQuery] = useState('');
  // Opened from Search on an archived session: land with its title in the box.
  useArchivedQuery(setQuery);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => matchingArchivedGroups(all, query), [all, query]);
  const searching = query.trim() !== '';
  const toggle = (id: string) => setUnfolded((was) => new Set(was.has(id) ? [...was].filter((x) => x !== id) : [...was, id]));
  return (
    <>
      <h1>Archived</h1>
      <section className="settings-section wide">
        {all.length > 0 && (
          <label className="session-search archive-search">
            <Search aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search archived" aria-label="Search archived sessions, projects, groups and workstreams" />
          </label>
        )}
        {all.length > 0 && groups.length === 0 ? (
          <p className="settings-help">Nothing archived matches “{query.trim()}”.</p>
        ) : groups.length === 0 ? (
          <p className="settings-help">Nothing is archived. Archive a session, project, group or workstream from its right-click menu (a session also from the button on its row) to put it out of sight without deleting it.</p>
        ) : (
          <ul className="archive-list">
            {groups.flatMap((group) => {
              const key = `${group.row.kind}:${group.row.id}`;
              // A search shows what it found: a workstream holding a match is open while something is typed.
              const open = group.under.length > 0 && (searching || unfolded.has(group.row.id));
              return [
                <RowLine key={key} group={group} open={open} onToggle={group.under.length > 0 ? () => toggle(group.row.id) : undefined} />,
                ...(open ? group.under.map((row) => <RowLine key={`${key}/${row.id}`} group={{ row, under: [], restoreWith: [] }} child />) : []),
              ];
            })}
          </ul>
        )}
      </section>
    </>
  );
}
