// A ticket named in the user's own message, taken up in the session (docs/designs/tickets.md, section
// 6; the rule is shared/ticket-mention.ts). Raised by Kestrel only, never by an agent:
// - attach: the one free ticket named is taken up at once, and the line says so with Undo (the ticket
//   comes off and the tag goes; a status move made meanwhile stays).
// - elsewhere: the one ticket named is under way in another session; the line names it, with a link.
// - pick: several were named; a card asks which, never holding the work up. None attaches nothing.
import type { Ticket } from '../shared/tickets.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export const TICKET_WORK_KIND = 'ticket-work';

/** The most tickets a pick card offers; the rest are left to Work this ticket. */
export const MAX_PICK = 3;

export interface TicketWorkDeps {
  /** Take the ticket up here: attach, tag, and (not waited for) give the agent the ticket and propose In progress. */
  attach(sessionId: string, key: string, from: 'message' | 'pick'): Promise<Ticket>;
  detach(sessionId: string, key: string): Promise<void>;
  /** A session's title, for the line that names it. */
  titleOf(sessionId: string): Promise<string | null>;
}

type Payload = { mode: 'attach'; key: string; ref: string } | { mode: 'elsewhere'; key: string; ref: string; session: string } | { mode: 'pick'; tickets: { key: string; ref: string }[] };

const attachedLine = (ref: string) => `Working on ${ref} in this session`;

export function ticketWorkKind(deps: TicketWorkDeps): SuggestionKind {
  return {
    kind: TICKET_WORK_KIND,
    dismiss: 'none',
    kestrelOnly: true,
    async propose(_ctx, raw): Promise<Proposal> {
      const p = raw as Payload;
      if (p.mode === 'attach') return { type: 'show', draft: { title: `Work on ${p.ref} here?`, payload: p, buttons: [{ id: 'attach', label: 'Work on it', primary: true }] }, apply: 'attach' };
      if (p.mode === 'elsewhere') return { type: 'show', draft: { title: `${p.ref} is under way elsewhere`, payload: p, buttons: [{ id: 'ok', label: 'OK', primary: true }] }, apply: 'ok' };
      const tickets = p.tickets.slice(0, MAX_PICK);
      return {
        type: 'show',
        draft: {
          title: 'Which ticket is this work for?',
          reason: `Your message names ${tickets.map((t) => t.ref).join(', ')}. The one picked is attached to this session.`,
          payload: { mode: 'pick', tickets },
          buttons: [...tickets.map((t, i) => ({ id: `t${i}`, label: t.ref, ...(i === 0 ? { primary: true } : {}) })), { id: 'none', label: 'None' }],
        },
      };
    },
    async press(ctx, suggestion, button): Promise<Pressed> {
      const p = suggestion.payload as Payload;
      if (button === 'none') return { state: 'dismissed', line: 'No ticket taken up' };
      if (p.mode === 'elsewhere') {
        const title = await deps.titleOf(p.session);
        return { state: 'answered', line: `${p.ref} is under way in “${title ?? 'another session'}”, so it stays there`, opens: p.session };
      }
      const picked = p.mode === 'attach' ? (button === 'attach' ? p : null) : p.tickets[Number(button.slice(1))];
      if (!picked || (p.mode === 'pick' && !/^t\d$/.test(button))) throw new Error(`A ticket-work suggestion has no button "${button}".`);
      await deps.attach(ctx.sessionId, picked.key, p.mode === 'pick' ? 'pick' : 'message');
      return { state: 'answered', line: attachedLine(picked.ref), undo: { key: picked.key, ref: picked.ref } };
    },
    async undo(ctx, suggestion): Promise<string> {
      const { key, ref } = suggestion.undo as { key: string; ref: string };
      await deps.detach(ctx.sessionId, key);
      return `${ref} is no longer this session’s ticket`;
    },
  };
}
