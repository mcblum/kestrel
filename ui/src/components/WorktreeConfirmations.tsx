// "Remove worktree" (server: landing-api.ts), opened from the session bar's git menu
// (useWorktreeMenu). It asks the server what would be lost first and shows it. Merging a session's
// branch locally is left to the agent: ask it. Drawn like the pull request merge confirmation (MergeConfirmation.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { DialogShell } from './DialogShell.tsx';
import { discardLoss, REMOVE_WORKTREE_ID, worktreeMenuItems, type CommitLine, type DiscardPreview } from '@kestrel/server/landing';
import type { MenuItem } from '@kestrel/server/menu';
import type { SessionView } from '@kestrel/server/model';
import { call } from '../store.ts';

const path = (sessionId: string, action: string) => `/api/sessions/${encodeURIComponent(sessionId)}/${action}`;
const SHORT_SHA = 7;

function Commits({ commits, total }: { commits: readonly CommitLine[]; total: number }) {
  if (total === 0) return null;
  return (
    <ul className="worktree-commits">
      {commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, SHORT_SHA)}</code><span>{c.subject}</span></li>)}
      {total > commits.length && <li className="worktree-more">and {total - commits.length} more</li>}
    </ul>
  );
}

function Loading({ text }: { text: string }) {
  return <div className="pr-merge-loading" role="status"><LoaderCircle size={18} aria-hidden /><span>{text}</span></div>;
}

function Problem({ title, text }: { title: string; text: string }) {
  return <div className="pr-merge-error" role="alert"><strong>{title}</strong><p>{text}</p></div>;
}

/** Ask the server for a preview, again on `attempt`; the error text when it refuses. */
function usePreview<T>(sessionId: string, action: string, attempt: number): { value: T | undefined; error: string; setError: (e: string) => void; clear: () => void } {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setValue(undefined);
    setError('');
    call<T>(path(sessionId, action), { method: 'POST', body: '{}' })
      .then((v) => !cancelled && setValue(v))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => void (cancelled = true);
  }, [sessionId, action, attempt]);
  return { value, error, setError, clear: () => setValue(undefined) };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function DiscardConfirmation({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const preview = usePreview<DiscardPreview>(sessionId, 'discard-preview', attempt);
  const p = preview.value;
  // Deleting the branch is the default only when it loses no commits.
  useEffect(() => setDeleteBranch(!!p && p.totalUnmerged === 0), [p]);
  async function discard() {
    if (!p || busy) return;
    setBusy(true);
    try {
      await call(path(sessionId, 'discard'), { method: 'POST', body: JSON.stringify({ deleteBranch }) });
      onDone();
      onClose();
    } catch (e) {
      preview.setError(messageOf(e));
      preview.clear();
      setBusy(false);
    }
  }
  const loss = p ? discardLoss(p, deleteBranch) : null;
  const actions = preview.error ? (
    <button type="button" className="pr-merge-retry" onClick={() => setAttempt((n) => n + 1)}>Look again</button>
  ) : (
    <button type="button" className="pr-merge-confirm worktree-discard" disabled={!p || busy} onClick={() => void discard()}>
      {busy ? <LoaderCircle size={15} aria-hidden /> : <Trash2 size={15} aria-hidden />}
      {busy ? 'Removing…' : 'Remove'}
    </button>
  );
  return (
    <DialogShell icon={<Trash2 size={20} aria-hidden />} eyebrow="WORKTREE" title="Remove this worktree" busy={busy} danger onClose={onClose} actions={actions}>
      {p && (
        <>
          <p className="worktree-summary">The folder <code>{p.worktree}</code> is removed and the session can no longer continue. It stays in the list, marked “discarded”.</p>
          {p.uncommitted.length > 0 && (
            <>
              <p className="worktree-label">Uncommitted, lost with the folder</p>
              <ul className="worktree-commits">{p.uncommitted.slice(0, 8).map((f) => <li key={f}><span>{f}</span></li>)}{p.uncommitted.length > 8 && <li className="worktree-more">and {p.uncommitted.length - 8} more</li>}</ul>
            </>
          )}
          {p.branch && (
            <label className="worktree-check">
              <input type="checkbox" checked={deleteBranch} disabled={busy} onChange={(e) => setDeleteBranch(e.target.checked)} />
              <span>Delete the branch <code>{p.branch}</code> too{p.totalUnmerged > 0 ? `, with ${p.totalUnmerged === 1 ? 'its commit' : `its ${p.totalUnmerged} commits`} not in ${p.target ?? 'the main checkout'}` : ''}</span>
            </label>
          )}
          {deleteBranch && <Commits commits={p.unmerged} total={p.totalUnmerged} />}
          <p className={loss ? 'worktree-warning' : 'pr-merge-note'}>{loss ?? (deleteBranch ? 'Nothing is lost: every commit is already in ' + (p.target ?? 'the main checkout') + '.' : 'Nothing is lost: committed work stays on the branch.')}</p>
        </>
      )}
      {!p && !preview.error && <Loading text="Checking what would be lost…" />}
      {preview.error && <Problem title="Not removed" text={preview.error} />}
    </DialogShell>
  );
}

/** What the session bar's git menu needs to offer the worktree's removal. */
export interface WorktreeMenu {
  items: MenuItem[];
  /** Opens the confirmation for a picked item; false when the item is not one of these. */
  pick: (item: MenuItem) => boolean;
  /** The open confirmation, if any: render it anywhere. */
  dialog: ReactNode;
}

/** The worktree's item for the session bar's git menu, or null when the session has no worktree to act on. */
export function useWorktreeMenu(session: SessionView): WorktreeMenu | null {
  const [open, setOpen] = useState(false);
  if (!session.worktreePath || !session.branch || session.worktreeDiscarded) return null;
  const working = session.state === 'running' || session.state === 'attention';
  const close = () => setOpen(false);
  const pick = (item: MenuItem): boolean => {
    if (item.id !== REMOVE_WORKTREE_ID) return false;
    setOpen(true);
    return true;
  };
  const dialog = open ? <DiscardConfirmation sessionId={session.id} onClose={close} onDone={close} /> : null;
  return { items: worktreeMenuItems(working), pick, dialog };
}
