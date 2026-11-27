// What the hover card beside a session row says (HoverCard.tsx draws the card; hoverCardState.ts
// says when): its title and status dot, where it is filed, its agent and status, what it is doing,
// where it came from, its branch, changed files and pull request, and when it last did something.
// It is what the sidebar already knows (@kestrel/server/session-card), and it says what the row's
// tooltip and its dot and icons said, which the row's hover hides. Lines do what the same thing does
// in the Details pane or the session bar: the branch copies, changed files open the Changes pane,
// the pull request opens its tab, the session it came from opens, and the time shows in full. Under its
// pull request, those of the sessions it brought in (CardRequests.tsx).
import { useMemo } from 'react';
import { Bot, Clock, CornerDownRight, Folder, GitBranch, Monitor, Split, Users } from 'lucide-react';
import { useMachineName } from '../machines.ts';
import { guestWhere } from '@kestrel/server/working-tree';
import { useWorkingTree } from '../workingTree.ts';
import { primaryPullRequest } from '@kestrel/server/details';
import type { SessionView } from '@kestrel/server/model';
import { changesIcon, requestIcon } from '@kestrel/server/row-slot';
import { activityAt } from '@kestrel/server/session-order';
import { sessionCardLines } from '@kestrel/server/session-card';
import { showChanges } from '../changesFocus.ts';
import { hoverCard, type CardTarget } from '../hoverCardState.ts';
import { AGENT_LABEL, filingMark, projectName, statusText, UNSCOPED } from '../labels.ts';
import { opener, openSession } from '../route.ts';
import { openPullRequest } from '../sessionView.ts';
import { useApp } from '../store.ts';
import { CardOpenIn } from './CardOpenIn.tsx';
import { CopyButton } from './CopyButton.tsx';
import { useAttentionPrefs } from '../attentionPrefs.ts';
import { useChangeCounts, usePullRequests } from './details/sources.ts';
import { CHANGES_ICON } from './PaneToolbar.tsx';
import { useRowDot } from './useRowDot.ts';
import { useBroughtIn } from '../broughtIn.ts';
import { BroughtInCardLines, CardRequestIcon } from './CardRequests.tsx';

/** Changed files, asked only of a session with a worktree (as the row's icon is). */
function ChangesLine({ session }: { session: SessionView }) {
  const counts = useChangeCounts(session.id, String(session.updatedAt));
  const icon = changesIcon(counts.value);
  if (!icon) return null;
  const Glyph = CHANGES_ICON;
  const value = counts.value.state === 'ready' ? counts.value.value : undefined;
  const lines = value && (value.added ?? 0) + (value.removed ?? 0) > 0 ? { added: value.added ?? 0, removed: value.removed ?? 0 } : null;
  return (
    <button type="button" className={`menu-item card-line card-tone changes-tone-${icon.tone}`} title="Open the Changes pane" {...opener((newTab) => (hoverCard.close(), openSession(session.id, newTab), showChanges(session.id)))}>
      <Glyph aria-hidden />
      <span className="card-text">{icon.label}</span>
      {/* Lines added and removed, in the diff's own green and red, as the session bar shows them. */}
      {lines && (
        <span className="git-summary-counts card-line-counts">
          <span className="ctx-added">+{lines.added}</span>
          <span className="ctx-removed">−{lines.removed}</span>
        </span>
      )}
    </button>
  );
}

/**
 * Its pull request, the icon in the request's status colour, and under it the requests of the sessions it
 * brought in, as its children (CardRequests.tsx). `withOwn` is false for a session with no branch, which
 * can have no request of its own: its children hang from the card's heading.
 */
function RequestLines({ sessionId, withOwn }: { sessionId: string; withOwn: boolean }) {
  const lookup = usePullRequests(sessionId).value;
  const icon = requestIcon(lookup, useAttentionPrefs());
  const pr = withOwn && lookup.state === 'ready' ? primaryPullRequest(lookup.value.pullRequests) : undefined;
  const own = icon && pr;
  return (
    <>
      {own && (
        <button type="button" className="menu-item card-line" title="Open it in the session" {...opener((newTab) => (hoverCard.close(), openPullRequest(sessionId, pr), openSession(sessionId, newTab)))}>
          <CardRequestIcon tone={icon.tone} alert={icon.alert} />
          <span className="card-text">{icon.label}</span>
        </button>
      )}
      <BroughtInCardLines sessionId={sessionId} underOwn={!!own} />
    </>
  );
}

const FULL_DATE: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' };

/** Where it came from (opens that session) or what it started. */
function LineageLine({ lineage }: { lineage: NonNullable<CardTarget['lineage']> }) {
  const { sessionId, text } = lineage;
  if (!sessionId) {
    return (
      <div className="card-line">
        <Split aria-hidden />
        <span className="card-text">{text}</span>
      </div>
    );
  }
  return (
    <button type="button" className="menu-item card-line" title="Open that session" {...opener((newTab) => (hoverCard.close(), openSession(sessionId, newTab)))}>
      <Split aria-hidden />
      <span className="card-text">{text}</span>
    </button>
  );
}

export function SessionCardBody({ session, lineage }: { session: SessionView; lineage: CardTarget['lineage'] }) {
  const projects = useApp((s) => s.workspace?.projects);
  const group = useApp((s) => (session.groupId ? s.workspace?.groups.find((g) => g.id === session.groupId)?.name : undefined));
  const dot = useRowDot(session);
  // A guest's card shows the worktree it works in: its host's branch, changes and pull request.
  const tree = useWorkingTree(session).tree;
  const lines = useMemo(() => {
    const project = projectName(session, projects ?? []);
    return sessionCardLines(
      {
        title: session.title,
        project: project === UNSCOPED ? null : project,
        group: group ?? null,
        agent: AGENT_LABEL[session.agent],
        status: statusText(session),
        dot: dot.label,
        note: session.note,
        mark: filingMark(session.filing.status, session.filing.discarded)?.label ?? null,
        branch: tree?.branch ?? null,
        activityAt: activityAt(session),
      },
      Date.now(),
    );
  }, [session, projects, group, dot.label, tree]);
  const machine = useMachineName(session.runsOn);
  // A branch's changes and pull request are read from its worktree, which only its own computer has.
  const hasBranch = !!lines.branch && !machine;
  const broughtIn = useBroughtIn(session.id) && !machine;
  return (
    <>
      <div className="card-line card-head">
        <strong title={lines.title}>{lines.title}</strong>
        {dot.className !== 'none' && <span className={`status-dot ${dot.className}`} aria-hidden />}
      </div>
      <div className="card-line">
        <Folder aria-hidden />
        <span className="card-text">{lines.place}</span>
      </div>
      <div className="card-line">
        <Bot aria-hidden />
        <span className="card-text">{lines.status}</span>
      </div>
      {machine && (
        <div className="card-line">
          <Monitor aria-hidden />
          <span className="card-text">Runs on {machine}</span>
        </div>
      )}
      {lines.note && (
        <div className="card-line card-muted">
          <CornerDownRight aria-hidden />
          <span className="card-text">{lines.note}</span>
        </div>
      )}
      {lineage && <LineageLine lineage={lineage} />}
      {hasBranch && (
        <>
          <div className="menu-sep" role="separator" />
          <div className="card-line card-copy">
            <GitBranch aria-hidden />
            <code className="card-text" title={lines.branch!}>{lines.branch}</code>
            <CopyButton value={lines.branch!} label="branch name" />
          </div>
          {tree?.host && (
            <div className="card-line card-muted">
              <Users aria-hidden />
              <span className="card-text">{guestWhere(tree.host)}</span>
            </div>
          )}
          {tree && <ChangesLine session={session} />}
          <RequestLines sessionId={session.id} withOwn />
        </>
      )}
      {/* No branch of its own (a lead with no project): the requests of the sessions it brought in, under the heading. */}
      {!hasBranch && broughtIn && (
        <>
          <div className="menu-sep" role="separator" />
          <RequestLines sessionId={session.id} withOwn={false} />
        </>
      )}
      {/* Its worktree, opened where the work is done (Matt, 2026-11-19). Not for one that was discarded. */}
      {tree && (
        <>
          <div className="menu-sep" role="separator" />
          <CardOpenIn scope={session.id} />
        </>
      )}
      <div className="menu-sep" role="separator" />
      <div className="card-line card-muted">
        <Clock aria-hidden />
        <time dateTime={new Date(lines.at).toISOString()} title={new Date(lines.at).toLocaleString(undefined, FULL_DATE)}>{lines.when}</time>
      </div>
    </>
  );
}
