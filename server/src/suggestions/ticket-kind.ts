// A change to the session's ticket, as an optional action (docs/designs/tickets.md, section 7): move it
// to In progress or In review, or add a comment. Proposed by the agent through `ticket_update`, and by
// Kestrel itself when work on a ticket starts. It never blocks: the turn goes on whatever the user does.
//
// Allow makes the change; Allow always makes it and keeps that answer for this kind of change on this
// tracker; Deny leaves the ticket; Don't ask again leaves it and keeps that answer. The × is Deny. The
// standing answers are listed in Settings → Tickets, where each can be set back to Ask. A move made
// (asked or not) is said in the conversation with Undo, which moves it back the same way; a comment has
// no Undo, as a posted comment cannot be taken back from here. Every move goes through `moveTicket`.
import { alreadyAtOrPast, answerSourceOf, isTicketChange, MAX_TICKET_COMMENT, standingAnswer, TICKET_CHANGE_LABEL, type TicketChange } from '../shared/ticket-changes.ts';
import type { Ticket } from '../shared/tickets.ts';
import type { TicketMoved } from '../tickets/move.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export const TICKET_KIND = 'ticket';

/** What the kind needs of the tickets: the session's ticket, and the changes, each through `moveTicket` or the source. */
export interface TicketKindDeps {
  /** The ticket the session works on, or why it has none Kestrel can change (tickets off, none attached, its tracker not connected). */
  ticketOf(sessionId: string): Promise<Ticket | { reason: string }>;
  /** Move the ticket to the tracker's first status of that category. Throws a `Refused` with the tracker's reason. */
  moveTo(key: string, category: Exclude<TicketChange, 'comment'>): Promise<TicketMoved>;
  /** Move it back to the status named (Undo). */
  moveBack(key: string, to: string): Promise<TicketMoved>;
  /** Add the comment. Throws a `Refused` with the tracker's reason. */
  comment(key: string, body: string): Promise<void>;
}

const BUTTONS = [
  { id: 'allow', label: 'Allow', primary: true },
  { id: 'always', label: 'Allow always' },
  { id: 'deny', label: 'Deny' },
  { id: 'never', label: 'Don’t ask again' },
];

const MAX_SHOWN = 280;
const clip = (text: string): string => (text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function draftOf(ticket: Ticket, change: TicketChange, body: string, reason: string, once: string) {
  const payload = { change, key: ticket.key, ref: ticket.ref, source: ticket.source, ...(body ? { body } : {}), ...(once ? { once } : {}) };
  if (change === 'comment') return { title: `Comment on ${ticket.ref}?`, reason: clip(body), payload, buttons: BUTTONS };
  const to = change === 'in-progress' ? 'In progress' : 'In review';
  return { title: `Move ${ticket.ref} to ${to}?`, reason: reason || `It is ${ticket.status.name} now.`, payload, buttons: BUTTONS };
}

export function ticketKind(deps: TicketKindDeps): SuggestionKind {
  return {
    kind: TICKET_KIND,
    dismiss: 'deny',
    async propose(ctx, payload): Promise<Proposal> {
      const change = payload.change;
      if (!isTicketChange(change)) return { type: 'refuse', reason: 'change must be "in-progress", "in-review" or "comment". Nothing else about a ticket is changed from here.' };
      const body = str(payload.body);
      if (change === 'comment' && !body) return { type: 'refuse', reason: 'Give the comment to add, as body.' };
      if (body.length > MAX_TICKET_COMMENT) return { type: 'refuse', reason: `A comment is at most ${MAX_TICKET_COMMENT} characters.` };
      const ticket = await deps.ticketOf(ctx.sessionId);
      if ('reason' in ticket) return { type: 'refuse', reason: ticket.reason };
      if (change !== 'comment' && alreadyAtOrPast(ticket.status.category, change)) return { type: 'skip', text: `${ticket.ref} is already ${ticket.status.name}, so nothing was proposed. Carry on.` };
      const standing = standingAnswer(await ctx.prefs.ticketAnswers(), change, ticket.source);
      if (standing === 'never') return { type: 'skip', text: `The user chose not to be asked to ${TICKET_CHANGE_LABEL[change].toLowerCase()} on this tracker. Leave ${ticket.ref} as it is and carry on.` };
      // `once` names a moment (a pull request, the work finished): proposed once for the ticket, whatever was answered.
      const once = str(payload.once);
      const earlier = ctx.messages.flatMap((m) => (m.suggestion?.kind === TICKET_KIND && m.suggestion.payload.change === change && m.suggestion.payload.key === ticket.key ? [m.suggestion] : []));
      const same = once ? earlier.filter((e) => e.payload.once === once) : earlier;
      if (once && same.length > 0) return { type: 'skip', text: 'That was proposed once already. Carry on.' };
      if (same.some((e) => e.state === 'open')) return { type: 'skip', text: 'The user has already been asked about that. Carry on.' };
      return { type: 'show', draft: draftOf(ticket, change, body, str(payload.reason), once), ...(standing === 'always' ? { apply: 'allow' } : {}) };
    },
    async press(ctx, suggestion, button): Promise<Pressed> {
      const { change, key, ref, source, body } = suggestion.payload as { change: TicketChange; key: string; ref: string; source: string; body?: string };
      if (button === 'deny') return { state: 'dismissed', line: `Left ${ref} as it is` };
      if (button === 'never') {
        await ctx.prefs.setTicketAnswer(change, answerSourceOf(source), 'never');
        return { state: 'dismissed', line: `Left ${ref} as it is, and won’t ask again (Settings → Tickets)` };
      }
      if (button !== 'allow' && button !== 'always') throw new Error(`A ticket suggestion has no button "${button}".`);
      // The change first: when the tracker refuses, no standing answer is kept for it.
      let pressed: Pressed;
      if (change === 'comment') {
        await deps.comment(key, body ?? '');
        pressed = { state: 'answered', line: `Commented on ${ref}` };
      } else {
        const moved = await deps.moveTo(key, change);
        pressed = { state: 'answered', line: `Moved ${ref} to ${moved.to.name}`, undo: { from: moved.from.name } };
      }
      if (button === 'always') await ctx.prefs.setTicketAnswer(change, answerSourceOf(source), 'always');
      return pressed;
    },
    async undo(_ctx, suggestion): Promise<string> {
      const { key, ref } = suggestion.payload as { key: string; ref: string };
      const from = String(suggestion.undo?.from ?? '');
      const moved = await deps.moveBack(key, from);
      return `Moved ${ref} back to ${moved.to.name}`;
    },
  };
}
