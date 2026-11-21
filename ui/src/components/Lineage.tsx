// A session's lineage in its own conversation, each with a button to open the other session: at the
// top, the session it came from (CameFrom); where it happened, each session it started (StartedHere);
// at the end, only older ones with no such mark that are still going (Lineage).
// It never opens anything by itself; the button follows the usual click rules.
import { memo, useMemo } from 'react';
import type { ChatMessage, StartedSession } from '@kestrel/server/model';
import { linksAtEnd, markedStarts } from '@kestrel/server/conversation-ends';
import { ArrowLeft, ArrowRight, GitFork, Workflow } from 'lucide-react';
import { cameFromText } from '@kestrel/server/session-card';
import { dotClass, statusText } from '../labels.ts';
import { useApp } from '../store.ts';
import { opener, openSession } from '../route.ts';

// A fork is never marked in the conversation it came from, and never listed at its end (linksAtEnd); 'fork' is here for the type.
const STARTED_TEXT: Record<StartedSession['kind'], string> = { handoff: 'Handed off to', delegate: 'Delegated to', spawn: 'Started', fork: 'Forked as' };

/** One session this one started: what happened, where it is and how it stands now, and a button to open it. */
const StartedRow = memo(function StartedRow({ sessionId, kind }: StartedSession) {
  const child = useApp((s) => s.sessionsById.get(sessionId));
  const project = useApp((s) => (child ? s.workspace?.projects.find((p) => p.id === (child.landedIn ?? child.startedIn))?.name : undefined));
  // Deleted since: the row has nothing left to open or report.
  if (!child) return null;
  return (
    <div className="lineage-row">
      {kind === 'handoff' ? <ArrowRight aria-hidden /> : <Workflow aria-hidden />}
      <span className="lineage-text">
        <strong>
          {STARTED_TEXT[kind]} {child.title}
        </strong>
        <small>
          in {project ?? 'no project'} · <span className={`status-dot inline ${dotClass(child)}`} /> {statusText(child)}
        </small>
      </span>
      <button className="secondary-button" {...opener((newTab) => openSession(child.id, newTab))}>
        Open
      </button>
    </div>
  );
});

/** A session this one started, in the conversation at the point it started it (`ChatMessage.started`). */
export const StartedHere = memo(function StartedHere({ started }: { started: StartedSession }) {
  return (
    <div className="lineage lineage-inline" aria-label="A session this one started">
      <StartedRow {...started} />
    </div>
  );
});

/**
 * At the end of the conversation: only the sessions it started that have no mark in the
 * conversation (they were started before Kestrel marked them) and are not finished
 * (shared/conversation-ends.ts). Finished work does not stay under the conversation.
 */
export const Lineage = memo(function Lineage({ sessionId, messages }: { sessionId: string; messages: readonly ChatMessage[] }) {
  const links = useApp((s) => s.workspace?.links);
  const byId = useApp((s) => s.sessionsById);
  const marked = useMemo(() => markedStarts(messages), [messages]);
  const kids = useMemo(() => linksAtEnd(links ?? [], sessionId, marked, (id) => byId.get(id)?.state), [links, sessionId, marked, byId]);
  if (kids.length === 0) return null;
  return (
    <div className="lineage" aria-label="Sessions this one started that are still going">
      {kids.map((link) => (
        <StartedRow key={link.childId} sessionId={link.childId} kind={link.kind} />
      ))}
    </div>
  );
});

/** The session this one was handed off, delegated or forked from, at the top of its conversation. */
export const CameFrom = memo(function CameFrom({ sessionId }: { sessionId: string }) {
  const link = useApp((s) => s.workspace?.links.find((l) => l.childId === sessionId));
  const parent = useApp((s) => (link ? s.sessionsById.get(link.parentId) : undefined));
  const project = useApp((s) => (parent ? s.workspace?.projects.find((p) => p.id === (parent.landedIn ?? parent.startedIn))?.name : undefined));
  if (!link || !parent) return null;
  return (
    <div className="lineage lineage-from" aria-label="The session this one came from">
      <div className="lineage-row">
        {link.kind === 'handoff' ? <ArrowLeft aria-hidden /> : link.kind === 'fork' ? <GitFork aria-hidden /> : <Workflow aria-hidden />}
        <span className="lineage-text">
          <strong>{cameFromText(link.kind, parent.title)}</strong>
          <small>
            in {project ?? 'no project'} · <span className={`status-dot inline ${dotClass(parent)}`} /> {statusText(parent)}
          </small>
        </span>
        <button className="secondary-button" {...opener((newTab) => openSession(parent.id, newTab))}>
          Open
        </button>
      </div>
    </div>
  );
});
