// Which ticket a user's message names, and what that does to the session. Pure.
import { describe, expect, it } from 'vitest';
import { sampleTickets } from '../tickets/sources/fake.ts';
import { namesTicket, ticketMention, type MentionSituation } from './ticket-mention.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const tickets = sampleTickets(NOW);
const at = (over: Partial<MentionSituation> = {}): MentionSituation => ({ sessionId: 'me', tickets, links: [], workstreams: [], liveSessions: new Set(['me', 'other']), ...over });

describe('namesTicket', () => {
  const t = { ref: 'PLAT-12', url: 'https://tracker.example.com/browse/PLAT-12' };
  it('takes the key standing alone, in any case, and the link however it is written', () => {
    expect(namesTicket('fix PLAT-12 please', t)).toBe(true);
    expect(namesTicket('fix plat-12.', t)).toBe(true);
    expect(namesTicket('see http://Tracker.example.com/browse/PLAT-12/ for it', t)).toBe(true);
    expect(namesTicket('see <https://tracker.example.com/browse/PLAT-12>', t)).toBe(true);
  });
  it('does not take a longer key, a key inside a word, or another link', () => {
    expect(namesTicket('PLAT-123', t)).toBe(false);
    expect(namesTicket('XPLAT-12', t)).toBe(false);
    expect(namesTicket('PLAT-12-old', t)).toBe(false);
    expect(namesTicket('https://tracker.example.com/browse/PLAT-121', t)).toBe(false);
    expect(namesTicket('repo/PLAT-12', t)).toBe(false);
  });
});

describe('ticketMention', () => {
  it('attaches the one free ticket named, and does nothing for none', () => {
    expect(ticketMention('Work on BELL-139', at())).toMatchObject({ type: 'attach', ticket: { ref: 'BELL-139' } });
    expect(ticketMention('Tidy the README', at())).toEqual({ type: 'none' });
  });
  it('keeps the ticket a session already has, its own or its workstream’s', () => {
    expect(ticketMention('also BELL-139', at({ links: [{ ticketKey: 'fake:BELL-142', attachedTo: 'session', id: 'me', role: 'lead', at: NOW }] }))).toEqual({ type: 'keeps' });
    expect(ticketMention('also BELL-139', at({ workstreams: [{ id: 'w', sessionIds: ['me'] }], links: [{ ticketKey: 'fake:BELL-142', attachedTo: 'workstream', id: 'w', role: 'lead', at: NOW }] }))).toEqual({ type: 'keeps' });
  });
  it('names the session a ticket is under way in, and ignores one that is gone', () => {
    const links = [{ ticketKey: 'fake:BELL-139', attachedTo: 'session' as const, id: 'other', role: 'lead' as const, at: NOW }];
    expect(ticketMention('BELL-139', at({ links }))).toMatchObject({ type: 'elsewhere', sessionId: 'other' });
    expect(ticketMention('BELL-139', at({ links, liveSessions: new Set(['me']) }))).toMatchObject({ type: 'attach' });
  });
  it('offers a pick when several are named', () => {
    const v = ticketMention('BELL-139 and https://tracker.example.com/browse/DOCS-77', at());
    expect(v.type === 'several' && v.tickets.map((t) => t.ref).sort()).toEqual(['BELL-139', 'DOCS-77']);
  });
});
