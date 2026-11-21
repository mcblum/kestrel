// Desktop notifications (shared/notifications.ts, notifications/*): which changes of status the
// user is told about, in what words, and the settings.
import { describe, expect, it } from 'vitest';
import { notificationsRoute } from './notifications/api.ts';
import { NotifyPrefsStore } from './notifications/prefs.ts';
import { bannerProblem, DEFAULT_NOTIFY, notifies, notifyEvents, notifyProblem, sanitizeNotify, type Looking } from './shared/notifications.ts';

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
    const prefs = { ...DEFAULT_NOTIFY, events: { 'needs-you': true, failed: false, done: false } };
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
    expect(DEFAULT_NOTIFY).toEqual({ banner: true, sound: 'none', events: { 'needs-you': true, failed: true, done: true } });
    expect(notifies(DEFAULT_NOTIFY)).toBe(true);
    expect(notifies({ ...DEFAULT_NOTIFY, banner: false })).toBe(false);
    expect(notifies({ ...DEFAULT_NOTIFY, banner: false, sound: 'ping' })).toBe(true);
    expect(notifies({ ...DEFAULT_NOTIFY, events: { 'needs-you': false, failed: false, done: false } })).toBe(false);
  });

  it('refuse what they cannot use, with the reason, and read back anything unreadable as the default', () => {
    expect(notifyProblem(DEFAULT_NOTIFY)).toBeNull();
    expect(notifyProblem({ ...DEFAULT_NOTIFY, sound: 'gong' })).toBe('sound must be one of: none, chime, ping, pop.');
    expect(notifyProblem({ banner: 'yes', sound: 'none', events: {} })).toBe('banner must be true or false.');
    expect(notifyProblem({ banner: true, sound: 'none', events: { done: true } })).toMatch(/events must say true or false/);
    expect(sanitizeNotify({ banner: false, sound: 'gong', events: { done: false } })).toEqual({ banner: false, sound: 'none', events: { 'needs-you': true, failed: true, done: false } });
  });

  it('are served and stored over HTTP', async () => {
    const store = new NotifyPrefsStore();
    const route = (method: string, body: Record<string, unknown> = {}) => notificationsRoute(['api', 'notifications'], method, async () => body, store);
    expect(await route('GET')).toEqual({ status: 200, body: { prefs: DEFAULT_NOTIFY } });
    expect(await route('PUT', { banner: true })).toMatchObject({ status: 400 });
    const quiet = { banner: false, sound: 'chime', events: { 'needs-you': true, failed: true, done: false } };
    expect(await route('PUT', quiet)).toEqual({ status: 200, body: { prefs: quiet } });
    expect(await store.prefs()).toEqual(quiet);
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

