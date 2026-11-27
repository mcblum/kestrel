import { describe, expect, it } from 'vitest';
import { memorySettings } from '../suggestions/prefs.ts';
import { parseStartIds, START_ID_KEPT_MS, START_IDS_KEY, START_IDS_MAX, startedBy, StartIds, withStart } from './start-ids.ts';

describe('the start-id memory, purely', () => {
  it('finds the session an id started while it is remembered, and nothing after', () => {
    const list = [{ id: 's1', sessionId: 'a', at: 1_000 }];
    expect(startedBy(list, 's1', 2_000)).toBe('a');
    expect(startedBy(list, 's2', 2_000)).toBeNull();
    expect(startedBy(list, 's1', 1_000 + START_ID_KEPT_MS)).toBeNull();
  });

  it('keeps the newest first, drops the expired and a repeat of the same id, and keeps at most the limit', () => {
    const old = { id: 'old', sessionId: 'x', at: 0 };
    const kept = withStart([old, { id: 's1', sessionId: 'a', at: 10 }], { id: 's1', sessionId: 'b', at: START_ID_KEPT_MS + 5 }, START_ID_KEPT_MS + 5);
    expect(kept).toEqual([{ id: 's1', sessionId: 'b', at: START_ID_KEPT_MS + 5 }]);
    let many: ReturnType<typeof withStart> = [];
    for (let i = 0; i < START_IDS_MAX + 20; i++) many = withStart(many, { id: `s${i}`, sessionId: `x${i}`, at: i }, i);
    expect(many).toHaveLength(START_IDS_MAX);
    expect(many[0]!.id).toBe(`s${START_IDS_MAX + 19}`);
  });

  it('reads nothing from what is not a list of starts', () => {
    expect(parseStartIds(null)).toEqual([]);
    expect(parseStartIds('not json')).toEqual([]);
    expect(parseStartIds('{"id":"a"}')).toEqual([]);
    expect(parseStartIds(JSON.stringify([{ id: 'a', sessionId: 'b', at: 1 }, { id: 3 }]))).toEqual([{ id: 'a', sessionId: 'b', at: 1 }]);
  });
});

describe('StartIds.once', () => {
  it('starts once per id: a repeat gets the same session and starts nothing', async () => {
    const ids = new StartIds(memorySettings());
    let starts = 0;
    const start = async () => `session-${++starts}`;
    expect(await ids.once('s1', start)).toEqual({ sessionId: 'session-1', again: false });
    expect(await ids.once('s1', start)).toEqual({ sessionId: 'session-1', again: true });
    expect(await ids.once('s2', start)).toEqual({ sessionId: 'session-2', again: false });
    expect(starts).toBe(2);
  });

  it('a repeat that arrives while the first is still being accepted waits for it', async () => {
    const ids = new StartIds(memorySettings());
    let release: ((id: string) => void) | null = null;
    let starts = 0;
    const first = ids.once('s1', () => (starts++, new Promise<string>((resolve) => (release = resolve))));
    const second = ids.once('s1', async () => (starts++, 'another'));
    while (!release) await new Promise((r) => setTimeout(r, 1));
    (release as (id: string) => void)('session-1');
    expect(await first).toEqual({ sessionId: 'session-1', again: false });
    expect(await second).toEqual({ sessionId: 'session-1', again: true });
    expect(starts).toBe(1);
  });

  it('a refused start is not remembered: the same id tries again', async () => {
    const ids = new StartIds(memorySettings());
    await expect(ids.once('s1', async () => Promise.reject(new Error('switched off')))).rejects.toThrow('switched off');
    expect(await ids.once('s1', async () => 'session-1')).toEqual({ sessionId: 'session-1', again: false });
  });

  it('is kept in the store, so a restart inside the retry window still answers with the same session', async () => {
    const store = memorySettings();
    let now = 1_000;
    await new StartIds(store, () => now).once('s1', async () => 'session-1');
    expect(await store.getSetting(START_IDS_KEY)).toContain('session-1');
    now += 60_000;
    expect(await new StartIds(store, () => now).once('s1', async () => 'session-2')).toEqual({ sessionId: 'session-1', again: true });
  });
});
