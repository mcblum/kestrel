// The one record of what the user has looked at (seen.ts): held by the server, changed by every
// window and a paired phone alike, moved out of the window's ui-state the first time it is read.
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { SEEN_ACCOUNT_KEY, SEEN_KEY, SEEN_MARKS_KEY, SeenStore } from './seen.ts';
import { Workspace } from './workspace.ts';

type Active = { id: string; updatedAt: number; lastActivityAt?: number };

function store(opts: { stored?: Record<string, string>; sessions?: Active[] } = {}) {
  const settings = new Map(Object.entries(opts.stored ?? {}));
  let sessions = opts.sessions ?? [{ id: 's1', updatedAt: 10 }, { id: 's2', updatedAt: 20 }];
  let now = 1000;
  const seen = new SeenStore({
    settings: { getSetting: async (k) => settings.get(k) ?? null, putSetting: async (k, v) => void settings.set(k, v) },
    sessions: async () => sessions,
    now: () => now,
  });
  return { seen, settings, setSessions: (next: Active[]) => (sessions = next), tick: (to: number) => (now = to) };
}
const stored = (s: ReturnType<typeof store>, key: string) => JSON.parse(s.settings.get(key)!);

describe('the seen record', () => {
  it('the first time, with nothing kept anywhere, counts everything that exists as looked at', async () => {
    const s = store();
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 20 });
    // Each counts as marked when the session was last active, so any real mark since wins.
    expect(stored(s, SEEN_MARKS_KEY)).toEqual({ s1: [10, 10], s2: [20, 20] });
  });

  it('moves the record an older version kept, without when each mark was made', async () => {
    const s = store({ stored: { [SEEN_KEY]: JSON.stringify({ s1: 10, s2: 0 }) } });
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 0 });
    expect(stored(s, SEEN_MARKS_KEY)).toEqual({ s1: [10, 10], s2: [0, 0] });
  });

  it("moves what the window kept in ui-state out of it, so no dot lights up and nothing is kept twice", async () => {
    const s = store({ stored: { 'ui-state': JSON.stringify({ tabs: { tabs: [] }, seen: { s1: 10, s2: 5 } }) } });
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 5 });
    expect(JSON.parse(s.settings.get('ui-state')!)).toEqual({ tabs: { tabs: [] } });
    // Read once: a later change in ui-state is not read again.
    s.settings.set('ui-state', JSON.stringify({ seen: { s1: 0 } }));
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 5 });
  });

  it('keeps only well-formed entries of what was stored', async () => {
    const s = store({ stored: { [SEEN_MARKS_KEY]: JSON.stringify({ s1: [3, 4], s2: 'x', bad: null, s3: [1] }) } });
    expect(await s.seen.view()).toEqual({ s1: 3 });
  });

  it('marks sessions looked at, skips ids it does not know, and tells every listener once', async () => {
    const s = store({ stored: { [SEEN_MARKS_KEY]: '{}' } });
    const heard: unknown[] = [];
    let own = 0;
    s.seen.onChange((seen) => heard.push(seen));
    s.seen.onOwnChange(() => own++);
    expect(await s.seen.mark(['s1', 'gone'])).toEqual({ s1: 10 });
    expect(await s.seen.mark(['s1'])).toEqual({ s1: 10 });
    expect(heard).toEqual([{ s1: 10 }]);
    expect(own).toBe(1);
    expect(stored(s, SEEN_MARKS_KEY)).toEqual({ s1: [10, 1000] });
  });

  it('marks a session unread by hand until it is looked at again', async () => {
    const s = store();
    expect((await s.seen.markUnread('s2')).s2).toBe(0);
    expect((await s.seen.mark(['s2'])).s2).toBe(20);
    expect(await s.seen.markUnread('gone')).toEqual({ s1: 10, s2: 20 });
  });

  it('loses neither of two marks made at once', async () => {
    const s = store({ stored: { [SEEN_MARKS_KEY]: '{}' } });
    await Promise.all([s.seen.mark(['s1']), s.seen.mark(['s2'])]);
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 20 });
  });

  it("merges the account's other computers' marks, the later mark winning per session", async () => {
    const s = store({ stored: { [SEEN_MARKS_KEY]: '{}' }, sessions: [{ id: 's1', updatedAt: 10 }, { id: 's2', updatedAt: 20 }, { id: 'r1', updatedAt: 30 }] });
    await s.seen.mark(['s1']);
    const heard: unknown[] = [];
    let own = 0;
    s.seen.onChange((seen) => heard.push(seen));
    s.seen.onOwnChange(() => own++);
    // The Mac mini marked r1 read, and s1 unread after the mark here.
    expect(await s.seen.takeAccount({ mini: { r1: [30, 900], s1: [0, 2000] } }, ['mini'])).toEqual({ s1: 0, r1: 30 });
    expect(stored(s, SEEN_ACCOUNT_KEY)).toEqual({ mini: { r1: [30, 900], s1: [0, 2000] } });
    // Read again with nothing new: no window is told.
    await s.seen.takeAccount({ mini: { r1: [30, 900], s1: [0, 2000] } }, ['mini']);
    expect(heard).toHaveLength(1);
    // Another computer's marks are not this one's: nothing is to be sent.
    expect(own).toBe(0);
    expect(await s.seen.ownMarks()).toEqual({ s1: [10, 1000] });
    // Looked at here later: read everywhere again.
    s.tick(3000);
    expect((await s.seen.mark(['s1'])).s1).toBe(10);
    // A computer that left the account takes its marks with it; its sessions are unread again here.
    expect(await s.seen.takeAccount({}, [])).toEqual({ s1: 10 });
    await s.seen.takeAccount({ mini: { r1: [30, 900] } }, ['mini']);
    expect(await s.seen.forgetAccount()).toEqual({ s1: 10 });
  });

  it('drops its own marks of sessions that are nowhere', async () => {
    const s = store({ stored: { [SEEN_MARKS_KEY]: JSON.stringify({ s1: [1, 1], gone: [1, 1] }) } });
    expect(await s.seen.prune(new Set(['s1']))).toEqual({ s1: [1, 1] });
    expect(await s.seen.view()).toEqual({ s1: 1 });
  });

  it('is one copy per workspace, reading archived sessions too', async () => {
    const workspace = new Workspace(memoryPersistence());
    expect(workspace.seen).toBe(workspace.seen);
    expect(await workspace.seen.view()).toEqual({});
  });
});
