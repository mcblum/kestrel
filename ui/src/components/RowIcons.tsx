// The icons drawn in a session row's dot slot when the row has no dot (shared/row-slot.ts decides):
// the changed-files icon (the Changes pane's own, amber while files are uncommitted, grey otherwise),
// then the pull/merge request icon in its status colour. Not buttons: the whole row stays the click
// target. Drawn only for a row that asks (asksForRequest, asksForChanges), so a row with a dot, a
// session with no branch or worktree, or a row in a folded list never asks.
import { GitPullRequest } from 'lucide-react';
import type { SessionView } from '@kestrel/server/model';
import { asksForChanges, asksForRequest, rowSlot, type RowIcon } from '@kestrel/server/row-slot';
import { useChangeCounts, usePullRequests } from './details/sources.ts';
import { CHANGES_ICON } from './PaneToolbar.tsx';
import { useRequestSide, useWorkingTree } from '../workingTree.ts';
import '../styles/pull-request.css';

type Asker = Pick<SessionView, 'id' | 'title' | 'updatedAt' | 'branch' | 'worktreePath' | 'worktreeDiscarded' | 'hostId'>;

const GLYPH = { changes: CHANGES_ICON, request: GitPullRequest } as const;
/** Where each kind's tone colours live: row-request.css for changes, pull-request.css for requests. */
const TONE_PREFIX = { changes: 'changes-tone', request: 'pr-tone' } as const;

/** One icon on the dot's own box. `className` places it: `rail-dot` on a rail button; nothing inside a row's `.row-icons`. */
export function SlotIcon({ kind, icon, className = '' }: { kind: keyof typeof GLYPH; icon: RowIcon<string>; className?: string }) {
  const Glyph = GLYPH[kind];
  return (
    <span className={`status-dot row-icon ${className} ${TONE_PREFIX[kind]}-${icon.tone}`} role="img" aria-label={icon.label} title={icon.label}>
      <Glyph aria-hidden />
    </span>
  );
}

function Icons({ slot }: { slot: ReturnType<typeof rowSlot> }) {
  if (slot.kind !== 'icons') return null;
  return (
    <span className="row-icons row-dot">
      {slot.changes && <SlotIcon kind="changes" icon={slot.changes} />}
      {slot.request && <SlotIcon kind="request" icon={slot.request} />}
    </span>
  );
}

function RequestOnly({ session }: { session: Asker }) {
  const requests = usePullRequests(session.id);
  return <Icons slot={rowSlot(false, requests.value)} />;
}

function RequestAndChanges({ session }: { session: Asker }) {
  const key = String(session.updatedAt);
  const requests = usePullRequests(session.id);
  const counts = useChangeCounts(session.id, key);
  return <Icons slot={rowSlot(false, requests.value, counts.value)} />;
}

/** The slot's icons for a sidebar row; nothing when the row has a dot (the row draws that). */
export function RowIcons({ session, hasDot }: { session: Asker; hasDot: boolean }) {
  // A guest's row shows the worktree it works in: its host's changes and pull request.
  const tree = useWorkingTree(session);
  const side = useRequestSide(session);
  if (asksForChanges(hasDot, { branch: side.branch, worktreePath: tree.tree?.path ?? null })) return <RequestAndChanges session={session} />;
  if (asksForRequest(hasDot, side.branch)) return <RequestOnly session={session} />;
  return null;
}
