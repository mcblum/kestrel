// Settings → Storage (called Worktrees until 0.0.20; its route is still `worktrees`): every worktree Kestrel made for a session that is still on disk, what it
// takes, and whether it looks stale (@kestrel/server/stale-worktrees). Kestrel never removes one
// on its own. "Remove all" takes every suggested one, after saying in place which uncommitted files
// would be lost; "Remove only the N that lose nothing" takes every suggested one with nothing
// uncommitted; and each row has its own Remove, behind the confirmation that says what it loses. The rows are the server's, held once in the store (worktrees.ts).
import { SettingHeading } from './SettingHelp.tsx';
import { useState } from 'react';
import { bulkLoss, reasonText, sizeText, STALE_AFTER_DAYS, type BulkRemoval, type WorktreeRow } from '@kestrel/server/stale-worktrees';
import { opener, openSession } from '../route.ts';
import { OLDER_SERVER, RESTART_REASON, useApp } from '../store.ts';
import { DiscardConfirmation } from './WorktreeConfirmations.tsx';
import { refreshWorktrees, removeWorktrees, useWorktrees } from './worktrees.ts';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What removing it would lose, when anything: shown beside the row so it is known before the button is pressed. */
function lossText(row: WorktreeRow): string {
  const parts = [...(row.uncommitted > 0 ? [plural(row.uncommitted, 'uncommitted file')] : []), ...(row.unmerged > 0 && row.reason !== 'merged' ? [plural(row.unmerged, 'unmerged commit')] : [])];
  return parts.join(' · ');
}

function Row({ row, now, onRemove }: { row: WorktreeRow; now: number; onRemove: () => void }) {
  const loss = lossText(row);
  // An archived session is not in the sidebar's lists: its title is shown without a link.
  const known = useApp((s) => s.sessionsById.has(row.sessionId));
  return (
    <li>
      <span className="worktree-size">{row.bytes === null ? '—' : sizeText(row.bytes)}</span>
      <span className="archive-name worktree-name">
        {known ? (
          <button type="button" className="link-button" title="Open the session" {...opener((newTab) => openSession(row.sessionId, newTab))}>
            {row.title}
          </button>
        ) : (
          row.title
        )}
        <small>
          {row.project ?? 'No project'} · {row.branch}
        </small>
      </span>
      <small className="worktree-why">{row.reason ? reasonText(row.reason, now, row.lastActivityAt) : 'In use'}</small>
      {loss && <small className="worktree-loss">{loss}</small>}
      <button className="link-button" onClick={onRemove}>
        Remove…
      </button>
    </li>
  );
}

function WorktreesList() {
  const discarded = useApp((s) => s.workspace?.sessions.filter((x) => x.worktreeDiscarded).length ?? 0);
  const loaded = useWorktrees(String(discarded));
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Remove all" is confirmed in place first, with what it loses: no dialog for it. (Every hook
  // sits above the first return: the list goes from loading to ready on this same component.)
  const [confirmingAll, setConfirmingAll] = useState(false);
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Measuring the worktrees…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const { rows, summary } = loaded.value;
  const now = Date.now();
  const stale = rows.filter((r) => r.reason !== null);
  const rest = rows.filter((r) => r.reason === null);
  const remove = async (which: BulkRemoval) => {
    setBusy(true);
    setConfirmingAll(false);
    await removeWorktrees(which);
    setBusy(false);
  };
  const loss = bulkLoss(rows);
  const size = (bytes: number) => (bytes > 0 ? ` (${sizeText(bytes)})` : '');
  // When every suggested one loses nothing, "Remove all" is the only button: the two would do the same.
  const someLose = summary.safe.count < summary.stale.count;
  const list = (shown: readonly WorktreeRow[]) => (
    <ul className="archive-list worktree-list">
      {shown.map((row) => (
        <Row key={row.sessionId} row={row} now={now} onRemove={() => setRemoving(row.sessionId)} />
      ))}
    </ul>
  );
  return (
    <>
      {rows.length === 0 ? (
        <p className="settings-help">No session has a worktree on disk.</p>
      ) : (
        <>
          <h2>
            Can be cleaned up <span className="section-count">· {stale.length}{summary.stale.bytes > 0 ? ` · ${sizeText(summary.stale.bytes)}` : ''}</span>
          </h2>
          {stale.length === 0 ? <p className="settings-help">Nothing looks stale.</p> : list(stale)}
          {stale.length > 0 && !confirmingAll && (
            <p className="worktree-bulk">
              <button className="secondary-button small" disabled={busy} onClick={() => (someLose ? setConfirmingAll(true) : void remove('stale'))}>
                {busy ? 'Removing…' : `Remove all ${stale.length}${size(summary.stale.bytes)}${someLose ? '…' : ''}`}
              </button>
              {someLose && summary.safe.count > 0 && (
                <button className="link-button" disabled={busy} onClick={() => void remove('safe')} title="They have no uncommitted files, and a branch with unmerged commits is kept">
                  Remove only the {summary.safe.count} that lose{summary.safe.count === 1 ? 's' : ''} nothing{size(summary.safe.bytes)}
                </button>
              )}
              {!someLose && <small>None has uncommitted files, and a branch with unmerged commits is kept, so nothing is lost.</small>}
            </p>
          )}
          {confirmingAll && (
            <div className="worktree-confirm" role="group" aria-label="Remove all suggested worktrees">
              <p>
                This removes {plural(stale.length, 'worktree')}{size(summary.stale.bytes)} and ends those sessions' work; their conversations stay.{' '}
                {loss.files > 0 ? (
                  <strong>
                    Lost for good: {plural(loss.files, 'uncommitted file')} in {loss.sessions.map((title) => `“${title}”`).join(', ')}.
                  </strong>
                ) : (
                  'No uncommitted file is lost.'
                )}{' '}
                A branch with commits that are not merged is kept.
              </p>
              <button className="secondary-button small danger" onClick={() => void remove('stale')}>
                Remove {plural(stale.length, 'worktree')}
              </button>
              <button className="link-button" onClick={() => setConfirmingAll(false)}>
                Cancel
              </button>
            </div>
          )}
          {rest.length > 0 && (
            <>
              <h2>
                In use <span className="section-count">· {rest.length}</span>
              </h2>
              {list(rest)}
            </>
          )}
        </>
      )}
      {removing && (
        <DiscardConfirmation
          sessionId={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            void refreshWorktrees();
          }}
        />
      )}
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      Each session works in its own copy of its repository, a worktree. Kestrel leaves them where they are and never removes one itself. A worktree is suggested for cleanup when its session's pull request is merged, its session is archived, or
      nothing has happened in it for {STALE_AFTER_DAYS} days. A session you used in the last day is never suggested, unless you archived it. Removing a worktree ends that session's work: its conversation stays, and it can do no more.
    </p>
  </>
);

/** Settings → Worktrees: the page heading with its help, then the list. */
export function WorktreesSetting() {
  return (
    <>
      <SettingHeading level={1} title="Storage" help={HELP} />
      <section className="settings-section wide">
        <WorktreesList />
      </section>
    </>
  );
}
