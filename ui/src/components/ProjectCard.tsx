// What the hover card beside a project row says (HoverCard.tsx draws the card; hoverCardState.ts
// says when): the project's name with a pin toggle, how many sessions it has, its folders, and its
// page. Not shown on keyboard focus: the row's … menu has everything in it.
import { useMemo } from 'react';
import { showInManager } from '../platform.ts';
import { Folder, FolderPlus, MessageSquare, Pin, Settings } from 'lucide-react';
import type { MenuAction } from '@kestrel/server/menu';
import type { Project } from '@kestrel/server/model';
import { projectCardLines } from '@kestrel/server/project-card';
import { runMenuAction } from '../commands.ts';
import { hoverCard } from '../hoverCardState.ts';
import { opener } from '../route.ts';
import { openProjectPage } from '../projectNav.ts';
import { useApp } from '../store.ts';
import { scopeKey } from '@kestrel/server/scope';
import { CardOpenIn } from './CardOpenIn.tsx';
import { notHere } from '../awayProjects.ts';
import { PathDetail } from './PathDetail.tsx';

const run = (action: MenuAction, newTab = false) => (hoverCard.close(), void runMenuAction(action, newTab));

export function ProjectCardBody({ project, pinned }: { project: Project; pinned: boolean }) {
  const sessions = useApp((s) => s.workspace?.sessions);
  const lines = useMemo(() => projectCardLines(project, sessions ?? []), [project, sessions]);
  const where = window.kestrelShell ? showInManager() : 'Copy path';
  const pinLabel = pinned ? `Unpin ${project.name}` : `Pin ${project.name}`;
  return (
    <>
      <div className="card-line card-head">
        <Folder aria-hidden />
        <strong>{project.name}</strong>
        {!project.away && <button type="button" className={`icon-button card-pin${pinned ? ' pinned' : ''}`} aria-pressed={pinned} aria-label={pinLabel} title={pinLabel} onClick={() => void runMenuAction({ type: 'pin', kind: 'project', id: project.id, pinned: !pinned })}>
          <Pin aria-hidden />
        </button>}
      </div>
      <div className="card-line">
        <MessageSquare aria-hidden />
        <span>{lines.sessions}</span>
      </div>
      <div className="menu-sep" role="separator" />
      {project.away && (
        <div className="card-line card-muted">
          <Folder aria-hidden />
          <span>{notHere.mark(project)} · on {project.elsewhere?.machines.map((m) => m.name).join(' and ') || 'another computer'}</span>
        </div>
      )}
      {lines.noFolder && !project.away && (
        <div className="card-line card-muted">
          <Folder aria-hidden />
          <span>{lines.noFolder}</span>
        </div>
      )}
      {lines.folders.map((f) => (
        <button key={f.id} type="button" className="menu-item card-line card-path" title={`${where}: ${f.path}`} onClick={() => run({ type: 'reveal', path: f.path })}>
          <Folder aria-hidden />
          <PathDetail path={f.path} note={f.note} />
        </button>
      ))}
      {/* Its folder, opened where the work is done (Matt, 2026-11-19). */}
      {lines.folders.length > 0 && <CardOpenIn scope={scopeKey({ kind: 'project', id: project.id })} />}
      <div className="menu-sep" role="separator" />
      <button type="button" className="menu-item card-line" {...opener((newTab) => (hoverCard.close(), openProjectPage(project.id, newTab)))}>
        <Settings aria-hidden />
        <span>Open project page</span>
      </button>
      {!project.away && (
        <button type="button" className="menu-item card-line" onClick={() => run({ type: 'add-folder', projectId: project.id })}>
          <FolderPlus aria-hidden />
          <span>Add folder…</span>
        </button>
      )}
    </>
  );
}
