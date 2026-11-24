import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWorkingTree } from '../workingTree.ts';
import { FileCode } from 'lucide-react';
import { Diff, getChangeKey, Hunk, parseDiff, type FileData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import type { ChangedFile, SessionDetail } from '@kestrel/server/model';
import { uncommittedCount, uncommittedFilesText } from '@kestrel/server/commit-request';
import type { GitStatus } from '@kestrel/server/details';
import type { Sourced } from '@kestrel/server/sourced';
import { CommitChangesButton } from './CommitChangesButton.tsx';
import { loadOpeners, openChangedFileMenu, type FileMenuSource } from './changedFileMenu.ts';
import { setDiffView, useDiffView, type DiffViewType } from '../diffView.ts';
import { useChangesFocus } from '../changesFocus.ts';
import { useDiffTokens } from '../highlight/diffTokens.ts';
import '../styles/code-tokens.css';

/** One file of a diff, coloured by its language once its tokens are worked out (highlight/diffTokens.ts). */
/** The diff's own key for the change that is line `line` of the file as it is now, or null when the diff does not show that line. */
function changeKeyAt(file: FileData, line: number): string | null {
  for (const hunk of file.hunks) {
    const change = hunk.changes.find((c) => (c.type === 'insert' && c.lineNumber === line) || (c.type === 'normal' && c.newLineNumber === line));
    if (change) return getChangeKey(change);
  }
  return null;
}

function OneFileDiff({ file, path, viewType, markLine }: { file: FileData; path: string; viewType: DiffViewType; /** A line asked for from the conversation: marked, and brought into view. */ markLine?: number }) {
  const tokens = useDiffTokens(file.hunks, path);
  const marked = useMemo(() => (markLine === undefined ? null : changeKeyAt(file, markLine)), [file, markLine]);
  const selected = useMemo(() => (marked ? [marked] : []), [marked]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (marked) box.current?.querySelector(`[data-change-key="${marked}"]`)?.scrollIntoView({ block: 'center' });
  }, [marked]);
  return (
    <div ref={box}>
      <Diff viewType={viewType} diffType={file.type} hunks={file.hunks} tokens={tokens} selectedChanges={selected} className={tokens ? 'diff-highlighted' : undefined}>
        {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </div>
  );
}

// The diff itself is react-diff-view; only the colours are ours (see app.css, code-tokens.css).
const FileDiffView = memo(function FileDiffView({ file, viewType, markLine }: { file: ChangedFile; viewType: DiffViewType; markLine?: number }) {
  const parsed = useMemo(() => parseDiff(file.diff), [file.diff]);
  return (
    <div className={`diff-wrap diff-${viewType}`}>
      {parsed.map((f) => (
        <OneFileDiff key={`${f.oldRevision}-${f.newRevision}-${f.newPath}`} file={f} path={f.type === 'delete' ? f.oldPath : f.newPath || file.path} viewType={viewType} markLine={markLine} />
      ))}
    </div>
  );
});

const VIEW_TYPES: readonly { id: DiffViewType; label: string }[] = [
  { id: 'unified', label: 'Unified' },
  { id: 'split', label: 'Side by side' },
];

/** Unified or side by side, for every diff in the window (diffView.ts). */
function DiffViewToggle({ value }: { value: DiffViewType }) {
  return (
    <span className="diff-view-toggle" role="group" aria-label="Diff layout">
      {VIEW_TYPES.map((v) => (
        <button key={v.id} type="button" className={`chip${value === v.id ? ' selected' : ''}`} aria-pressed={value === v.id} onClick={() => setDiffView(v.id)}>
          {v.label}
        </button>
      ))}
    </span>
  );
}

/** The changed files as a list, and the chosen one's diff. `empty` shows when there are none. With `menu`, a right-click on a file opens its menu (changedFileMenu.ts). */
export function ChangesView({ files, resetKey, empty, against, menu, focusFor }: { files: readonly ChangedFile[]; /** Going back to the first file when this changes. */ resetKey: string; empty: ReactNode; /** What the diff is taken against, for the header. */ against: string; menu?: FileMenuSource; /** A session whose conversation may ask for one file's diff (changesFocus.ts). */ focusFor?: string }) {
  const [index, setIndex] = useState(0);
  const viewType = useDiffView();
  const focus = useChangesFocus(focusFor);
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => setIndex(0), [resetKey]);
  // Asked for from the conversation: select that file once the list has it.
  const focusAt = focus ? files.findIndex((f) => f.path === focus.path) : -1;
  // Each ask is applied once, so a later change to the list does not pull the selection back.
  const applied = useRef(0);
  useEffect(() => {
    if (!focus || focusAt < 0 || applied.current === focus.seq) return;
    applied.current = focus.seq;
    setIndex(focusAt);
    requestAnimationFrame(() => selected.current?.scrollIntoView({ block: 'nearest' }));
  }, [focus, focusAt]);
  useEffect(() => void (menu && loadOpeners()), [menu]);
  const file = files[index] ?? files[0];
  if (!file) return <div className="context-content">{empty}</div>;
  return (
    <>
      <div className="file-list">
        {files.map((f, i) => (
          <button
            key={f.path}
            ref={f === file ? selected : undefined}
            className={`file-button${f === file ? ' selected' : ''}`}
            aria-pressed={f === file}
            onClick={() => setIndex(i)}
            onContextMenu={
              menu &&
              ((e) => {
                e.preventDefault();
                void openChangedFileMenu(e.clientX, e.clientY, f, f === file, menu, () => setIndex(i), e.currentTarget);
              })
            }
          >
            <FileCode aria-hidden />
            <span>{f.path}</span>
            <span className="file-stat">{f.status}</span>
          </button>
        ))}
      </div>
      <div className="diff-header">
        <span>{file.path}</span>
        <span className="diff-header-side">
          <span>vs. {against}</span>
          <DiffViewToggle value={viewType} />
        </span>
      </div>
      {/* The line asked for is marked only in the file it was asked for in. */}
      <FileDiffView file={file} viewType={viewType} markLine={focus && focus.path === file.path ? focus.line : undefined} />
    </>
  );
}

/** A session's changes: everything its worktree has that its base does not. */
export function Changes({ detail, files, problem, plainFolder, git }: { detail: SessionDetail; files: readonly ChangedFile[]; /** Why the list could not be read from the worktree; null when it was. */ problem: string | null; plainFolder: boolean; /** The session's git status, for the uncommitted line. */ git: Sourced<GitStatus> }) {
  // The folder its files are in: the worktree it works in, its host's for a guest.
  const folder = useWorkingTree(detail.session).tree?.path ?? null;
  if (plainFolder)
    return (
      <div className="context-content">
        <h3>No change history for plain folders yet</h3>
        <p>This project is a plain folder, so the session edits it in place. Kestrel does not record its changes yet, so there is no diff to show here. Register the folder as a git repository to get worktrees and diffs.</p>
      </div>
    );
  const uncommitted = uncommittedCount(git);
  const empty = problem ? (
    <>
      <h3>Kestrel could not read this session’s changes</h3>
      <p className="changes-problem">{problem}</p>
    </>
  ) : uncommitted > 0 ? (
    // Never "nothing differs" beside a count of uncommitted files: say what is known instead.
    <>
      <h3>Nothing listed against the base</h3>
      <p>Git reports {uncommittedFilesText(uncommitted)} here, and Kestrel found no file that differs from this session’s base. Either those changes bring the worktree back to its base, or the list has not been read again yet.</p>
    </>
  ) : git.state === 'unavailable' && detail.session.filing.status !== 'unscoped' ? (
    // Unavailable is not clean: say why git could not be asked instead of "no changes".
    <>
      <h3>Git status unavailable</h3>
      <p className="changes-problem">{git.reason}</p>
    </>
  ) : (
    <>
      <h3>No changes yet</h3>
      <p>{detail.session.filing.status === 'unscoped' ? 'This session has no project. It reads the registered projects and hands off or delegates anything that needs an edit there.' : 'Nothing in this session’s worktree differs from its base.'}</p>
    </>
  );
  const menu = useMemo(() => ({ sessionId: detail.session.id, folder }), [detail.session.id, folder]);
  return (
    <>
      {uncommitted > 0 && (
        <div className="pane-head changes-uncommitted">
          <span className="pane-head-name">{uncommittedFilesText(uncommitted)}</span>
          <CommitChangesButton sessionId={detail.session.id} uncommitted={uncommitted} />
        </div>
      )}
      {problem && files.length > 0 && (
        <p className="changes-stale" role="status">
          This list may be incomplete or out of date. Kestrel could not read all of the worktree: {problem}
        </p>
      )}
      <ChangesView files={files} resetKey={detail.session.id} empty={empty} against="base" menu={menu} focusFor={detail.session.id} />
    </>
  );
}
