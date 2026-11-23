import { expect, test } from 'vitest';
import { SAMPLE_TICKET_COUNT, sampleDetail, sampleTicketCount, sampleTickets } from './fake.ts';

test('the sample ticket count is the usual one unless a whole number from 0 to 1000 is asked for', () => {
  expect(sampleTicketCount(undefined)).toBe(SAMPLE_TICKET_COUNT);
  expect(sampleTicketCount('80')).toBe(80);
  expect(sampleTicketCount('0')).toBe(0);
  expect(sampleTicketCount('1001')).toBe(SAMPLE_TICKET_COUNT);
  expect(sampleTicketCount('many')).toBe(SAMPLE_TICKET_COUNT);
});

test('a long sample list repeats the samples under keys of their own, each with a page', () => {
  const now = 1_000_000_000_000;
  const tickets = sampleTickets(now, 80);

  expect(tickets.length).toBe(80);
  expect(new Set(tickets.map((t) => t.key)).size).toBe(80);
  expect(sampleTickets(now, SAMPLE_TICKET_COUNT)).toEqual(sampleTickets(now));
  for (const ticket of tickets) expect(sampleDetail(ticket.ref, now), ticket.ref).not.toBeNull();
  expect(sampleDetail('NOPE-1', now)).toBe(null);
});
