// Desktop notifications (shared/notifications.ts, notifications/*): which changes of status the
// user is told about, in what words, and the settings.
import { describe, expect, it } from 'vitest';
import { notificationsRoute } from './notifications/api.ts';
import { NotifyPrefsStore } from './notifications/prefs.ts';
import { deskOnlyEvent, NOTHING_SEEN, notificationsOf, silentReason, tellsSomehow, bannerProblem, DEFAULT_NOTIFY, NOTIFY_KIND_LABEL, notifies, notifyEvents, notifyProblem, parseTarget, reviewNotifyEvents, sanitizeNotify, targetOf, ticketNotifyEvents, ticketsBefore, type Looking } from './shared/notifications.ts';

type S = Parameters<typeof notifyEvents>[1][number];
const session = (id: string, state: S['state'], note = '', extra: Partial<S> = {}): S => ({ id, title: `Session ${id}`, state, note, ...extra });
const AWAY: Looking = { focused: false, openSessionId: null };
const told = (before: S[] | null, after: S[], opts: { links?: { childId: string; kind: 'delegate' | 'handoff' | 'fork' }[]; prefs?: typeof DEFAULT_NOTIFY; looking?: Looking } = {}) =>
  notifyEvents(before, after, opts.links ?? [], opts.prefs ?? DEFAULT_NOTIFY, opts.looking ?? AWAY).map((e) => [e.kind, e.sessionId, e.body]);

describe('what the user is told about', () => {
  it('a working session that finishes, fails, or needs an answer', () => {
    const before = [session('a', 'running'), session('b', 'running'), session('c', 'running'), session('d', 'running')];
    const after = [session('a', 'done'), session('b', 'attention', 'Failed · The build broke'), session('c', 'attention', 'Needs you · Run pnpm install?'), session('d', 'done', '', { request: 'open' })];
    expect(told(before, after)).toEqual([
      ['done', 'a', 'Finished.'],
      ['failed', 'b', 'Failed · The build broke'],
      ['needs-you', 'c', 'Needs you · Run pnpm install?'],
      ['done', 'd', 'Finished. Its pull request is ready to review.'],
    ]);
  });

  it('nothing on the first push, for a new session, for one that did not change, or one the user stopped', () => {
    const working = session('a', 'running');
    expect(told(null, [session('a', 'done')])).toEqual([]);
    expect(told([], [session('a', 'done')])).toEqual([]);
    expect(told([working], [working])).toEqual([]);
    expect(told([working], [session('a', 'done', '', { stopped: true })])).toEqual([]);
    expect(told([working], [session('a', 'interrupted')])).toEqual([]);
    expect(told([session('a', 'done')], [session('a', 'done', 'renamed')])).toEqual([]);
  });

  it('a session that asks again after it was answered, but not one still waiting on the same thing', () => {
    const asking = session('a', 'attention', 'Needs you · Approve?');
    expect(told([asking], [session('a', 'attention', 'Needs you · Approve?')])).toEqual([]);
    expect(told([session('a', 'done')], [asking])).toEqual([['needs-you', 'a', 'Needs you · Approve?']]);
  });

  it('not the session in front of a focused window, but that one when the window is in the background', () => {
    const before = [session('a', 'running')];
    const after = [session('a', 'done')];
    expect(told(before, after, { looking: { focused: true, openSessionId: 'a' } })).toEqual([]);
    expect(told(before, after, { looking: { focused: true, openSessionId: 'b' } })).toHaveLength(1);
    expect(told(before, after, { looking: { focused: false, openSessionId: 'a' } })).toHaveLength(1);
  });

  it('not a delegate’s finish, which is its orchestrator’s news; its failure and its question still', () => {
    const links = [{ childId: 'a', kind: 'delegate' as const }, { childId: 'b', kind: 'delegate' as const }, { childId: 'c', kind: 'handoff' as const }];
    const before = [session('a', 'running'), session('b', 'running'), session('c', 'running')];
    const after = [session('a', 'done'), session('b', 'attention', 'Needs you · Approve?'), session('c', 'done')];
    expect(told(before, after, { links }).map(([kind, id]) => [kind, id])).toEqual([['needs-you', 'b'], ['done', 'c']]);
  });

  it('only the events switched on', () => {
    const prefs = { ...DEFAULT_NOTIFY, events: { 'needs-you': true, failed: false, done: false, 'review-request': false, ticket: false, 'pull-request': false } };
    const before = [session('a', 'running'), session('b', 'running')];
    expect(told(before, [session('a', 'done'), session('b', 'attention', 'Needs you · ?')], { prefs }).map(([kind]) => kind)).toEqual(['needs-you']);
  });

  it('clips a long note', () => {
    const [event] = told([session('a', 'running')], [session('a', 'attention', `Failed · ${'x'.repeat(300)}`)]);
    expect(event![2]).toHaveLength(140);
  });
});

describe('the settings', () => {
  it('are on for all three with no sound until changed, and say when nothing is on', () => {
    expect(DEFAULT_NOTIFY).toEqual({ enabled: true, banner: true, sound: 'none', events: { 'needs-you': true, failed: true, done: true, 'review-request': true, ticket: true, 'pull-request': true } });
    expect(notifies(DEFAULT_NOTIFY)).toBe(true);
    expect(notifies({ ...DEFAULT_NOTIFY, banner: false })).toBe(false);
    expect(notifies({ ...DEFAULT_NOTIFY, banner: false, sound: 'ping' })).toBe(true);
    expect(notifies({ ...DEFAULT_NOTIFY, events: { 'needs-you': false, failed: false, done: false, 'review-request': false, ticket: false, 'pull-request': false } })).toBe(false);
  });

  it('refuse what they cannot use, with the reason, and read back anything unreadable as the default', () => {
    expect(notifyProblem(DEFAULT_NOTIFY)).toBeNull();
    expect(notifyProblem({ ...DEFAULT_NOTIFY, sound: 'gong' })).toBe('sound must be one of: none, chime, ping, pop.');
    expect(notifyProblem({ banner: 'yes', sound: 'none', events: {} })).toBe('banner must be true or false.');
    expect(notifyProblem({ banner: true, sound: 'none', events: { done: true } })).toMatch(/events must say true or false/);
    expect(sanitizeNotify({ banner: false, sound: 'gong', events: { done: false } })).toEqual({ enabled: true, banner: false, sound: 'none', events: { 'needs-you': true, failed: true, done: false, 'review-request': true, ticket: true, 'pull-request': true } });
  });

  it('are served and stored over HTTP', async () => {
    const store = new NotifyPrefsStore();
    const route = (method: string, body: Record<string, unknown> = {}) => notificationsRoute(['api', 'notifications'], method, async () => body, store);
    expect(await route('GET')).toEqual({ status: 200, body: { prefs: DEFAULT_NOTIFY } });
    expect(await route('PUT', { banner: true })).toMatchObject({ status: 400 });
    const quiet = { banner: false, sound: 'chime', events: { 'needs-you': true, failed: true, done: false, 'review-request': true, ticket: true, 'pull-request': true } };
    expect(await route('PUT', quiet)).toEqual({ status: 200, body: { prefs: { enabled: true, ...quiet } } });
    expect(await store.prefs()).toEqual({ enabled: true, ...quiet });
    expect(await notificationsRoute(['api', 'other'], 'GET', async () => ({}), store)).toBeNull();
  });
});

describe('a banner the system refused', () => {
  it('says what to do in the installed app, and that a copy run from a checkout cannot show one', () => {
    expect(bannerProblem('The operation couldn’t be completed. (UNErrorDomain error 1.)', true)).toBe('macOS is not letting Kestrel show notifications. Allow them in System Settings → Notifications → Kestrel, then send a test.');
    expect(bannerProblem('The operation couldn’t be completed. (UNErrorDomain error 1.)', false)).toContain('this copy of Kestrel is run from a checkout, which is not signed');
    expect(bannerProblem('no answer', true)).toBe('macOS did not show the notification (no answer). Check System Settings → Notifications → Kestrel.');
    expect(bannerProblem('unsupported', true)).toBe('This computer cannot show notifications; a sound still plays.');
  });
});


describe('being asked to review a pull request (0.0.23)', () => {
  const request = (key: string, more: Record<string, unknown> = {}) => ({ key, host: 'github' as const, hostName: 'github.com', repository: 'acme/shop', number: 12, title: 'Faster checkout', author: 'sam', url: 'https://github.com/acme/shop/pull/12', updatedAt: 0, projectId: null, ...more });
  const view = (keys: string[], unread: string[] = keys) => ({ requests: keys.map((key) => request(key)), unread });

  it('is one of the things "Tell me when" lists, on unless switched off, and worded as the user speaking', () => {
    expect(NOTIFY_KIND_LABEL['review-request']).toBe('I’m asked to review a pull request');
    expect(DEFAULT_NOTIFY.events['review-request']).toBe(true);
    // Settings saved before 0.0.23 have no word about it: it is on.
    expect(sanitizeNotify({ banner: true, sound: 'none', events: { 'needs-you': true, failed: true, done: true } }).events['review-request']).toBe(true);
  });

  it('tells of a request that was not waiting before, naming who asked and where it is', () => {
    const after = { requests: [request('a'), request('b', { requestedBy: 'robin', number: 40, title: 'Tidy the cart' })], unread: ['a', 'b'] };
    expect(reviewNotifyEvents(['a'], after, DEFAULT_NOTIFY)).toEqual([{ kind: 'review-request', sessionId: '', requestKey: 'b', title: 'Tidy the cart', body: 'robin asked you to review shop #40.' }]);
    expect(reviewNotifyEvents([], view(['a']), DEFAULT_NOTIFY)[0]!.body).toBe('You were asked to review shop #12.');
  });

  it('says nothing about what was already waiting when Kestrel opened', () => {
    expect(reviewNotifyEvents(null, view(['a', 'b']), DEFAULT_NOTIFY)).toEqual([]);
  });

  it('says nothing about a request already read, one still waiting from before, or with the event off', () => {
    expect(reviewNotifyEvents(['a'], view(['a', 'b'], []), DEFAULT_NOTIFY)).toEqual([]);
    expect(reviewNotifyEvents(['a', 'b'], view(['a', 'b']), DEFAULT_NOTIFY)).toEqual([]);
    const off = { ...DEFAULT_NOTIFY, events: { ...DEFAULT_NOTIFY.events, 'review-request': false } };
    expect(reviewNotifyEvents([], view(['a']), off)).toEqual([]);
  });

  it('a banner’s click goes to the request’s page, a session’s to the session', () => {
    const [event] = reviewNotifyEvents([], view(['github.com/acme/shop#12']), DEFAULT_NOTIFY);
    expect(targetOf(event!)).toBe('review:github.com/acme/shop#12');
    expect(parseTarget('review:github.com/acme/shop#12')).toEqual({ requestKey: 'github.com/acme/shop#12' });
    expect(parseTarget('s1')).toEqual({ sessionId: 's1' });
    expect(parseTarget('')).toBeNull();
  });
});

describe('told, or never told (0.0.23)', () => {
  const working = [{ id: 'a', title: 'A', state: 'running' as const, note: '' }];
  const done = [{ id: 'a', title: 'A', state: 'done' as const, note: '' }];
  const off = { ...DEFAULT_NOTIFY, enabled: false };

  it('is on unless turned off, and settings saved before it existed are on', () => {
    expect(DEFAULT_NOTIFY.enabled).toBe(true);
    expect(sanitizeNotify({ banner: true, sound: 'none', events: {} }).enabled).toBe(true);
    expect(sanitizeNotify({ enabled: false }).enabled).toBe(false);
    expect(notifyProblem({ ...DEFAULT_NOTIFY, enabled: 'no' })).toBe('enabled must be true or false.');
  });

  it('off tells the user nothing, and keeps what was ticked for when it is on again', () => {
    expect(notifies(off)).toBe(false);
    expect(notifyEvents(working, done, [], off, { focused: false, openSessionId: null })).toEqual([]);
    expect(reviewNotifyEvents([], { requests: [], unread: [] }, off)).toEqual([]);
    expect(notifyEvents(working, done, [], DEFAULT_NOTIFY, { focused: false, openSessionId: null })).toHaveLength(1);
    expect(sanitizeNotify(off).events).toEqual(DEFAULT_NOTIFY.events);
  });

  it('the two ways to tell are a notification and a sound; with neither, the page says nothing will', () => {
    expect(tellsSomehow({ banner: true, sound: 'none' })).toBe(true);
    expect(tellsSomehow({ banner: false, sound: 'ping' })).toBe(true);
    expect(tellsSomehow({ banner: false, sound: 'none' })).toBe(false);
    expect(silentReason({ ...DEFAULT_NOTIFY, banner: false })).toBe('Nothing will tell you: turn on the desktop notification or pick a sound.');
    expect(silentReason({ ...DEFAULT_NOTIFY, events: { 'needs-you': false, failed: false, done: false, 'review-request': false, ticket: false, 'pull-request': false } })).toMatch(/Nothing is ticked/);
    expect(silentReason(DEFAULT_NOTIFY)).toBeNull();
    // Turned off on purpose is not a mistake to point out.
    expect(silentReason({ ...off, banner: false })).toBeNull();
  });
});

describe('a ticket newly assigned', () => {
  const t = (ref: string, source = 'fake') => ({ key: `${source}:${ref}`, source, tracker: 'Sample tracker', ref, title: `Do ${ref}`, status: { name: 'To Do', category: 'todo' as const }, project: 'Shop', url: '', openedAt: 0, updatedAt: 0, sprint: { name: 'Sprint 24', current: true } });
  const view = (tickets: ReturnType<typeof t>[], opts: { unread?: string[]; sources?: string[]; on?: boolean } = {}) => ({
    tickets,
    unread: opts.unread ?? tickets.map((x) => x.key),
    sources: opts.sources ?? [...new Set(tickets.map((x) => x.source))],
    settings: { on: opts.on ?? true, off: [], show: 'page' as const },
  });

  it('is told once, opening the ticket’s page, when a source already asked lists a new unread ticket', () => {
    const before = ticketsBefore(view([t('A-1')]));
    const [event, ...rest] = ticketNotifyEvents(before, view([t('A-1'), t('A-2')]), DEFAULT_NOTIFY);
    expect(rest).toEqual([]);
    expect(event).toEqual({ kind: 'ticket', sessionId: '', ticketKey: 'fake:A-2', title: 'A-2: Do A-2', body: 'Assigned to you in Sample tracker, in Sprint 24.' });
    expect(parseTarget(targetOf(event!))).toEqual({ ticketKey: 'fake:A-2' });
    expect(ticketNotifyEvents(ticketsBefore(view([t('A-1'), t('A-2')])), view([t('A-1'), t('A-2')]), DEFAULT_NOTIFY)).toEqual([]);
  });

  it('is not told on the first push, when tickets or a source are first turned on, while off, for a read or dismissed ticket, or with the event off', () => {
    expect(ticketNotifyEvents(null, view([t('A-1')]), DEFAULT_NOTIFY)).toEqual([]);
    // Tickets turned on: the list fills from sources not asked before.
    expect(ticketNotifyEvents(ticketsBefore(view([])), view([t('A-1'), t('A-2')]), DEFAULT_NOTIFY)).toEqual([]);
    // A second source switched on: its tickets are not news; the first source's new one is.
    const before = ticketsBefore(view([t('A-1')]));
    expect(ticketNotifyEvents(before, view([t('A-1'), t('A-2'), t('J-1', 'jira')]), DEFAULT_NOTIFY).map((e) => e.ticketKey)).toEqual(['fake:A-2']);
    expect(ticketNotifyEvents(before, view([t('A-1'), t('A-2')], { on: false }), DEFAULT_NOTIFY)).toEqual([]);
    expect(ticketNotifyEvents(before, view([t('A-1'), t('A-2')], { unread: [] }), DEFAULT_NOTIFY)).toEqual([]);
    expect(ticketNotifyEvents(before, view([t('A-1')]), DEFAULT_NOTIFY)).toEqual([]); // a dismissed ticket is not listed
    expect(ticketNotifyEvents(before, view([t('A-1'), t('A-2')]), { ...DEFAULT_NOTIFY, events: { ...DEFAULT_NOTIFY.events, ticket: false, 'pull-request': false } })).toEqual([]);
  });

  it('is on by default, and settings from before it keep it on', () => {
    expect(DEFAULT_NOTIFY.events.ticket).toBe(true);
    expect(NOTIFY_KIND_LABEL.ticket).toBe('A ticket is assigned to me');
    const older = { banner: true, sound: 'none', events: { 'needs-you': true, failed: true, done: false, 'review-request': true } };
    expect(notifyProblem(older)).toBeNull();
    expect(sanitizeNotify(older).events.ticket).toBe(true);
  });
});

describe('one rule for the window and for push (Kestrel Connect phase 6)', () => {
  const request = (key: string) => ({ key, host: 'github' as const, hostName: 'github.com', repository: 'acme/shop', number: 12, title: 'Faster checkout', author: 'sam', url: '', updatedAt: 0, projectId: null });
  const ticket = (ref: string) => ({ key: `fake:${ref}`, source: 'fake', tracker: 'Sample tracker', ref, title: `Do ${ref}`, status: { name: 'To Do', category: 'todo' as const }, project: 'Shop', url: '', openedAt: 0, updatedAt: 0 });
  const now = (sessions: S[], requests: string[], tickets: string[]) => ({
    sessions,
    links: [],
    pullRequests: new Map(),
    reviewRequests: { requests: requests.map(request), unread: requests },
    tickets: { tickets: tickets.map(ticket), unread: tickets.map((t) => `fake:${t}`), sources: ['fake'], settings: { on: true, off: [], show: 'page' as const } },
  });

  it('says nothing on the first look, then tells of each change once, sessions, requests and tickets alike', () => {
    const first = notificationsOf(NOTHING_SEEN, now([session('a', 'running')], ['r1'], ['T-1']), DEFAULT_NOTIFY, AWAY);
    expect(first.events).toEqual([]);
    const second = notificationsOf(first.seen, now([session('a', 'done')], ['r1', 'r2'], ['T-1', 'T-2']), DEFAULT_NOTIFY, AWAY);
    expect(second.events.map((e) => [e.kind, e.sessionId || e.requestKey || e.ticketKey])).toEqual([
      ['done', 'a'],
      ['review-request', 'r2'],
      ['ticket', 'fake:T-2'],
    ]);
    expect(notificationsOf(second.seen, now([session('a', 'done')], ['r1', 'r2'], ['T-1', 'T-2']), DEFAULT_NOTIFY, AWAY).events).toEqual([]);
  });

  it('keeps what is seen while everything is off, so turning it on brings no backlog', () => {
    const off = { ...DEFAULT_NOTIFY, enabled: false };
    const first = notificationsOf(NOTHING_SEEN, now([session('a', 'running')], [], []), off, AWAY);
    const second = notificationsOf(first.seen, now([session('a', 'done')], ['r1'], []), off, AWAY);
    expect(second.events).toEqual([]);
    expect(notificationsOf(second.seen, now([session('a', 'done')], ['r1'], []), DEFAULT_NOTIFY, AWAY).events).toEqual([]);
  });

  it("tells of another computer's request for set-up values at once, even on the first look and with everything off, and once (onboarding.md 19.7)", () => {
    const off = { ...DEFAULT_NOTIFY, enabled: false, banner: false };
    const asking = { id: 'q1', from: { id: 'mini', name: 'Mac mini' }, step: 'MCP server home-assistant', names: ['A', 'B'] };
    const first = notificationsOf(NOTHING_SEEN, { ...now([], [], []), setupRequests: [asking] }, off, AWAY);
    expect(first.events).toEqual([{ kind: 'setup-values', sessionId: '', setupRequestId: 'q1', title: 'Mac mini asks for values from this computer', body: '2 values for MCP server home-assistant. Allow or Deny within 2 minutes.' }]);
    expect(deskOnlyEvent(first.events[0]!)).toBe(true);
    expect(notificationsOf(first.seen, { ...now([], [], []), setupRequests: [asking] }, off, AWAY).events).toEqual([]);
    expect(parseTarget(targetOf(first.events[0]!))).toEqual({ setupRequestId: 'q1' });
  });

  it('never makes one where no requests are handed in, as the push sender hands none', () => {
    const first = notificationsOf(NOTHING_SEEN, now([], [], []), DEFAULT_NOTIFY, AWAY);
    expect(notificationsOf(first.seen, now([], [], []), DEFAULT_NOTIFY, AWAY).events.some((e) => e.kind === 'setup-values')).toBe(false);
  });
});

describe('a worker node that could not push a session’s branch (worker-nodes.md 9.3)', () => {
  const none = { sessions: [], links: [], pullRequests: new Map(), reviewRequests: { requests: [], unread: [] }, tickets: { tickets: [], unread: [], sources: [], settings: { on: false, off: [], show: 'page' as const } } };
  const refused = { sessionId: 'a', title: 'Fix login', key: 'a\n100', text: 'Could not push `kestrel/x` to `origin`: fatal: Could not read from remote repository.' };

  it('is told once, as a session that failed, even on the first look: a node keeps none across a restart', () => {
    const first = notificationsOf(NOTHING_SEEN, { ...none, pushFailures: [refused] }, DEFAULT_NOTIFY, AWAY);
    expect(first.events).toEqual([{ kind: 'failed', sessionId: 'a', title: 'Fix login', body: refused.text }]);
    expect(notificationsOf(first.seen, { ...none, pushFailures: [refused] }, DEFAULT_NOTIFY, AWAY).events).toEqual([]);
    const again = { ...refused, key: 'a\n200' };
    expect(notificationsOf(first.seen, { ...none, pushFailures: [again] }, DEFAULT_NOTIFY, AWAY).events).toHaveLength(1);
  });

  it('follows the settings for a failed session, and is never made where none are handed in (the window hands none)', () => {
    const off = { ...DEFAULT_NOTIFY, events: { ...DEFAULT_NOTIFY.events, failed: false } };
    expect(notificationsOf(NOTHING_SEEN, { ...none, pushFailures: [refused] }, off, AWAY).events).toEqual([]);
    expect(notificationsOf(NOTHING_SEEN, none, DEFAULT_NOTIFY, AWAY).seen.pushFailures).toBeNull();
  });
});

describe('a device asking to join the account (issue 72)', () => {
  const none = { sessions: [], links: [], pullRequests: new Map(), reviewRequests: { requests: [], unread: [] }, tickets: { tickets: [], unread: [], sources: [], settings: { on: false, off: [], show: 'page' as const } } };
  const node = { id: 'j1', name: 'kestrel-node01', kind: 'node' as const, state: 'waiting' as const };
  const FRONT: Looking = { focused: true, openSessionId: 'a' };

  it('is told when the window is not in front, even on the first look and with everything off, and once', () => {
    const off = { ...DEFAULT_NOTIFY, enabled: false, banner: false };
    const first = notificationsOf(NOTHING_SEEN, { ...none, joinRequests: [node] }, off, AWAY);
    expect(first.events).toEqual([{ kind: 'join-request', sessionId: '', joinRequestId: 'j1', title: 'kestrel-node01, a worker node, wants to join your account', body: 'Let it in only if you are setting it up now. Open Kestrel to type the code it shows.' }]);
    expect(deskOnlyEvent(first.events[0]!)).toBe(true);
    expect(parseTarget(targetOf(first.events[0]!))).toEqual({ joinRequestId: 'j1' });
    expect(notificationsOf(first.seen, { ...none, joinRequests: [node] }, off, AWAY).events).toEqual([]);
  });

  it('is not told while the window is in front, where its card is drawn over the page, and not later either', () => {
    const first = notificationsOf(NOTHING_SEEN, { ...none, joinRequests: [node] }, DEFAULT_NOTIFY, FRONT);
    expect(first.events).toEqual([]);
    expect(notificationsOf(first.seen, { ...none, joinRequests: [node] }, DEFAULT_NOTIFY, AWAY).events).toEqual([]);
  });

  it('only a request still waiting is news: one opened, being let in or finished is not', () => {
    for (const state of ['opening', 'typing', 'letting-in', 'showing', 'done'] as const) {
      expect(notificationsOf(NOTHING_SEEN, { ...none, joinRequests: [{ ...node, state }] }, DEFAULT_NOTIFY, AWAY).events).toEqual([]);
    }
  });

  it('a phone or computer is named without a kind; a new request after the first is told too', () => {
    const first = notificationsOf(NOTHING_SEEN, { ...none, joinRequests: [node] }, DEFAULT_NOTIFY, AWAY);
    const phone = { id: 'j2', name: 'Pocket', kind: 'phone' as const, state: 'waiting' as const };
    const second = notificationsOf(first.seen, { ...none, joinRequests: [node, phone] }, DEFAULT_NOTIFY, AWAY);
    expect(second.events.map((e) => e.title)).toEqual(['Pocket wants to join your account']);
  });

  it('never makes one where no requests are handed in, as the push sender hands none (the service pushes a request to join to every phone itself)', () => {
    const first = notificationsOf(NOTHING_SEEN, none, DEFAULT_NOTIFY, AWAY);
    expect(first.events).toEqual([]);
    expect(first.seen.joinRequests).toBeNull();
  });
});
