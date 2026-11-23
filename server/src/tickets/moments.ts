// The moments Kestrel itself proposes a change to a ticket (docs/designs/tickets.md, section 8), beside
// the start of work (In progress): a pull request opened from work on the ticket (a comment with its
// link, and In review), and the lead finishing (a comment with a short summary). Each goes through the
// `ticket` card and the same standing answers, once per ticket and moment (`once`), never to done. Pure.
import { MAX_TICKET_COMMENT, type TicketChange } from '../shared/ticket-changes.ts';
import type { RequestLink, SessionState } from '../model.ts';

export interface TicketProposal {
  change: TicketChange;
  body?: string;
  reason: string;
  once: string;
}

/** The longest summary proposed when the lead finishes; the lead's report is cut there. */
export const MAX_SUMMARY = 1500;

/** The `once` of the summary: one per ticket. */
export const FINISHED_ONCE = 'finished';

/** A pull request opened: a comment with its link, then In review. Nothing for one already closed or merged. */
export function pullRequestProposals(link: Pick<RequestLink, 'url' | 'state'>): TicketProposal[] {
  if (link.state !== 'open' && link.state !== 'draft') return [];
  const once = `pr:${link.url}`;
  return [
    { change: 'comment', body: `Pull request: ${link.url}`, reason: 'A pull request was opened for this ticket.', once },
    { change: 'in-review', reason: `A pull request was opened: ${link.url}`, once },
  ];
}

/** The work under a ticket's lead, as far as whether it is finished. */
export interface LeadWork {
  /** The lead and every session of its workstream, with their states. */
  sessions: readonly { id: string; state: SessionState }[];
  /** Pull requests linked to any of them. */
  requests: number;
  /** The lead's last message: its report. */
  report: string;
}

/** The lead has finished: a turn ended, nothing under it is working or waiting on the user, and it stopped at pull requests. Then a comment with the start of its report. */
export function finishedProposal(work: LeadWork): TicketProposal | null {
  if (work.requests === 0) return null;
  if (work.sessions.some((s) => s.state === 'running' || s.state === 'attention')) return null;
  const report = work.report.trim();
  if (!report) return null;
  const limit = Math.min(MAX_SUMMARY, MAX_TICKET_COMMENT);
  const body = report.length > limit ? `${report.slice(0, limit - 1).trimEnd()}…` : report;
  return { change: 'comment', body, reason: 'The lead reports the work is finished.', once: FINISHED_ONCE };
}
