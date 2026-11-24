import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { memorySettings } from '../../suggestions/prefs.ts';
import { connectRoute } from './api.ts';
import { FakeIdentity, FakeService, fakeListener, tokensFor } from './connect-fakes.ts';
import { CONNECT_PREFS_KEY, KestrelConnect } from './connect.ts';
import { HeldApi } from './held-api.ts';
import { BACKOFF_MAX_MS, HEARTBEAT_MS, REMOVED_REASON, RENEW_AHEAD_MS } from './relay-link.ts';
import { ServiceRefusal } from './service.ts';
import { memoryVault, type VaultData } from './vault.ts';

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

function setup(opts: { vault?: VaultData; enabled?: boolean; unavailable?: string } = {}) {
  const identity = new FakeIdentity();
  const service = new FakeService();
  const vault = memoryVault(opts.vault);
  const settings = memorySettings();
  const listener = fakeListener();
  if (opts.enabled) void settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled: true }));
  const connect = new KestrelConnect({ vault, identity, service, settings, computerName: 'Desk', listen: listener.listen, unavailable: opts.unavailable ?? null, random: () => 1 });
  const views: string[] = [];
  connect.onChange((v) => views.push(`${v.account.state}/${v.link.state}`));
  return { identity, service, vault, settings, listener, connect, views };
}

const signedIn = (now = Date.now()): VaultData => ({ tokens: tokensFor(0, now), device: null });

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-22T12:00:00Z') }));
afterEach(() => vi.useRealTimers());

describe('sign-in state', () => {
  test('starts signed out and off, and dials nothing', async () => {
    const { connect, service } = setup();
    await connect.start();
    expect(connect.view()).toMatchObject({ enabled: false, account: { state: 'signed-out', reason: null }, link: { state: 'off' }, storage: 'keystore', computerName: 'Desk' });
    await connect.setEnabled(true);
    expect(service.sockets).toHaveLength(0); // on, but nobody signed in
  });

  test('switched off, a signed-in computer with a device opens no socket and reads no account state', async () => {
    const vault = { ...signedIn(), device: { subject: 'sub-1', id: 'device-9', name: 'Desk', ...{ signing: { publicKey: 'x', privateKey: 'y' }, agreement: { publicKey: 'x', privateKey: 'y' } } } } as VaultData;
    const { connect, service } = setup({ vault });
    await connect.start();
    await vi.advanceTimersByTimeAsync(10 * BACKOFF_MAX_MS);
    expect(service.sockets).toHaveLength(0);
    expect(service.seen).toEqual([]); // no HTTP call: no keys, devices, requests to join or held records
    expect(service.held.calls).toEqual([]);
    expect(connect.view()).toMatchObject({ devices: [], joining: null, requests: [], keys: { state: 'unknown' } });
    expect(() => connect.join.open('join-1')).toThrow();
  });

  test('signed in but switched off dials nothing', async () => {
    const { connect, service } = setup({ vault: signedIn() });
    await connect.start();
    expect(connect.view().account).toEqual({ state: 'signed-in', email: 'person@example.com' });
    expect(service.sockets).toHaveLength(0);
  });

  test('a sign-in goes through the browser and comes back signed in', async () => {
    const { connect, listener, vault } = setup();
    await connect.start();
    const { url } = await connect.signIn();
    expect(url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A50000%2Fcallback');
    expect(connect.view().account).toEqual({ state: 'signing-in', url });
    expect((await connect.signIn()).url).toBe(url); // asking again joins the one under way
    listener.complete({ code: 'good-code' });
    await flush();
    expect(connect.view().account).toEqual({ state: 'signed-in', email: 'person@example.com' });
    expect(vault.current().tokens?.accessToken).toBe('access-1');
  });

  test('a refused sign-in ends signed out with the reason', async () => {
    const { connect, listener, vault } = setup();
    await connect.start();
    await connect.signIn();
    listener.complete({ code: 'stolen' });
    await flush();
    expect(connect.view().account).toEqual({ state: 'signed-out', reason: 'Sign-in was refused: Code not valid.' });
    expect(vault.current().tokens).toBeNull();
  });

  test('cancelling closes the loopback listener', async () => {
    const { connect, listener } = setup();
    await connect.start();
    await connect.signIn();
    connect.cancelSignIn();
    await flush();
    expect(listener.closed()).toBe(true);
    expect(connect.view().account).toEqual({ state: 'signed-out', reason: null });
  });

  test('signing in twice is refused with the reason', async () => {
    const { connect } = setup({ vault: signedIn() });
    await connect.start();
    await expect(connect.signIn()).rejects.toThrow('Already signed in as person@example.com');
  });

  test('signing out forgets the tokens, keeps the device, stops the link and revokes', async () => {
    const { connect, service, vault, identity } = setup({ vault: signedIn(), enabled: true });
    await connect.start();
    await flush();
    expect(service.sockets).toHaveLength(1);
    await connect.signOut();
    await flush();
    expect(vault.current().tokens).toBeNull();
    expect(vault.current().device?.id).toBe('device-1');
    expect(service.last().closedWith).toBe(1000);
    expect(connect.view()).toMatchObject({ account: { state: 'signed-out' }, link: { state: 'off' } });
    expect(identity.revoked).toEqual(['refresh-0']);
  });

  test('a copy with sample data refuses, and says why', async () => {
    const { connect } = setup({ unavailable: 'Kestrel Connect is off while Kestrel runs with sample data.' });
    await connect.start();
    expect(connect.view().unavailable).toContain('sample data');
    await expect(connect.setEnabled(true)).rejects.toThrow('sample data');
    await expect(connect.signIn()).rejects.toThrow('sample data');
  });

  test('the routes answer, and refuse with a reason', async () => {
    const { connect } = setup();
    await connect.start();
    const none = async () => ({});
    expect(await connectRoute(['api', 'connect'], 'GET', none, connect)).toMatchObject({ status: 200, body: { enabled: false } });
    expect(await connectRoute(['api', 'connect'], 'PATCH', async () => ({ enabled: 'yes' }), connect)).toEqual({ status: 400, body: { error: 'enabled must be true or false.' } });
    expect(await connectRoute(['api', 'connect'], 'PATCH', async () => ({ enabled: true }), connect)).toMatchObject({ status: 200, body: { enabled: true } });
    expect(await connectRoute(['api', 'connect', 'sign-in'], 'POST', none, connect)).toMatchObject({ status: 200, body: { url: expect.stringContaining('https://') } });
    expect(await connectRoute(['api', 'connect', 'sign-in'], 'DELETE', none, connect)).toEqual({ status: 204 });
    expect(await connectRoute(['api', 'connect', 'pair'], 'POST', none, connect)).toBeNull();
  });
});

describe('the device', () => {
  test('is registered once, with keys, and reused', async () => {
    const { connect, service, vault } = setup({ vault: signedIn(), enabled: true });
    await connect.start();
    await flush();
    expect(service.registered).toEqual([{ id: 'device-1', name: 'Desk' }]);
    const device = vault.current().device;
    expect(device).toMatchObject({ subject: 'sub-1', id: 'device-1' });
    expect(device?.signing.privateKey).toContain('PRIVATE KEY');
    expect(device?.agreement.publicKey).toContain('PUBLIC KEY');
    expect(service.last()).toMatchObject({ token: 'access-0', deviceId: 'device-1' });
    expect(await connect.deviceId()).toBe('device-1');
    expect(service.registered).toHaveLength(1);
  });

  test('a different account registers this computer again', async () => {
    const other = { subject: 'sub-2', id: 'theirs', name: 'Desk', signing: { publicKey: '', privateKey: '' }, agreement: { publicKey: '', privateKey: '' } };
    const { connect, service } = setup({ vault: { ...signedIn(), device: other }, enabled: true });
    await connect.start();
    await flush();
    expect(service.last().deviceId).toBe('device-1');
  });

  test('a full account is said, and not tried again on its own', async () => {
    const { connect, service } = setup({ vault: signedIn(), enabled: true });
    service.registerFails = new ServiceRefusal(409, 'devices-limit', 'This account has 10 devices already. Remove one first.');
    await connect.start();
    await flush();
    expect(connect.view().link).toEqual({ state: 'offline', reason: 'This account has 10 devices already. Remove one first.', retryAt: null });
  });
});

describe('token renewal', () => {
  test('an access token about to expire is renewed before the link dials', async () => {
    const now = Date.now();
    const { connect, service, identity, vault } = setup({ vault: { tokens: { ...tokensFor(0, now), accessExpiresAt: now + 30_000 }, device: null }, enabled: true });
    await connect.start();
    await flush();
    expect(identity.refreshes).toBe(1);
    expect(service.last().token).toBe('access-1');
    expect(vault.current().tokens?.refreshToken).toBe('refresh-1');
  });

  test('renewals at the same moment share one refresh', async () => {
    const now = Date.now();
    const { connect, identity } = setup({ vault: { tokens: { ...tokensFor(0, now), accessExpiresAt: now }, device: null } });
    await connect.start();
    const [a, b] = await Promise.all([connect.accessToken(), connect.accessToken()]);
    expect(a).toBe('access-1');
    expect(b).toBe('access-1');
    expect(identity.refreshes).toBe(1);
  });

  test('a refresh the provider refuses signs out with the reason', async () => {
    const now = Date.now();
    const { connect, identity, vault, service } = setup({ vault: { tokens: { ...tokensFor(0, now), accessExpiresAt: now }, device: null }, enabled: true });
    identity.failRefresh = 'ended';
    await connect.start();
    await flush();
    expect(service.sockets).toHaveLength(0);
    expect(vault.current().tokens).toBeNull();
    expect(connect.view()).toMatchObject({ account: { state: 'signed-out', reason: expect.stringContaining('Token is not active') }, link: { state: 'off' } });
  });

  test('a refresh that cannot reach the provider stays signed in and tries again', async () => {
    const now = Date.now();
    const { connect, identity, service } = setup({ vault: { tokens: { ...tokensFor(0, now), accessExpiresAt: now }, device: null }, enabled: true });
    identity.failRefresh = 'network';
    await connect.start();
    await flush();
    expect(connect.view()).toMatchObject({ account: { state: 'signed-in' }, link: { state: 'offline', reason: expect.stringContaining('fetch failed') } });
    identity.failRefresh = null;
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(service.sockets).toHaveLength(1);
  });
});

describe('the relay link', () => {
  async function linked() {
    const ctx = setup({ vault: signedIn(), enabled: true });
    await ctx.connect.start();
    await flush();
    return ctx;
  }

  test('is connected once the service welcomes it', async () => {
    const { connect, service } = await linked();
    expect(connect.view().link).toEqual({ state: 'connecting' });
    service.welcome(service.last(), Date.now() + 300_000);
    expect(connect.view().link).toMatchObject({ state: 'connected' });
  });

  test('renews its token a minute before the sign-in expires, and the new socket replaces the old', async () => {
    const { connect, service, identity } = await linked();
    const first = service.last();
    service.welcome(first, Date.now() + 300_000);
    await vi.advanceTimersByTimeAsync(300_000 - RENEW_AHEAD_MS - 1);
    expect(service.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(identity.refreshes).toBe(1);
    const second = service.last();
    expect(second.token).toBe('access-1');
    expect(connect.view().link.state).toBe('connected'); // the old socket carries on until the new one opens
    service.welcome(second, Date.now() + 300_000);
    expect(first.closedWith).toBe(1000);
    first.events.closed(4000, 'replaced'); // the service's own close of the old one is expected
    expect(connect.view().link.state).toBe('connected');
  });

  test('dials with a token that outlives the renewal margin, so a new socket is not renewed at once', async () => {
    // 2026-11-23: after an edge restart the desk dialled with 76 s left on its token and renewed 16 s later.
    const now = Date.now();
    const { connect, service, identity } = setup({ vault: { tokens: { ...tokensFor(0, now), accessExpiresAt: now + RENEW_AHEAD_MS + 16_000 }, device: null }, enabled: true });
    await connect.start();
    await flush();
    expect(identity.refreshes).toBe(1);
    expect(service.last().token).toBe('access-1');
    service.welcome(service.last(), Date.now() + 300_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.sockets).toHaveLength(1);
    expect(connect.view().link.state).toBe('connected');
  });

  test('the service replacing the old socket before the renewal opens keeps the link up, with no wait', async () => {
    const { connect, service } = await linked();
    const first = service.last();
    service.welcome(first, Date.now() + 300_000);
    await vi.advanceTimersByTimeAsync(300_000 - RENEW_AHEAD_MS);
    await flush();
    const second = service.last();
    expect(second).not.toBe(first);
    const states: string[] = [];
    connect.onChange((v) => states.push(v.link.state));
    first.events.closed(4000, 'replaced'); // the service took the new one first
    expect(connect.view().link.state).toBe('connected');
    service.welcome(second, Date.now() + 300_000);
    expect(connect.view().link.state).toBe('connected');
    expect(states).not.toContain('offline');
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(service.sockets).toHaveLength(2);
  });

  test('a renewal that fails after the old socket was replaced reconnects at once, not in five minutes', async () => {
    const { connect, service } = await linked();
    const first = service.last();
    service.welcome(first, Date.now() + 300_000);
    await vi.advanceTimersByTimeAsync(300_000 - RENEW_AHEAD_MS);
    await flush();
    const second = service.last();
    first.events.closed(4000, 'replaced');
    second.events.closed(1006, '');
    expect(connect.view().link).toMatchObject({ state: 'offline', retryAt: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.sockets).toHaveLength(3);
  });

  test('a 4401 close renews the token and connects again', async () => {
    const { connect, service, identity } = await linked();
    service.welcome(service.last(), Date.now() + 300_000);
    service.last().events.closed(4401, 'sign-in expired');
    expect(connect.view().link).toMatchObject({ state: 'offline' });
    await vi.advanceTimersByTimeAsync(1);
    expect(identity.refreshes).toBe(1);
    expect(service.sockets).toHaveLength(2);
    expect(service.last().token).toBe('access-1');
  });

  test('a dropped connection backs off, says why, and reconnects', async () => {
    const { connect, service } = await linked();
    service.welcome(service.last(), Date.now() + 300_000);
    service.last().events.error(new Error('read ECONNRESET'));
    service.last().events.closed(1006, '');
    expect(connect.view().link).toEqual({ state: 'offline', reason: 'read ECONNRESET', retryAt: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(service.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.sockets).toHaveLength(2);
    service.last().events.closed(1006, '');
    expect(connect.view().link).toMatchObject({ retryAt: Date.now() + 2000 }); // backing off
    await vi.advanceTimersByTimeAsync(2000);
    service.welcome(service.last(), Date.now() + 300_000);
    expect(connect.view().link.state).toBe('connected');
  });

  test('backoff stops growing at its ceiling', async () => {
    const { connect, service } = await linked();
    for (let i = 0; i < 12; i++) {
      service.last().events.closed(1006, 'gone');
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    }
    const link = connect.view().link;
    service.last().events.closed(1006, 'gone');
    expect(connect.view().link).toMatchObject({ retryAt: Date.now() + BACKOFF_MAX_MS });
    expect(link).toBeTruthy();
  });

  test('heartbeats, and a missed pong reconnects', async () => {
    const { connect, service } = await linked();
    const socket = service.last();
    service.welcome(socket, Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(socket.pings).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(socket.pings).toBe(2);
    expect(connect.view().link.state).toBe('connected');
    socket.answersPings = false;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); // ping 3 goes unanswered
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(connect.view().link).toMatchObject({ state: 'offline', reason: 'the connection stopped answering' });
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(service.sockets).toHaveLength(2);
  });

  test('removed from the account (4001): forgets the device and waits for the user', async () => {
    const { connect, service, vault } = await linked();
    service.welcome(service.last(), Date.now() + 300_000);
    service.last().events.closed(4001, 'removed');
    await flush();
    expect(connect.view().link).toEqual({ state: 'offline', reason: REMOVED_REASON, retryAt: null });
    expect(vault.current().device).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * BACKOFF_MAX_MS);
    expect(service.sockets).toHaveLength(1);
    await connect.setEnabled(false);
    await connect.setEnabled(true);
    await flush();
    expect(service.registered).toHaveLength(2); // on again: added back as a new device
  });

  test('an upgrade refused as unknown-device is the same as removed', async () => {
    const { connect, service } = await linked();
    service.last().events.refused(new ServiceRefusal(403, 'unknown-device', 'No such device.'));
    expect(connect.view().link).toMatchObject({ state: 'offline', reason: REMOVED_REASON, retryAt: null });
  });

  test('an upgrade refused for too many connects waits, with the service’s words', async () => {
    const { connect, service } = await linked();
    service.last().events.refused(new ServiceRefusal(429, 'too-many-connects', 'Too many connections in the last minute. Try again in 40 seconds.'));
    expect(connect.view().link).toMatchObject({ state: 'offline', reason: 'Too many connections in the last minute. Try again in 40 seconds.' });
  });

  test('switching off closes the socket and stops trying', async () => {
    const { connect, service } = await linked();
    service.last().events.closed(1006, 'gone');
    await connect.setEnabled(false);
    expect(connect.view().link).toEqual({ state: 'off' });
    await vi.advanceTimersByTimeAsync(10 * BACKOFF_MAX_MS);
    expect(service.sockets).toHaveLength(1);
  });
});

describe('every call to the service renews the sign-in once when it is refused (401)', () => {
  test('registering this computer and an API call each retry once with a renewed token', async () => {
    const { connect, service, identity } = setup({ vault: signedIn(), enabled: true });
    service.rejected.add('access-0');
    await connect.start();
    const id = await connect.deviceId();
    expect(service.seen.filter((c) => c.startsWith('POST /devices'))).toEqual(['POST /devices access-0', 'POST /devices access-1']);
    expect(identity.refreshes).toBe(1);

    service.rejected.add('access-1');
    service.held.addDevice('phone-x', 'Phone', 'phone');
    await expect(new HeldApi((m, p, b) => (connect as unknown as { call(): (m: string, p: string, b?: unknown) => Promise<unknown> }).call()(m, p, b)).devices()).resolves.toHaveLength(2);
    expect(service.seen.filter((c) => c.startsWith('GET /devices'))).toEqual(['GET /devices access-1', 'GET /devices access-2']);
    expect(id).toBe('device-1');
  });

  test('a refusal that is not 401 is not retried, and a second 401 is said', async () => {
    const { connect, service } = setup({ vault: signedIn(), enabled: true });
    await connect.start();
    await connect.deviceId();
    service.rejected.add('access-0').add('access-1');
    const call = (connect as unknown as { call(): (m: string, p: string) => Promise<unknown> }).call();
    await expect(call('GET', '/devices')).rejects.toThrow(/expired/);
    expect(service.seen.filter((c) => c.startsWith('GET /devices'))).toHaveLength(2);
  });
});
