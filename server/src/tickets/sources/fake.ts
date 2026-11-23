// SAMPLE tickets for the fake store and the demo: a believable sprint on a made-up Jira-like
// tracker, in the demo's Bellbird and Platform projects, and a few outside it. Scripted, so tests
// and the demo never reach a tracker. `fakeTicketSource` serves them through the same interface a
// real tracker does.
import { criteriaOf, type Ticket, type TicketComment, type TicketDetail, type TicketLink, type TicketMove } from '../../shared/tickets.ts';
import { ready, unavailable, type Sourced } from '../../shared/sourced.ts';
import type { TicketSource } from '../source.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPRINT = 'Sprint 24 · Checkout polish';

interface Sample {
  ref: string;
  title: string;
  project: string;
  status: Ticket['status'];
  priority: number;
  priorityName: string;
  sprint: string | null;
  updatedAgo: number;
  description: string;
  comments: { author: string; ago: number; body: string }[];
}

const SAMPLES: readonly Sample[] = [
  {
    ref: 'BELL-142',
    title: 'Cart total jumps while quantities are still changing',
    project: 'Bellbird',
    status: { name: 'To Do', category: 'todo' },
    priority: 2,
    priorityName: 'High',
    sprint: SPRINT,
    updatedAgo: 2 * HOUR_MS,
    description:
      'On a slow connection the cart total shows an old number for a moment after each quantity change, then jumps. Support has had four tickets about it this week.\n\nThe totals are recalculated on every keystroke, and an older answer can arrive after a newer one.\n\n## Acceptance criteria\n\n- The total never shows a number older than the last change\n- Typing a quantity quickly asks the API once, after the typing settles\n- The pricing API gives the same total the cart shows (Platform)\n- A test covers an older answer arriving last',
    comments: [
      { author: 'priya', ago: 5 * HOUR_MS, body: 'Reproduced with network throttling at Slow 4G. Screen recording in the support thread.' },
      { author: 'devon', ago: 3 * HOUR_MS, body: 'The pricing endpoint also rounds per line, the cart rounds the sum. Might be worth fixing both while we are in there.' },
    ],
  },
  {
    ref: 'PLAT-318',
    title: 'Price lookups miss the request cache for list prices',
    project: 'Platform',
    status: { name: 'In Progress', category: 'in-progress' },
    priority: 2,
    priorityName: 'High',
    sprint: SPRINT,
    updatedAgo: 6 * HOUR_MS,
    description: 'Every list-price lookup goes to the database even when the same SKU was asked for earlier in the request.\n\n## Acceptance criteria\n\n- Repeated lookups in one request hit the cache\n- Responses carry `X-Price-Cache` as the docs say',
    comments: [{ author: 'kim', ago: DAY_MS, body: 'p95 for /cart went from 180 ms to 410 ms since the list prices launched.' }],
  },
  {
    ref: 'BELL-139',
    title: 'Keep the draft when a session expires mid-checkout',
    project: 'Bellbird',
    status: { name: 'To Do', category: 'todo' },
    priority: 3,
    priorityName: 'Medium',
    sprint: SPRINT,
    updatedAgo: DAY_MS,
    description: 'When the session expires during checkout the address form is emptied.\n\n## Acceptance criteria\n\n- The address and the note survive a sign-in\n- The user lands back on the step they were on',
    comments: [],
  },
  {
    ref: 'DOCS-77',
    title: 'Document the X-Price-Cache header',
    project: 'Docs',
    status: { name: 'To Do', category: 'todo' },
    priority: 4,
    priorityName: 'Low',
    sprint: SPRINT,
    updatedAgo: 2 * DAY_MS,
    description: 'The pricing reference does not say what the header means or when it is absent.',
    comments: [],
  },
  {
    ref: 'PLAT-301',
    title: 'Retry webhook deliveries with backoff',
    project: 'Platform',
    status: { name: 'Backlog', category: 'todo' },
    priority: 3,
    priorityName: 'Medium',
    sprint: null,
    updatedAgo: 4 * DAY_MS,
    description: 'Deliveries that fail are dropped. Retry up to five times, doubling the wait.',
    comments: [],
  },
  {
    ref: 'BELL-120',
    title: 'Search: rank exact title matches first',
    project: 'Bellbird',
    status: { name: 'Backlog', category: 'todo' },
    priority: 4,
    priorityName: 'Low',
    sprint: null,
    updatedAgo: 9 * DAY_MS,
    description: 'Searching "bellbird mug" shows three tote bags before the mug.',
    comments: [],
  },
];

/** The sample tickets as they would be at `now`. Pure. */
export function sampleTickets(now: number): Ticket[] {
  return SAMPLES.map((s, index) => ({
    key: `fake:${s.ref}`,
    source: 'fake',
    tracker: 'Sample tracker',
    ref: s.ref,
    title: s.title,
    status: s.status,
    project: s.project,
    url: `https://tracker.example.com/browse/${s.ref}`,
    openedAt: now - s.updatedAgo - (index + 3) * DAY_MS,
    updatedAt: now - s.updatedAgo,
    priority: s.priority,
    priorityName: s.priorityName,
    assignee: 'you',
    sprint: s.sprint ? { name: s.sprint, current: true } : null,
  }));
}

/** A sample ticket's description and comments. Pure. */
export function sampleDetail(ref: string, now: number): TicketDetail | null {
  const sample = SAMPLES.find((s) => s.ref === ref);
  if (!sample) return null;
  return { description: sample.description, criteria: criteriaOf(sample.description), comments: sample.comments.map((c) => ({ author: c.author, at: now - c.ago, body: c.body })) };
}

/** The sample tracker's workflow, in its order: any status can move to any other. */
export const SAMPLE_STATUSES: readonly TicketMove[] = [
  { name: 'Backlog', category: 'todo' },
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'in-progress' },
  { name: 'In Review', category: 'in-review' },
  { name: 'Done', category: 'done' },
];

/** The sample tracker. A move or a comment is kept for as long as the server runs, so the list and the ticket's page show it. */
export function fakeTicketSource(now: () => number = Date.now): TicketSource {
  const moved = new Map<string, TicketMove>();
  const comments = new Map<string, TicketComment[]>();
  const current = (t: Ticket): Ticket => {
    const status = moved.get(t.key);
    return status ? { ...t, status } : t;
  };
  return {
    kind: 'fake',
    name: 'Sample tracker',
    // Open tickets only, as a tracker answers: one moved to Done leaves the list, and Kestrel asks its status.
    assignedToMe: async (): Promise<Sourced<Ticket[]>> => ready(sampleTickets(now()).map(current).filter((t) => t.status.category !== 'done')),
    status: async (ticket) => {
      const held = sampleTickets(now()).find((t) => t.key === ticket.key);
      return held ? ready(current(held).status) : unavailable(`${ticket.ref} is not one of the sample tickets`);
    },
    read: async (ticket) => {
      const detail = sampleDetail(ticket.ref, now());
      return detail ? ready({ ...detail, comments: [...detail.comments, ...(comments.get(ticket.key) ?? [])] }) : unavailable(`${ticket.ref} is not one of the sample tickets`);
    },
    statuses: async (ticket) => ready(SAMPLE_STATUSES.filter((s) => s.name !== ticket.status.name)),
    move: async (ticket, to) => {
      const status = SAMPLE_STATUSES.find((s) => s.name === to);
      if (!status) throw new Error(`The sample tracker has no status “${to}”.`);
      moved.set(ticket.key, status);
      return status;
    },
    comment: async (ticket, body) => {
      comments.set(ticket.key, [...(comments.get(ticket.key) ?? []), { author: 'You', at: now(), body }]);
    },
  };
}

/** The two newest samples are new to the user; the rest were looked at before, so a fresh demo shows a couple unread, as a real morning would. */
const NEW_SAMPLES: readonly string[] = ['BELL-142', 'PLAT-318'];

/** The keys of the samples the user has already looked at, to seed a data directory that has no read tickets yet. Pure. */
export function sampleSeenKeys(): string[] {
  return SAMPLES.filter((s) => !NEW_SAMPLES.includes(s.ref)).map((s) => `fake:${s.ref}`);
}

/** The workstream the sample workspace seeds for checkout latency (seed.ts), which works PLAT-318. */
export const SAMPLE_TICKET_WORKSTREAM = 'Checkout latency';

/** The tickets demo's tickets under way: BELL-120 is the sample workspace's "Make search feel instant" session's, and PLAT-318 the checkout latency workstream's (seed.ts), so both chips show. */
export function sampleTicketLinks(now: number, workstreams: readonly { id: string; name: string }[] = []): TicketLink[] {
  const checkout = workstreams.find((w) => w.name === SAMPLE_TICKET_WORKSTREAM);
  return [{ ticketKey: 'fake:BELL-120', attachedTo: 'session', id: 'search', role: 'lead', at: now }, ...(checkout ? [{ ticketKey: 'fake:PLAT-318', attachedTo: 'workstream' as const, id: checkout.id, role: 'lead' as const, at: now }] : [])];
}
