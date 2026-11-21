import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Folder, FolderGit2, MessageSquare, Search as SearchIcon, Tag, Waypoints } from 'lucide-react';
import { search, type SearchHit } from '@kestrel/server/search';
import { homePath } from '../pages/viewTitle.ts';
import { AGENT_LABEL, projectName, statusText } from '../labels.ts';
import { openSession, openView, wantsNewTab } from '../route.ts';
import { useApp } from '../store.ts';
import { searchArchivedFor } from '../archivedQuery.ts';

/** Search: a box in the middle of the window that filters sessions, projects and groups as you type. */
export function SearchPanel({ onClose }: { onClose: () => void }) {
  const workspace = useApp((s) => s.workspace);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => {
    if (!workspace) return [];
    const sessions = workspace.sessions.map((s) => ({ id: s.id, title: s.title, detail: `${projectName(s, workspace.projects)} · ${AGENT_LABEL[s.agent]} · ${statusText(s)}`, updatedAt: s.updatedAt, tags: s.tags }));
    const archivedSessions = workspace.archived.sessions.map((s) => ({ id: s.id, title: s.title, project: projectName(s, [...workspace.projects, ...workspace.archived.projects]), updatedAt: s.updatedAt }));
    return search({ sessions, projects: workspace.projects, groups: workspace.groups, workstreams: workspace.workstreams, archivedWorkstreams: workspace.archivedWorkstreams, archivedSessions }, query);
  }, [workspace, query]);
  const at = Math.min(index, Math.max(hits.length - 1, 0));
  // Braces matter: newer Chromium returns a promise from scrollIntoView, and an effect may only return a clean-up function.
  useEffect(() => {
    void list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  /** Shift or Cmd with the click or Enter opens the hit in a new tab. */
  const pick = (hit: SearchHit | undefined, newTab: boolean) => {
    if (!hit) return;
    onClose();
    // An archived session is not opened as a tab: Settings → Archived, searching for it, is where it is.
    if (hit.kind === 'session' && hit.archived) {
      searchArchivedFor(hit.title);
      openView({ kind: 'settings', section: 'archived' }, newTab);
    } else if (hit.kind === 'session') openSession(hit.id, newTab);
    else openView({ kind: hit.kind, id: hit.id }, newTab);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex(Math.max(0, Math.min(hits.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') pick(hits[at], wantsNewTab(event));
    else if (event.key === 'Escape') onClose();
  };
  const ICON = { session: MessageSquare, project: FolderGit2, group: Folder, tag: Tag, workstream: Waypoints } as const;
  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="search-box" role="dialog" aria-modal="true" aria-label="Search">
        <div className="search-input">
          <SearchIcon aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-label="Search sessions, projects and groups"
            placeholder="Search sessions, projects and groups…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <div className="search-results" id="search-results" role="listbox" ref={list}>
          {hits.length === 0 && <p className="search-none">Nothing matches “{query.trim()}”.</p>}
          {hits.map((hit, i) => {
            const Icon = ICON[hit.kind];
            return (
              <button key={`${hit.kind}:${hit.id}`} type="button" role="option" aria-selected={i === at} className={`search-row${i === at ? ' selected' : ''}`} onMouseMove={() => setIndex(i)} onClick={(e) => pick(hit, wantsNewTab(e))}>
                <Icon aria-hidden />
                <span className="search-title">{hit.title}</span>
                <small>{hit.kind === 'project' ? homePath(hit.detail) : hit.detail}</small>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
