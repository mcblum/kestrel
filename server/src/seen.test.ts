// The one record of what the user has looked at (seen.ts): held by the server, changed by every
// window and a paired phone alike, moved out of the window's ui-state the first time it is read.
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { SEEN_KEY, SeenStore } from './seen.ts';
import { Workspace } from './workspace.ts';

type Active = { id: string; updatedAt: number; lastActivityAt?: number };

function store(opts: { stored?: Record<string, string>; sessions?: Active[] } = {}) {
  const settings = new Map(Object.entries(opts.stored ?? {}));
  let sessions = opts.sessions ?? [{ id: 's1', updatedAt: 10 }, { id: 's2', updatedAt: 20 }];
  const seen = new SeenStore({
    settings: { getSetting: async (k) => settings.get(k) ?? null, putSetting: async (k, v) => void settings.set(k, v) },
    sessions: async () => sessions,
  });
  return { seen, settings, setSessions: (next: Active[]) => (sessions = next) };
}

describe('the seen record', () => {
  it('the first time, with nothing kept anywhere, counts everything that exists as looked at', async () => {
    const s = store();
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 20 });
    expect(JSON.parse(s.settings.get(SEEN_KEY)!)).toEqual({ s1: 10, s2: 20 });
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
    const s = store({ stored: { [SEEN_KEY]: JSON.stringify({ s1: 3, s2: 'x', bad: null }) } });
    expect(await s.seen.view()).toEqual({ s1: 3 });
  });

  it('marks sessions looked at, skips ids it does not know, and tells every listener once', async () => {
    const s = store({ stored: { [SEEN_KEY]: '{}' } });
    const heard: unknown[] = [];
    s.seen.onChange((seen) => heard.push(seen));
    expect(await s.seen.mark(['s1', 'gone'])).toEqual({ s1: 10 });
    expect(await s.seen.mark(['s1'])).toEqual({ s1: 10 });
    expect(heard).toEqual([{ s1: 10 }]);
    expect(JSON.parse(s.settings.get(SEEN_KEY)!)).toEqual({ s1: 10 });
  });

  it('marks a session unread by hand until it is looked at again', async () => {
    const s = store();
    expect((await s.seen.markUnread('s2')).s2).toBe(0);
    expect((await s.seen.mark(['s2'])).s2).toBe(20);
    expect(await s.seen.markUnread('gone')).toEqual({ s1: 10, s2: 20 });
  });

  it('loses neither of two marks made at once', async () => {
    const s = store({ stored: { [SEEN_KEY]: '{}' } });
    await Promise.all([s.seen.mark(['s1']), s.seen.mark(['s2'])]);
    expect(await s.seen.view()).toEqual({ s1: 10, s2: 20 });
  });

  it('is one copy per workspace, reading archived sessions too', async () => {
    const workspace = new Workspace(memoryPersistence());
    expect(workspace.seen).toBe(workspace.seen);
    expect(await workspace.seen.view()).toEqual({});
  });
});
