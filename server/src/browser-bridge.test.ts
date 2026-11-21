import { describe, expect, it } from 'vitest';
import { BrowserBridge, ONLY_OWN_SESSION, type BridgeTimers } from './browser-bridge.ts';
import { NEEDS_DESKTOP, NO_WINDOW } from './shared/browser.ts';

/** Timers the test fires by hand: no waiting, no clock. */
function manualTimers() {
  const due = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const timers: BridgeTimers = { set: (fn, ms) => (due.set(++next, { fn, ms }), next), clear: (h) => void due.delete(h as number) };
  const fire = (ms: number) => {
    for (const [id, t] of [...due]) if (t.ms === ms) (due.delete(id), t.fn());
  };
  return { timers, fire, pending: () => due.size };
}

/** A window on the socket: records what it was sent. */
function fakeWindow(bridge: BrowserBridge) {
  const sent: Record<string, any>[] = [];
  const connection = bridge.connect((payload) => void sent.push(payload as Record<string, any>));
  return {
    sent,
    serve: (sessionId: string, capable = true) => connection.message({ type: 'browser-serve', sessionId, capable }),
    unserve: (sessionId: string) => connection.message({ type: 'browser-unserve', sessionId }),
    serveAny: (capable = true) => connection.message({ type: 'browser-serve-any', capable }),
    answer: (requestId: string, body: Record<string, unknown>) => connection.message({ type: 'browser-response', requestId, ...body }),
    close: () => connection.close(),
    lastRequest: () => sent.filter((m) => m.type === 'browser-request').at(-1)!,
  };
}

const CLAIM = 3000;
const OP = 15000;

function setup() {
  const clock = manualTimers();
  const bridge = new BrowserBridge({ timers: clock.timers, claimMs: CLAIM });
  return { clock, bridge };
}

describe('the browser bridge', () => {
  it('sends the request to the window that has the session and returns its answer', async () => {
    const { bridge, clock } = setup();
    const win = fakeWindow(bridge);
    win.serve('s1');
    const call = bridge.request('s1', 'read', { maxChars: 100 }, OP);
    const request = win.lastRequest();
    expect(request).toMatchObject({ type: 'browser-request', sessionId: 's1', op: 'read', args: { maxChars: 100 } });
    win.answer(request.requestId, { ok: true, result: { url: 'https://example.com/' } });
    expect(await call).toEqual({ ok: true, result: { url: 'https://example.com/' } });
    expect(clock.pending()).toBe(0);
    expect(bridge.inFlight()).toBe(0);
  });

  it('passes the window’s error back as the reason', async () => {
    const { bridge } = setup();
    const win = fakeWindow(bridge);
    win.serve('s1');
    const call = bridge.request('s1', 'click', { ref: 3 }, OP);
    win.answer(win.lastRequest().requestId, { ok: false, error: 'No page is open.' });
    expect(await call).toEqual({ ok: false, error: 'No page is open.' });
  });

  it('asks exactly one window: the one that opened the session most recently', async () => {
    const { bridge } = setup();
    const first = fakeWindow(bridge);
    const second = fakeWindow(bridge);
    first.serve('s1');
    second.serve('s1');
    const call = bridge.request('s1', 'console', {}, OP);
    expect(first.sent).toHaveLength(0);
    // Another window cannot answer a request it was not sent.
    first.answer(second.lastRequest().requestId, { ok: true, result: 'wrong window' });
    second.answer(second.lastRequest().requestId, { ok: true, result: 'right window' });
    expect(await call).toEqual({ ok: true, result: 'right window' });
  });

  it('ignores a second answer and an answer to an unknown request', async () => {
    const { bridge } = setup();
    const win = fakeWindow(bridge);
    win.serve('s1');
    const call = bridge.request('s1', 'read', {}, OP);
    const { requestId } = win.lastRequest();
    win.answer(requestId, { ok: true, result: 1 });
    win.answer(requestId, { ok: true, result: 2 });
    win.answer('nope', { ok: true, result: 3 });
    expect(await call).toEqual({ ok: true, result: 1 });
  });

  it('with no window, waits a moment for one to open the session, then sends it there', async () => {
    const { bridge, clock } = setup();
    const call = bridge.request('s1', 'navigate', { url: 'https://example.com/' }, OP);
    expect(bridge.inFlight()).toBe(1);
    const win = fakeWindow(bridge);
    win.serve('other');
    expect(win.sent).toHaveLength(0);
    win.serve('s1');
    win.answer(win.lastRequest().requestId, { ok: true, result: { url: 'https://example.com/' } });
    expect(await call).toMatchObject({ ok: true });
    expect(clock.pending()).toBe(0);
  });

  it('with no window at all, answers that the session must be open in Kestrel', async () => {
    const { bridge, clock } = setup();
    const call = bridge.request('s1', 'read', {}, OP);
    clock.fire(CLAIM);
    expect(await call).toEqual({ ok: false, error: NO_WINDOW });
    expect(bridge.inFlight()).toBe(0);
  });

  it('when the session is open only in a plain browser tab, says the pane needs the desktop app', async () => {
    const { bridge, clock } = setup();
    const tab = fakeWindow(bridge);
    tab.serve('s1', false);
    const call = bridge.request('s1', 'read', {}, OP);
    expect(tab.sent).toHaveLength(0);
    clock.fire(CLAIM);
    expect(await call).toEqual({ ok: false, error: NEEDS_DESKTOP });
  });

  it('a window that stopped showing the session is not asked', async () => {
    const { bridge, clock } = setup();
    const win = fakeWindow(bridge);
    win.serve('s1');
    win.unserve('s1');
    const call = bridge.request('s1', 'read', {}, OP);
    clock.fire(CLAIM);
    expect(await call).toEqual({ ok: false, error: NO_WINDOW });
    expect(win.sent).toHaveLength(0);
  });

  it('times out cleanly when the window never answers, and drops a late answer', async () => {
    const { bridge, clock } = setup();
    const win = fakeWindow(bridge);
    win.serve('s1');
    const call = bridge.request('s1', 'screenshot', {}, OP);
    clock.fire(OP);
    expect(await call).toEqual({ ok: false, error: 'The browser pane did not answer within 15 seconds.' });
    win.answer(win.lastRequest().requestId, { ok: true, result: 'late' });
    expect(bridge.inFlight()).toBe(0);
  });

  it('fails the request at once when the window closes mid-request, and stops sending to it', async () => {
    const { bridge, clock } = setup();
    const win = fakeWindow(bridge);
    win.serve('s1');
    const call = bridge.request('s1', 'navigate', {}, OP);
    win.close();
    expect(await call).toMatchObject({ ok: false, error: expect.stringMatching(/closed before the browser answered/) });
    expect(clock.pending()).toBe(0);
    const again = bridge.request('s1', 'read', {}, OP);
    clock.fire(CLAIM);
    expect(await again).toEqual({ ok: false, error: NO_WINDOW });
  });

  it('a window that cannot be sent to fails the request instead of hanging', async () => {
    const { bridge, clock } = setup();
    const connection = bridge.connect(() => {
      throw new Error('socket gone');
    });
    connection.message({ type: 'browser-serve', sessionId: 's1', capable: true });
    expect(await bridge.request('s1', 'read', {}, OP)).toEqual({ ok: false, error: 'The Kestrel window could not be reached.' });
    expect(clock.pending()).toBe(0);
  });

  it('ignores malformed messages', () => {
    const { bridge } = setup();
    const connection = bridge.connect(() => undefined);
    expect(() => {
      connection.message({ type: 'browser-serve' });
      connection.message({ type: 'browser-serve', sessionId: 'x'.repeat(500), capable: true });
      connection.message({ type: 'browser-response' });
      connection.message({ type: 'browser-anything', sessionId: 's1' });
    }).not.toThrow();
  });

  it('serves a session in the background through a window that makes any session’s browser', async () => {
    const { bridge } = setup();
    const win = fakeWindow(bridge);
    win.serveAny();
    const call = bridge.request('s9', 'navigate', { url: 'https://example.com/' }, OP);
    expect(win.lastRequest()).toMatchObject({ sessionId: 's9', op: 'navigate' });
    win.answer(win.lastRequest().requestId, { ok: true, result: { url: 'https://example.com/' } });
    expect(await call).toMatchObject({ ok: true });
  });

  it('prefers the window that already has the session’s browser over one that would make it', async () => {
    const { bridge } = setup();
    const has = fakeWindow(bridge);
    has.serve('s1');
    const other = fakeWindow(bridge);
    other.serveAny();
    void bridge.request('s1', 'read', {}, OP);
    expect(has.sent.filter((m) => m.type === 'browser-request')).toHaveLength(1);
    expect(other.sent.filter((m) => m.type === 'browser-request')).toHaveLength(0);
  });

  it('a waiting request goes to a window that starts serving any session', async () => {
    const { bridge } = setup();
    const call = bridge.request('s1', 'read', {}, OP);
    const win = fakeWindow(bridge);
    win.serveAny();
    win.answer(win.lastRequest().requestId, { ok: true, result: {} });
    expect(await call).toMatchObject({ ok: true });
  });

  it('a plain browser tab that serves any session still says the pane needs the desktop app', async () => {
    const { bridge, clock } = setup();
    const win = fakeWindow(bridge);
    win.serveAny(false);
    const call = bridge.request('s1', 'read', {}, OP);
    clock.fire(CLAIM);
    expect(await call).toEqual({ ok: false, error: NEEDS_DESKTOP });
  });

  it('accepts a session served under its session: spelling', async () => {
    const { bridge } = setup();
    const win = fakeWindow(bridge);
    win.serve('session:s1');
    void bridge.request('s1', 'read', {}, OP);
    expect(win.lastRequest()).toMatchObject({ sessionId: 's1' });
  });

  it('never lets an agent call reach a project’s or a group’s browser', async () => {
    const { bridge, clock } = setup();
    const win = fakeWindow(bridge);
    win.serve('project:p1');
    win.serve('group:g1');
    win.serveAny();
    for (const key of ['project:p1', 'group:g1', 'planet:x', '']) expect(await bridge.request(key, 'read', {}, OP)).toEqual({ ok: false, error: ONLY_OWN_SESSION });
    expect(win.sent.filter((m) => m.type === 'browser-request')).toHaveLength(0);
    expect(clock.pending()).toBe(0);
    // A session, spelled either way, goes through as that session.
    void bridge.request('session:s1', 'read', {}, OP);
    expect(win.lastRequest()).toMatchObject({ sessionId: 's1' });
  });
});
