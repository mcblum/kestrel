// Folder identity and metadata sit together, with Show in Finder/Copy path beside the path.
// Management actions stay at the right. Hover actions reserve their space and reveal on focus,
// so the row never shifts and every action remains keyboard-accessible.
// Shared by project creation and project settings; only saved folders have a path action.
import { X } from 'lucide-react';
import { folderName } from '@kestrel/server/project-folders';
import { DIR_MIME } from '../labels.ts';
import { PathDetail } from './PathDetail.tsx';
import { startDrag, useReorderTarget } from './sidebarDrag.ts';

export type FolderRow = {
  /** Stable for the row: a folder id, or the path as given before it is saved. */
  key: string;
  path: string;
  /** Unknown until the server has looked at it. */
  isGit: boolean | null;
  error?: string;
};

type Props = {
  rows: readonly FolderRow[];
  /** The default row's key; null draws no badge (a list with no rows). */
  defaultKey: string | null;
  onMakeDefault: (key: string) => void;
  onRemove: (key: string) => void;
  /** Move `key` to just before or after `target`. */
  onMove: (key: string, target: string, after: boolean) => void;
  busy?: boolean;
  /** Saved folders: Show in Finder (Mac app) or Copy path (browser) on each row. */
  pathAction?: { label: string; run: (path: string) => void };
};

const kindLabel = (isGit: boolean | null) => (isGit === null ? '' : isGit ? 'git' : 'plain');

function Row({ row, isDefault, many, onMakeDefault, onRemove, onMove, busy, pathAction }: { row: FolderRow; isDefault: boolean; many: boolean } & Omit<Props, 'rows' | 'defaultKey'>) {
  const reorder = useReorderTarget(DIR_MIME, (moving, after) => moving !== row.key && onMove(moving, row.key, after));
  const name = folderName(row);
  return (
    <li className={`dir-row${reorder.edge ? ` drop-${reorder.edge}` : ''}${row.error ? ' has-error' : ''}`} {...reorder.props}>
      <div className="dir-line" draggable={many && !busy} onDragStart={startDrag(DIR_MIME, row.key)} title={many ? 'Drag to reorder' : undefined}>
        <span className="dir-text">
          <span className="dir-name">
            {name}
            {isDefault && <span className="dir-default">Default</span>}
            <span className="dir-kind">{kindLabel(row.isGit)}</span>
          </span>
          <span className="dir-path-line">
            <PathDetail path={row.path} />
            {pathAction && (
              <button type="button" className="dir-path-action dir-hover-action" aria-label={`${pathAction.label}: ${name}`} onClick={() => pathAction.run(row.path)}>
                {pathAction.label}
              </button>
            )}
          </span>
        </span>
        <span className="dir-actions">
          {/* Reserve the default action only when there are multiple folders to choose from. */}
          {many && (
            <button type="button" className={`quiet-button dir-make-default dir-hover-action${isDefault ? ' slot-only' : ''}`} disabled={busy || isDefault} aria-hidden={isDefault || undefined} tabIndex={isDefault ? -1 : undefined} onClick={() => onMakeDefault(row.key)}>
              Make default
            </button>
          )}
          <button type="button" className="dir-remove" aria-label={`Remove ${name}`} title="Remove from this project" disabled={busy} onClick={() => onRemove(row.key)}>
            <X aria-hidden />
          </button>
        </span>
      </div>
      {row.error && <p className="field-error" role="alert">{row.error}</p>}
    </li>
  );
}

export function FolderList({ rows, defaultKey, onMakeDefault, onRemove, onMove, busy, pathAction }: Props) {
  if (rows.length === 0) return null;
  return (
    <ul className="dir-list">
      {rows.map((row) => (
        <Row key={row.key} row={row} isDefault={row.key === defaultKey} many={rows.length > 1} onMakeDefault={onMakeDefault} onRemove={onRemove} onMove={onMove} busy={busy} pathAction={pathAction} />
      ))}
    </ul>
  );
}
