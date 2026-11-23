// A workstream's page: what the work is for, then the whole of it as one tree (Matt, 2026-11-20):
// the lead (the session the work was asked in) first, the sessions it brought in indented under
// it, each with its status, project and pull request as on any session list. At each level the
// sessions that need something or are working come first (`workstreamRows`). Who waits on whom,
// with the reason, is listed under the tree. The sessions are references: each row opens the
// session where it lives. Everything shown comes from the workspace in the store; only the
// objective being typed is local.
import { WorkstreamTicketChip } from '../components/TicketChip.tsx';
import { useWorkstreamTicket } from '../tickets.ts';
import { useMemo, useState } from 'react';
import type { SessionView, WorkspaceState } from '@kestrel/server/model';
import { orderSessions } from '@kestrel/server/session-order';
import { waitsIn, type ShownWait } from '@kestrel/server/waits';
import { isArchived, isComplete, workstreamRows, workstreamSummary, WORKSTREAM_OBJECTIVE_MAX } from '@kestrel/server/workstreams';
import { opener, openSession } from '../route.ts';
import { actions } from '../store.ts';
import { PageHeader } from './PageHeader.tsx';
import { WorkstreamColourPicker } from '../components/ColoursSetting.tsx';
import { SessionTable } from './SessionTable.tsx';

const NO_OBJECTIVE = 'No objective written yet.';

/** A session named in a wait: its title, opening it. */
function SessionLink({ id, members }: { id: string; members: readonly SessionView[] }) {
  const title = members.find((s) => s.id === id)?.title ?? id;
  return (
    <button type="button" className="link-button" {...opener((newTab) => openSession(id, newTab))}>
      {title}
    </button>
  );
}

/** One line of who waits on what: a session on the ones it started, or on another it named, with the reason. */
function WaitLine({ wait, members }: { wait: ShownWait; members: readonly SessionView[] }) {
  if (wait.kind === 'started')
    return (
      <p className="quiet workstream-wait">
        <SessionLink id={wait.waiterId} members={members} /> is waiting on {wait.count} session{wait.count === 1 ? '' : 's'} it started.
      </p>
    );
  return (
    <p className="quiet workstream-wait">
      <SessionLink id={wait.waiterId} members={members} /> is waiting on <SessionLink id={wait.targetId} members={members} />: {wait.reason}
    </p>
  );
}

/** The ticket the work is for, at the top, with its live status (tickets: section 7). */
function WorkstreamTicket({ id }: { id: string }) {
  const found = useWorkstreamTicket(id);
  if (!found) return null;
  return (
    <div className="workstream-ticket">
      <WorkstreamTicketChip workstreamId={id} />
    </div>
  );
}

/** The objective, read or edited in place. Saved when Save is pressed; Escape or Cancel leaves it as it was. */
function Objective({ id, objective }: { id: string; objective: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <div className="workstream-objective">
        <p className={objective ? undefined : 'quiet'}>{objective || NO_OBJECTIVE}</p>
        <button type="button" className="secondary-button small" onClick={() => setDraft(objective)}>
          {objective ? 'Edit' : 'Write one'}
        </button>
      </div>
    );
  const save = () => {
    if (draft.trim() !== objective) void actions.setWorkstreamObjective(id, draft);
    setDraft(null);
  };
  return (
    <div className="workstream-objective editing">
      <textarea
        autoFocus
        aria-label="Objective"
        value={draft}
        maxLength={WORKSTREAM_OBJECTIVE_MAX}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null);
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
        }}
      />
      <div className="workstream-objective-actions">
        <button type="button" className="primary-button small" onClick={save}>
          Save
        </button>
        <button type="button" className="secondary-button small" onClick={() => setDraft(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function WorkstreamPage({ id, workspace }: { id: string; workspace: WorkspaceState }) {
  // An archived one is out of the sidebar, but its page still opens (from Settings → Archived).
  const workstream = workspace.workstreams.find((w) => w.id === id) ?? workspace.archivedWorkstreams.find((w) => w.id === id);
  const members = useMemo((): SessionView[] => {
    const ids = new Set(workstream?.sessionIds ?? []);
    return orderSessions(workspace.sessions.filter((s) => ids.has(s.id)), 'recent', null);
  }, [workstream, workspace.sessions]);
  // The lead, then what it brought in, indented; what needs you or is working first at each level.
  const rows = useMemo(() => (workstream ? workstreamRows(workstream, workspace.links, members) : []), [workstream, workspace.links, members]);
  const tree = useMemo(() => rows.map((r) => r.session), [rows]);
  const depths = useMemo(() => new Map(rows.map((r) => [r.session.id, r.depth])), [rows]);
  const waits = useMemo(() => (workstream ? waitsIn(workstream, members, workspace.links, workspace.waits ?? []) : []), [workstream, members, workspace.links, workspace.waits]);
  if (!workstream)
    return (
      <div className="page column collection">
        <div className="empty">
          <h2>This workstream is gone</h2>
          <p>It was deleted, or every session in it was archived or deleted. The sessions it pointed at are where they were.</p>
        </div>
      </div>
    );
  return (
    <div className="page column collection">
      <PageHeader title={workstream.name} line={`Workstream · ${isComplete(workstream) ? 'Complete · ' : ''}${workstreamSummary(members)}. Each session stays in its own project.`} menu={{ kind: 'workstream', id }} mark={<WorkstreamColourPicker workstreamId={id} name={workstream.name} />} />
      {isArchived(workstream) && (
        <p className="workstream-archived" role="status">
          This workstream is archived: it is out of the sidebar, and its sessions are where they were. A new message in one of them brings it back.
          <button type="button" className="secondary-button small" onClick={() => void actions.archiveWorkstream(id, false)}>
            Restore workstream
          </button>
        </p>
      )}
      <WorkstreamTicket id={id} />
      <section className="page-section">
        <h2>Objective</h2>
        <Objective id={id} objective={workstream.objective} />
      </section>
      <section className="page-section">
        <h2>
          Sessions <span className="section-count">· {members.length}</span>
        </h2>
        {tree.length > 0 ? <SessionTable sessions={tree} workspace={workspace} showProject depths={depths} /> : <p className="quiet">No sessions.</p>}
      </section>
      {waits.length > 0 && (
        // Sessions waiting on other sessions: not on the user, so not under Needs you.
        <section className="page-section">
          <h2>
            Waiting on each other <span className="section-count">· {waits.length}</span>
          </h2>
          {waits.map((wait) => (
            <WaitLine key={wait.kind === 'started' ? `started-${wait.waiterId}` : `${wait.waiterId}>${wait.targetId}`} wait={wait} members={members} />
          ))}
        </section>
      )}
    </div>
  );
}
