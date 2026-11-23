// One ticket, as a page: its description, acceptance criteria and comments as the tracker has them,
// the sessions working on it, and one primary button, Work this ticket (docs/designs/tickets.md,
// sections 5 and 6). It reads the one copy the server pushed (`tickets`); opening it asks the server
// for the ticket's detail, which arrives in the same push. The project the work would start in is a
// route answer (`useResource`), so the button says where before it is clicked.
import { inlineText } from '@kestrel/server/markdown-text';
import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Play, RotateCcw } from 'lucide-react';
import { TicketActionsMenu } from '../components/TicketActionsMenu.tsx';
import { TicketStatus } from '../components/TicketStatus.tsx';
import { findTicket, linksOfTicket, withoutCriteria } from '@kestrel/server/tickets';
import { agoText } from '@kestrel/server/when';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { Markdown } from '../components/Markdown.tsx';
import { useResource } from '../data/resources.ts';
import { statusText } from '../labels.ts';
import { openSession, openView, opener } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { ticketLeadIn, workTicket } from '../tickets.ts';
import { useMinuteNow } from '../useNow.ts';
import { PageHeader } from './PageHeader.tsx';

/** The route's answer: the project the work would start in, or none. */
const asTarget = (raw: unknown): Sourced<{ projectId: string | null }> => {
  const projectId = typeof raw === 'object' && raw !== null ? (raw as { projectId?: unknown }).projectId : undefined;
  return ready({ projectId: typeof projectId === 'string' ? projectId : null });
};

function WorkingOn({ id }: { id: string }) {
  const links = useApp((s) => s.tickets.links);
  const sessions = useApp((s) => s.workspace?.sessions);
  const mine = linksOfTicket(id, links).flatMap((l) => (l.attachedTo === 'session' ? (sessions ?? []).filter((s) => s.id === l.id).map((s) => ({ session: s, role: l.role })) : []));
  if (mine.length === 0) return null;
  return (
    <section className="page-section">
      <h2>Sessions</h2>
      <ul className="ticket-sessions">
        {mine.map(({ session, role }) => (
          <li key={session.id}>
            <button type="button" className="review-project" {...opener((newTab) => openSession(session.id, newTab))}>
              {session.title}
            </button>
            <span className="quiet">
              {' '}
              · {role === 'lead' ? 'lead' : 'part'} · {statusText(session).toLowerCase()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Add a comment to the ticket in its tracker, as the user. It is sent when the button is clicked and
 * cannot be taken back from here, so the button names the tracker; the box empties once it is posted.
 */
function AddComment({ id, tracker }: { id: string; tracker: string }) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const post = async () => {
    if (!text.trim() || posting) return;
    setPosting(true);
    if (await actions.commentOnTicket(id, text)) setText('');
    setPosting(false);
  };
  return (
    <form
      className="ticket-add-comment"
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
    >
      <textarea
        className="form-control"
        value={text}
        rows={3}
        placeholder="Add a comment"
        aria-label={`Add a comment in ${tracker}`}
        disabled={posting}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
        }}
      />
      <div className="ticket-add-comment-actions">
        <button type="submit" className="secondary-button small" disabled={posting || !text.trim()}>
          <MessageSquarePlus aria-hidden /> {posting ? 'Posting…' : `Comment in ${tracker}`}
        </button>
      </div>
    </form>
  );
}

export function TicketPage({ id }: { id: string }) {
  const ticket = useApp((s) => findTicket(s.tickets, id));
  const dismissed = useApp((s) => s.tickets.dismissed.some((t) => t.key === id));
  // A closed ticket keeps its status control, to reopen it, and nothing else that starts or dismisses.
  const closedAt = useApp((s) => s.tickets.closed.find((t) => t.key === id)?.closedAt);
  const closed = closedAt !== undefined;
  const detail = useApp((s) => s.tickets.details[id]);
  const unread = useApp((s) => s.tickets.unread.includes(id));
  const leadId = useApp((s) => ticketLeadIn(s, id));
  const leadExists = Boolean(leadId);
  const target = useResource(`/api/tickets/project?key=${encodeURIComponent(id)}`, asTarget).value;
  const projectId = target.state === 'ready' ? target.value.projectId : null;
  const project = useApp((s) => (projectId ? s.workspace?.projects.find((p) => p.id === projectId) : undefined));
  const now = useMinuteNow();
  const [starting, setStarting] = useState(false);
  // Opening a ticket is reading it, and asks its tracker for what it says now.
  // Only on opening: a ticket marked unread by hand while its page is open stays unread.
  const unreadNow = useRef(unread);
  unreadNow.current = unread;
  useEffect(() => {
    if (unreadNow.current) void actions.markTicketsSeen([id], true);
  }, [id]);
  useEffect(() => {
    void actions.readTicket(id);
  }, [id]);
  if (!ticket)
    return (
      <div className="page column collection">
        <div className="empty">
          <h2>This ticket is no longer listed</h2>
          <p>It may have been closed or reassigned in its tracker.</p>
        </div>
      </div>
    );
  const work = async (newTab: boolean) => {
    if (leadExists && leadId) return openSession(leadId, newTab);
    setStarting(true);
    await workTicket(id, newTab);
    setStarting(false);
  };
  const line = [`${ticket.tracker} ${ticket.ref}`, ticket.project, ticket.priorityName && `${ticket.priorityName} priority`, ticket.sprint && ticket.sprint.name, ticket.updatedAt && `updated ${agoText(ticket.updatedAt, now)}`].filter(Boolean).join(' · ');
  return (
    <div className="page column collection review-page ticket-page">
      <div className="detail-intro">
        <PageHeader title={ticket.title} line={line} />
        <div className="detail-actions" role="group" aria-label="Ticket actions">
          {(!closed || leadExists) && (
            <button type="button" className="primary-button small" disabled={starting} {...opener((newTab) => void work(newTab))}>
              <Play aria-hidden /> {leadExists ? 'Open the work' : starting ? 'Starting…' : 'Work this ticket'}
            </button>
          )}
          <TicketStatus ticket={ticket} />
          {dismissed && !closed && (
            <button type="button" className="secondary-button small" onClick={() => void actions.dismissTickets([id], false)}>
              <RotateCcw aria-hidden /> Restore
            </button>
          )}
          <TicketActionsMenu ticket={ticket} onPage />
        </div>
        {!leadExists && !closed && (
          <p className="detail-action-note">
            {target.state !== 'ready' ? (
              'Finding the project it belongs to…'
            ) : project ? (
              <>
                Kestrel starts a lead session in{' '}
                <button type="button" className="review-project" {...opener((newTab) => openView({ kind: 'project', id: project.id }, newTab))}>
                  {project.name}
                </button>
                . The lead reads the ticket, coordinates the work, and stops at open pull requests.
              </>
            ) : (
              'The lead starts without a project and asks before moving the work to a project or delegating it.'
            )}
          </p>
        )}
        {dismissed && <p className="review-dismissed-note">This ticket is hidden from Waiting. Use Restore to bring it back.</p>}
        {closed && <p className="review-dismissed-note">Closed in {ticket.tracker} {agoText(closedAt, now)}. Change its status to reopen it.</p>}
      </div>
      <WorkingOn id={id} />
      <section className="page-section">
        <h2>Description</h2>
        {!detail || detail.state === 'loading' ? (
          <p className="quiet">Asking {ticket.tracker}…</p>
        ) : detail.state === 'unavailable' ? (
          <p className="quiet">Could not read it: {detail.reason}</p>
        ) : withoutCriteria(detail.value.description).trim() ? (
          <div className="prose review-body">
            {/* The criteria are shown on their own below, so not twice. */}
            <Markdown text={detail.value.criteria.length > 0 ? withoutCriteria(detail.value.description) : detail.value.description} />
          </div>
        ) : (
          <p className="quiet">No description.</p>
        )}
      </section>
      {detail?.state === 'ready' && detail.value.criteria.length > 0 && (
        <section className="page-section">
          <h2>Acceptance criteria</h2>
          <ul className="ticket-criteria">
            {detail.value.criteria.map((c, i) => (
              <li key={i}>{inlineText(c)}</li>
            ))}
          </ul>
        </section>
      )}
      {detail?.state === 'ready' && (
        <section className="page-section">
          <h2>
            Comments <span className="section-count">· {detail.value.comments.length}</span>
          </h2>
          {detail.value.comments.length === 0 ? (
            <p className="quiet">No comments.</p>
          ) : (
            <ul className="ticket-comments">
              {detail.value.comments.map((c, i) => (
                <li key={i}>
                  <div className="ticket-comment-head">
                    <strong>{c.author || 'Someone'}</strong> <span className="quiet">{c.at ? agoText(c.at, now) : ''}</span>
                  </div>
                  <div className="prose review-body">
                    <Markdown text={c.body} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <AddComment id={id} tracker={ticket.tracker} />
        </section>
      )}
    </div>
  );
}
