// The project control: a searchable popover. Unscoped first, then each project with its path,
// then "Browse for project…". Browsing opens the system picker at once; a directory that is
// already a project selects that project, a new one is registered and selected. Typing a path
// is an alternative, not a step on the way.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { filterProjects } from '@kestrel/server/project-search';
import { defaultFolder, NO_FOLDER_YET } from '@kestrel/server/project-folders';
import type { Project } from '@kestrel/server/model';
import { PathDetail } from './PathDetail.tsx';
import { Popup } from './Popup.tsx';
import { actions } from '../store.ts';
import { useHereProjects } from '../awayProjects.ts';

interface Props {
  /** The selected project id, or null for Unscoped. */
  value: string | null;
  onSelect: (projectId: string | null) => void;
  /** Offer these instead of this computer's: another computer's, when the session runs there. No browsing then. */
  projects?: readonly Project[];
  /** Named in the empty search's words and the foot, when the projects are another computer's. */
  computer?: string;
}

const looksLikePath = (q: string) => q.trim().startsWith('/');

/** Under a project's name: its default directory, how many it has, or that it has none yet. */
function PickerDetail({ p }: { p: Project }) {
  // Another computer's project: its folder there, as that computer told of it.
  if (p.away) {
    const there = p.elsewhere?.folders[0];
    return <small>{there ? (there.path ?? there.name) : `On ${p.elsewhere?.machines.map((m) => m.name).join(' and ') || 'another computer'}`}</small>;
  }
  const first = defaultFolder(p);
  if (!first) return <small>{NO_FOLDER_YET}</small>;
  return <PathDetail path={first.path} note={p.folders.length > 1 ? ` · ${p.folders.length} folders` : first.isGit ? '' : ' · plain folder'} />;
}

export function ProjectPicker({ value, onSelect, projects: offered, computer }: Props) {
  const here = useHereProjects();
  const projects = offered ?? here;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const matches = useMemo(() => filterProjects(projects, query), [projects, query]);
  const selected = projects.find((p) => p.id === value);
  const showUnscoped = !query.trim() || 'unscoped no repository'.includes(query.trim().toLowerCase());
  const typedPath = !computer && looksLikePath(query) ? query.trim() : null;
  // However it closes (a pick, Escape, a click away, the button), the search starts empty next time.
  const close = () => {
    setOpen(false);
    setQuery('');
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const choose = (id: string | null) => {
    onSelect(id);
    close();
  };
  const useDirectory = async (path: string) => {
    setBusy(true);
    const picked = await actions.ensureProject(path);
    setBusy(false);
    if (picked) choose(picked.project.id);
  };
  const browse = async () => {
    const picked = await window.kestrelShell?.pickFolder();
    if (picked) await useDirectory(picked);
  };
  const submit = () => {
    if (typedPath) return void useDirectory(typedPath);
    if (showUnscoped && !query.trim()) return choose(null);
    if (matches[0]) choose(matches[0].id);
  };

  return (
    <div className="picker" ref={host}>
      <button ref={button} type="button" className="picker-button" aria-haspopup="listbox" aria-expanded={open} aria-label={`Project: ${selected ? selected.name : 'Unscoped'}`} onClick={() => (open ? close() : setOpen(true))}>
        <span className="picker-value">{selected ? selected.name : 'Unscoped'}</span>
        <ChevronDown aria-hidden />
      </button>
      {open && (
        <Popup anchor={button} className="picker-pop" role="dialog" aria-label="Choose a project">
          <input autoFocus className="picker-search" aria-label="Search projects" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <div className="picker-list" role="listbox">
            {showUnscoped && (
              <button type="button" role="option" aria-selected={value === null} className={`picker-row${value === null ? ' selected' : ''}`} onClick={() => choose(null)}>
                <span className="picker-mark">○</span>
                <span className="picker-text">
                  <strong>Unscoped</strong>
                  <small>No repository</small>
                </span>
              </button>
            )}
            {matches.map((p) => (
              <button type="button" role="option" aria-selected={p.id === value} key={p.id} className={`picker-row${p.id === value ? ' selected' : ''}`} onClick={() => choose(p.id)}>
                <span className="picker-mark">{p.name.charAt(0).toUpperCase()}</span>
                <span className="picker-text">
                  <strong>{p.name}</strong>
                  <PickerDetail p={p} />
                </span>
              </button>
            ))}
            {typedPath && (
              <button type="button" className="picker-row" disabled={busy} onClick={() => void useDirectory(typedPath)}>
                <span className="picker-mark">
                  <FolderOpen aria-hidden />
                </span>
                <span className="picker-text">
                  <strong>Use {typedPath}</strong>
                  <small>Select it, or add it as a project</small>
                </span>
              </button>
            )}
            {!showUnscoped && matches.length === 0 && !typedPath && <p className="picker-none">No project matches “{query.trim()}”.</p>}
          </div>
          <div className="picker-foot">
            {computer ? (
              <p className="picker-none">The projects {computer} has. Add one there to start in it.</p>
            ) : window.kestrelShell ? (
              <button type="button" className="picker-row browse" disabled={busy} onClick={() => void browse()}>
                <FolderOpen aria-hidden /> <span>Browse for project…</span>
              </button>
            ) : (
              <p className="picker-none">Type a full path above to add a project from this browser.</p>
            )}
          </div>
        </Popup>
      )}
    </div>
  );
}
