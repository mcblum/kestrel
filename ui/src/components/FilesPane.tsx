// The Files pane: the scope's folder as a tree above, the chosen file below. A session lists its
// working folder, a project page one of the project's directories (the default unless switched); a
// group has no folder (its toolbar button is off). Listings and file contents are held once in the
// app store (data/resources.ts): what was read shows at once and is asked for again on every visit.
import { useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import type { FileContent, FileEntry } from '@kestrel/server/files';
import { parseScope } from '@kestrel/server/scope';
import { useApp } from '../store.ts';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { defaultFolder, folderOf, NO_FOLDER_YET } from '@kestrel/server/project-folders';
import { AddFolderLink } from './AddFolderLink.tsx';
import { FolderSwitch } from './FolderSwitch.tsx';
import { CopyButton } from './CopyButton.tsx';

type Listing = { root: string; entries: FileEntry[] };
/** The files routes answer with the value itself; a refusal is thrown and held as unavailable. */
const asListing = (raw: unknown): Sourced<Listing> => ready(raw as Listing);
const asContent = (raw: unknown): Sourced<FileContent> => ready(raw as FileContent);

/** A session keeps its old route (servers from before scopes answer it); other scopes use /api/scopes. */
function filesApi(scopeKey: string, what: 'files' | 'file', path: string, folderId: string | null): string {
  const base = parseScope(scopeKey)?.kind === 'session' ? `/api/sessions/${encodeURIComponent(scopeKey)}` : `/api/scopes/${encodeURIComponent(scopeKey)}`;
  return `${base}/${what}?path=${encodeURIComponent(path)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`;
}

function Directory({ scopeKey, folderId, path, depth, selected, onOpen }: { scopeKey: string; folderId: string | null; path: string; depth: number; selected: string | null; onOpen: (path: string) => void }) {
  const answer = useResource(filesApi(scopeKey, 'files', path, folderId), asListing).value;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const pad = { paddingLeft: 10 + depth * 14 };
  if (answer.state === 'unavailable') return <p className="files-note" style={pad}>{answer.reason || 'Could not read this folder.'}</p>;
  if (answer.state === 'loading') return <p className="files-note" style={pad}>Loading…</p>;
  const listing = answer.value;
  if (listing.entries.length === 0) return <p className="files-note" style={pad}>Empty</p>;
  const toggle = (p: string) => setOpen((prev) => new Set(prev.has(p) ? [...prev].filter((x) => x !== p) : [...prev, p]));
  return (
    <ul className="files-list">
      {listing.entries.map((entry) => (
        <li key={entry.path}>
          <div className={`file-row${selected === entry.path ? ' selected' : ''}`} style={pad}>
            <button type="button" className="file-name" aria-expanded={entry.dir ? open.has(entry.path) : undefined} onClick={() => (entry.dir ? toggle(entry.path) : onOpen(entry.path))}>
              {entry.dir ? open.has(entry.path) ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden /> : <span className="file-gap" />}
              {entry.dir ? <Folder aria-hidden /> : <File aria-hidden />}
              <span title={entry.name}>{entry.name}</span>
            </button>
            <CopyButton value={`${listing.root}/${entry.path}`} label="path" />
          </div>
          {entry.dir && open.has(entry.path) && <Directory scopeKey={scopeKey} folderId={folderId} path={entry.path} depth={depth + 1} selected={selected} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

/** A project page's Files: which of its directories is listed (the default unless switched); null for any other scope. */
function useProjectFolder(scopeKey: string) {
  const scope = parseScope(scopeKey);
  const projectId = scope?.kind === 'project' ? scope.id : null;
  const project = useApp((s) => (projectId ? s.workspace?.projects.find((p) => p.id === projectId) : undefined));
  const [folderId, setFolderId] = useState<string | null>(null);
  const folder = project ? (folderOf(project, folderId) ?? defaultFolder(project)) : null;
  return { project, folder, setFolderId };
}

export function FilesPane({ scopeKey }: { scopeKey: string }) {
  const { project, folder, setFolderId } = useProjectFolder(scopeKey);
  if (project && !folder)
    return (
      <div className="files">
        <p className="files-note">
          {NO_FOLDER_YET}. <AddFolderLink projectId={project.id} />
        </p>
      </div>
    );
  return (
    <>
      {project && folder && <FolderSwitch project={project} folder={folder} onSelect={setFolderId} />}
      <FilesOf key={folder?.id ?? ''} scopeKey={scopeKey} folderId={project && folder ? folder.id : null} />
    </>
  );
}

function FilesOf({ scopeKey, folderId }: { scopeKey: string; folderId: string | null }) {
  const [path, setPath] = useState<string | null>(null);
  const answer = useResource(path === null ? null : filesApi(scopeKey, 'file', path, folderId), asContent).value;
  const content: FileContent | { kind: 'error'; message: string } | null =
    answer.state === 'ready' ? answer.value : answer.state === 'unavailable' ? { kind: 'error', message: answer.reason || 'Could not read this file.' } : null;
  return (
    <div className="files">
      <div className="files-tree">
        <Directory scopeKey={scopeKey} folderId={folderId} path="" depth={0} selected={path} onOpen={setPath} />
      </div>
      {path !== null && (
        <div className="file-view">
          <div className="file-view-head">
            <span>{path}</span>
            <CopyButton value={path} label="relative path" />
          </div>
          {!content ? (
            <p className="files-note">Loading…</p>
          ) : content.kind === 'text' ? (
            <>
              <pre>{content.text}</pre>
              {content.truncated && <p className="files-note">Only the first part of this file is shown.</p>}
            </>
          ) : (
            <p className="files-note">{content.kind === 'binary' ? 'This is not a text file.' : content.kind === 'too-large' ? `This file is too large to show (${Math.round(content.bytes / 1024 / 1024)} MB).` : content.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
