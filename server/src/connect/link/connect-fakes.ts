// Stand-ins for the identity provider and the Connect service, so tests never reach the network.
import type { CallbackResult, LoopbackCallback } from './loopback.ts';
import { DEVICE_CODE_EXPIRED, DEVICE_SIGN_IN_DENIED, DeviceGrantEnded, SignInEnded, type AuthorizationRequest, type DeviceAuthorization, type DevicePoll, type IdentityProvider } from './identity.ts';
import { isComputerKind, type DeviceKind } from '../../shared/connect.ts';
import { ServiceRefusal, type ConnectService, type RegisteredDevice, type RelayEvents, type RelaySocket, type ServiceConfig, type ServiceMethod } from './service.ts';
import type { StoredTokens } from './vault.ts';
import type { PublicIdentity } from '../keys.ts';

export function tokensFor(n: number, now: number, subject = 'sub-1', email = 'person@example.com'): StoredTokens {
  return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, accessExpiresAt: now + 300_000, idToken: null, subject, email };
}

export class FakeIdentity implements IdentityProvider {
  issued = 0;
  refreshes = 0;
  revoked: string[] = [];
  /** Set to make the next refresh fail: 'ended' (invalid_grant) or 'network'. */
  failRefresh: 'ended' | 'network' | null = null;
  failExchange: string | null = null;
  subject = 'sub-1';
  email = 'person@example.com';

  /** The device grant (RFC 8628): what the person did on the other device, as a test says it. */
  device: 'waiting' | 'signed-in' | 'denied' | 'expired' = 'waiting';
  /** The next polls answer slow_down. */
  slowDowns = 0;
  /** Every device poll, with the time it was made. */
  polls: number[] = [];
  /** Device authorizations started. */
  deviceStarts = 0;
  /** The wait between polls the provider asks for; tests make it short. */
  deviceIntervalMs = 5_000;

  constructor(private readonly now: () => number = Date.now) {}

  async deviceAuthorize(): Promise<DeviceAuthorization> {
    this.deviceStarts += 1;
    this.device = this.device === 'signed-in' ? 'waiting' : this.device;
    return { verificationUri: 'https://id.example.test/device', verificationUriComplete: `https://id.example.test/device?user_code=WDJB-MJHT`, userCode: 'WDJB-MJHT', intervalMs: this.deviceIntervalMs, expiresAt: this.now() + 600_000, deviceCode: `device-code-${this.deviceStarts}`, verifier: 'verifier' };
  }

  async devicePoll(request: DeviceAuthorization): Promise<DevicePoll> {
    this.polls.push(this.now());
    if (this.device === 'denied') throw new DeviceGrantEnded(DEVICE_SIGN_IN_DENIED);
    if (this.device === 'expired' || this.now() >= request.expiresAt) throw new DeviceGrantEnded(DEVICE_CODE_EXPIRED);
    if (this.slowDowns > 0) {
      this.slowDowns -= 1;
      return { state: 'slow-down' };
    }
    if (this.device !== 'signed-in') return { state: 'pending' };
    this.issued += 1;
    return { state: 'signed-in', tokens: tokensFor(this.issued, this.now(), this.subject, this.email) };
  }

  async authorize(redirectUri: string): Promise<AuthorizationRequest> {
    return { url: `https://id.example.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=s1`, state: 's1', verifier: 'v1', redirectUri };
  }

  async exchange(code: string): Promise<StoredTokens> {
    if (this.failExchange) throw new Error(this.failExchange);
    if (code !== 'good-code') throw new Error('Sign-in was refused: Code not valid.');
    this.issued += 1;
    return tokensFor(this.issued, this.now(), this.subject, this.email);
  }

  async refresh(tokens: StoredTokens): Promise<StoredTokens> {
    this.refreshes += 1;
    if (this.failRefresh === 'ended') throw new SignInEnded('Token is not active');
    if (this.failRefresh === 'network') throw new Error('fetch failed');
    this.issued += 1;
    return { ...tokensFor(this.issued, this.now(), tokens.subject, tokens.email) };
  }

  async revoke(tokens: StoredTokens): Promise<void> {
    this.revoked.push(tokens.refreshToken);
  }
}

/** A loopback listener the test completes by hand. */
export function fakeListener(): { listen: () => Promise<LoopbackCallback>; complete(result: CallbackResult): void; closed(): boolean } {
  let settle: (result: CallbackResult) => void = () => undefined;
  let isClosed = false;
  return {
    listen: async () => {
      const result = new Promise<CallbackResult>((resolve) => (settle = resolve));
      return {
        redirectUri: 'http://127.0.0.1:50000/callback',
        result,
        close: () => {
          isClosed = true;
          settle({ error: 'Sign-in was cancelled.' });
        },
      };
    },
    complete: (result) => settle(result),
    closed: () => isClosed,
  };
}

export interface FakeSocket extends RelaySocket {
  token: string;
  deviceId: string;
  events: RelayEvents;
  sent: string[];
  pings: number;
  closedWith: number | null;
  /** The service answers pings (a pong) unless this is turned off. */
  answersPings: boolean;
}

export class FakeService implements ConnectService {
  sockets: FakeSocket[] = [];
  private nextId = 1;
  registered: RegisteredDevice[] = [];
  registerFails: Error | null = null;
  /** The account's keys, held records and waiting messages. */
  held = new FakeHeldService();
  removed: string[] = [];
  /** Access tokens the service refuses with 401, as it does an expired or revoked one. */
  rejected = new Set<string>();
  /** Every HTTP call, with the token it carried: `METHOD path token`. */
  seen: string[] = [];

  private check(token: string, what: string): void {
    this.seen.push(`${what} ${token}`);
    if (this.rejected.has(token)) throw new ServiceRefusal(401, 'sign-in', 'Your sign-in has expired. Sign in again.');
  }

  async config(): Promise<ServiceConfig> {
    return { issuer: 'https://id.example.test/realms/kestrel', relayPath: '/api/v1/relay' };
  }

  async registerDevice(accessToken: string, name: string, kind: DeviceKind = 'desktop', keys?: PublicIdentity): Promise<RegisteredDevice> {
    this.check(accessToken, 'POST /devices');
    if (this.registerFails) throw this.registerFails;
    const device = { id: `device-${this.nextId++}`, name };
    this.registered.push(device);
    this.held.addDevice(device.id, name, kind, keys ?? null);
    return device;
  }

  async call(token: string, deviceId: string, method: ServiceMethod, path: string, body?: unknown): Promise<unknown> {
    this.check(token, `${method} ${path}`);
    const answer = await this.held.call(deviceId, method, path, body);
    this.tell();
    return answer;
  }

  /** What the service says on the sockets after a call (join, join-ended, key-changed), to the devices connected. */
  private tell(): void {
    for (const notice of this.held.notices.splice(0)) {
      for (const socket of this.sockets) {
        if (socket.closedWith !== null || !notice.to.includes(socket.deviceId)) continue;
        queueMicrotask(() => socket.events.message(JSON.stringify(notice.message)));
      }
    }
  }

  async removeDevice(token: string, deviceId: string): Promise<void> {
    this.check(token, `DELETE /devices/${deviceId}`);
    this.removed.push(deviceId);
    this.held.removeDevice(deviceId);
  }

  openRelay(token: string, deviceId: string, events: RelayEvents): RelaySocket {
    const socket: FakeSocket = {
      token,
      deviceId,
      events,
      sent: [],
      pings: 0,
      closedWith: null,
      answersPings: true,
      send: (text) => void socket.sent.push(text),
      ping: () => {
        socket.pings += 1;
        if (socket.answersPings) queueMicrotask(() => events.pong());
      },
      close: (code) => {
        socket.closedWith = code ?? 1000;
      },
    };
    this.sockets.push(socket);
    return socket;
  }

  last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }

  /** The service accepts the socket and welcomes it. */
  welcome(socket: FakeSocket, expiresAt: number): void {
    socket.events.open();
    socket.events.message(JSON.stringify({ service: 'welcome', deviceId: socket.deviceId, limits: {}, signInExpiresAt: new Date(expiresAt).toISOString() }));
  }
}

type Row = Record<string, unknown>;

/**
 * The service's key and held-conversation API (the contract in kestrel-connect.md, "Phase 5 as
 * built"), in memory, for one account. Sealed strings are kept as given and never opened, as the
 * real service does; tests read `records` to check nothing in them is plaintext.
 */
export class FakeHeldService {
  devices = new Map<string, { id: string; name: string; kind: DeviceKind; keys: PublicIdentity | null }>();
  /** Requests to be let in (account stage 1). */
  joins = new Map<string, { id: string; device: string; commitment: string; createdAt: number; expiresAt: number }>();
  private joinCount = 0;
  /** What the service would say on the socket after the last call: `to` the device ids. */
  notices: { to: string[]; message: Record<string, unknown> }[] = [];
  generation: number | null = null;
  keyring: { version: number; text: string } | null = null;
  copies = new Map<string, { generation: number; wrapped: string }>();
  recovery: { generation: number; wrapped: string } | null = null;
  previous: { generation: number; sealed: string }[] = [];
  rotationDue: { name: string; removedAt: string }[] | null = null;
  records = new Map<string, { id: string; generation: number; session: string | null; project: string | null; body: string; bytes: number; seq: number; version: number; writer: string; list: string | null }>();
  /** The account's number for the last write or delete of a record, and the listed records deleted (the change feed). */
  seq = 0;
  /** Records a read answers as missing, as if still on their way (a test of an upload that lags its head). */
  withhold: ((record: { list: string | null }) => boolean) | null = null;
  tombstones = new Map<string, { list: string; seq: number }>();
  messages = new Map<string, { id: string; from: string; to: string; generation: number; body: string; bytes: number; createdAt: number }>();
  limit = 512 * 1024 * 1024;
  /** Phones' push tokens and sealed choices (phase 6). */
  push = new Map<string, { token: string | null; generation: number | null; prefs: string | null }>();
  /** What was handed to Apple: one entry per device a push went to. */
  pushed: { deviceId: string; id: string; generation: number; body: string }[] = [];
  calls: string[] = [];
  /** Devices withdrawn from the keyring (step 8b), in order. */
  withdrawn: string[] = [];
  /** Makes every call fail as if the service could not be reached. */
  down = false;
  /** A service from before the change feed: a record with a list is a request it does not know, and it has no feed. */
  beforeFeed = false;
  /** The service takes renames (`PATCH /devices/:id`); false is a service from before that route. */
  renames = true;

  /** What the service does with `PATCH /devices/:id`: the name only, for any device of the account, then tells the others. */
  private rename(from: string, id: string, name: unknown): unknown {
    if (!this.renames) this.refuse(404, 'not-found', 'Cannot PATCH /api/v1/devices.');
    const device = this.devices.get(id);
    if (!device) this.refuse(404, 'unknown-device', 'No device on your account has that id. It may have been removed already.');
    const text = typeof name === 'string' ? name.trim() : '';
    if (!text || text.length > 64 || /\p{Cc}/u.test(text)) this.refuse(400, 'bad-request', 'A device needs a name of at most 64 characters.');
    device.name = text;
    this.notices.push({ to: [...this.devices.keys()].filter((d) => d !== from), message: { service: 'devices-changed' } });
    return { device };
  }

  addDevice(id: string, name: string, kind: DeviceKind, keys: PublicIdentity | null = null): void {
    this.devices.set(id, { id, name, kind, keys });
  }

  private joinView(j: { id: string; device: string; commitment: string; createdAt: number; expiresAt: number }) {
    const d = this.devices.get(j.device);
    return { id: j.id, device: { id: j.device, name: d?.name ?? 'gone', kind: d?.kind ?? 'desktop' }, commitment: j.commitment, createdAt: new Date(j.createdAt).toISOString(), expiresAt: new Date(j.expiresAt).toISOString() };
  }

  private endJoin(id: string): void {
    if (!this.joins.delete(id)) return;
    this.notices.push({ to: [...this.devices.keys()], message: { service: 'join-ended', id } });
  }

  removeDevice(id: string): void {
    const device = this.devices.get(id);
    if (!device) return;
    this.devices.delete(id);
    this.copies.delete(id);
    for (const [key, j] of this.joins) if (j.device === id) this.joins.delete(key);
    this.push.delete(id);
    for (const [key, m] of this.messages) if (m.to === id) this.messages.delete(key);
    if (this.generation !== null) this.rotationDue = [...(this.rotationDue ?? []), { name: device.name, removedAt: new Date(0).toISOString() }];
  }

  private used(): number {
    let n = 0;
    for (const r of this.records.values()) n += r.bytes;
    for (const m of this.messages.values()) n += m.bytes;
    return n;
  }

  private refuse(status: number, code: string, reason: string): never {
    throw new ServiceRefusal(status, code, reason);
  }

  private current(generation: unknown): void {
    if (generation !== this.generation) this.refuse(409, 'key-changed', 'The account key changed. Read it again.');
  }

  /** A message a phone posts for a desk (what the iPhone app does). */
  post(message: { id: string; from: string; to: string; generation: number; body: string }): void {
    this.messages.set(message.id, { ...message, bytes: message.body.length, createdAt: Date.now() });
  }

  /** What a phone does when it registers for notifications, with its choices sealed (or none). */
  /** Deletes a record; a listed one leaves a tombstone with a number of its own, and the other devices are told. */
  private forget(id: string, by: string): void {
    const record = this.records.get(id);
    this.records.delete(id);
    if (!record?.list) return;
    this.tombstones.set(id, { list: record.list, seq: ++this.seq });
    this.changed(by);
  }

  /** The `changed` notice, to every device of the account but the writer. */
  private changed(by: string): void {
    this.notices.push({ to: [...this.devices.keys()].filter((d) => d !== by), message: { service: 'changed', seq: this.seq } });
  }

  registerPhone(deviceId: string, token: string, prefs: { generation: number; body: string } | null = null): void {
    this.push.set(deviceId, { token, generation: prefs?.generation ?? null, prefs: prefs?.body ?? null });
  }

  async call(deviceId: string, method: string, path: string, body?: unknown): Promise<unknown> {
    this.calls.push(`${method} ${path}`);
    if (this.down) throw new Error('fetch failed');
    if (!this.devices.has(deviceId)) this.refuse(403, 'unknown-device', 'No device on your account has that id.');
    const b = (body ?? {}) as Row;
    const [route, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    const parts = (route ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    const id = parts[2];
    const key = parts[0] === 'held' && id && id !== 'inbox' && id !== 'read' ? `${method} /held/${parts[1]}/:id` : parts[0] === 'join' && parts[1] ? `${method} /join/:id` : `${method} /${parts.join('/')}`;
    if (method === 'PATCH' && parts[0] === 'devices' && parts.length === 2) return this.rename(deviceId, parts[1] as string, b.name);
    switch (key) {
      case 'GET /devices':
        return { devices: [...this.devices.values()] };
      case 'PUT /devices/keys': {
        const device = this.devices.get(deviceId)!;
        const keys = { signing: b.signing as string, agreement: b.agreement as string };
        if (device.keys && (device.keys.signing !== keys.signing || device.keys.agreement !== keys.agreement)) this.refuse(409, 'keys-set', "This device's keys are already set. Remove it and register it again to change them.");
        device.keys = keys;
        return { device };
      }
      case 'POST /join': {
        if (!this.devices.get(deviceId)?.keys) this.refuse(409, 'no-keys', "Put this device's public keys first.");
        if (this.generation === null) this.refuse(409, 'no-account-key', 'Your account has no key yet: nothing to join.');
        if (this.copies.get(deviceId)?.generation === this.generation) this.refuse(409, 'already-in', 'This device holds your account key already.');
        for (const [id, j] of this.joins) if (j.device === deviceId) this.endJoin(id);
        const now = Date.now();
        const join = { id: `join-${++this.joinCount}`, device: deviceId, commitment: b.commitment as string, createdAt: now, expiresAt: now + 600_000 };
        this.joins.set(join.id, join);
        this.notices.push({ to: [...this.devices.keys()].filter((d) => d !== deviceId), message: { service: 'join', join: this.joinView(join) } });
        return { join: this.joinView(join) };
      }
      case 'GET /join':
        return { joins: [...this.joins.values()].filter((j) => j.expiresAt > Date.now()).map((j) => this.joinView(j)) };
      case 'DELETE /join/:id':
        if (!this.joins.has(parts[1] as string)) this.refuse(404, 'unknown-join', 'No such request. It may have ended already.');
        this.endJoin(parts[1] as string);
        return null;
      case 'GET /push/devices':
        return { devices: [...this.push].map(([id, p]) => ({ deviceId: id, name: this.devices.get(id)?.name ?? 'a phone', environment: 'sandbox', hasToken: p.token !== null, generation: p.generation, prefs: p.prefs, updatedAt: new Date(0).toISOString() })) };
      case 'POST /push': {
        if (!isComputerKind(this.devices.get(deviceId)?.kind)) this.refuse(403, 'not-a-desktop', 'Only a computer sends notifications.');
        this.current(b.generation);
        if (typeof b.body !== 'string' || b.body.length > 3000) this.refuse(413, 'push-too-big', 'A notification is at most 3000 characters.');
        const to = b.to as string[];
        if (to.some((d) => this.devices.get(d)?.kind !== 'phone')) this.refuse(404, 'unknown-device', 'No device on your account has that id.');
        const sent = to.filter((d) => this.push.get(d)?.token);
        for (const d of sent) this.pushed.push({ deviceId: d, id: b.id as string, generation: b.generation as number, body: b.body });
        return { sent, skipped: to.filter((d) => !sent.includes(d)).map((d) => ({ deviceId: d, code: 'no-token' })) };
      }
      case 'GET /keys':
        return { generation: this.generation, keyring: this.keyring, copy: this.copies.get(deviceId) ?? null, recovery: this.recovery, previous: this.previous, rotationDue: this.rotationDue ? { removed: this.rotationDue } : null, holders: [...this.copies].filter(([, c]) => c.generation === this.generation).map(([id]) => id) };
      case 'POST /keys':
        if (this.generation !== null) this.refuse(409, 'key-exists', 'Your account has a key already.');
        this.generation = 1;
        this.keyring = { version: 1, text: b.keyring as string };
        this.recovery = { generation: 1, wrapped: b.recovery as string };
        this.copies.set(deviceId, { generation: 1, wrapped: b.wrapped as string });
        return { generation: 1, keyringVersion: 1 };
      case 'POST /keys/grant':
        this.current(b.generation);
        if (b.keyringVersion !== this.keyring?.version) this.refuse(409, 'key-changed', 'The keyring changed. Read it again.');
        if (!this.devices.has(b.deviceId as string)) this.refuse(404, 'unknown-device', 'No device on your account has that id.');
        this.keyring = { version: (this.keyring?.version ?? 0) + 1, text: b.keyring as string };
        this.copies.set(b.deviceId as string, { generation: this.generation as number, wrapped: b.wrapped as string });
        for (const [id, j] of this.joins) if (j.device === b.deviceId) this.endJoin(id);
        this.notices.push({ to: [b.deviceId as string], message: { service: 'key-changed', generation: this.generation } });
        return { keyringVersion: this.keyring.version };
      case 'POST /keys/withdraw':
        this.current(b.generation);
        if (b.keyringVersion !== this.keyring?.version) this.refuse(409, 'key-changed', 'The keyring changed. Read it again.');
        if (b.deviceId === deviceId) this.refuse(400, 'bad-request', 'A device cannot withdraw itself.');
        if (!this.devices.has(b.deviceId as string)) this.refuse(404, 'unknown-device', 'No device on your account has that id.');
        if (this.copies.get(b.deviceId as string)?.generation === this.generation) this.refuse(409, 'holds-key', 'That device holds your account key. Remove it instead.');
        this.keyring = { version: (this.keyring?.version ?? 0) + 1, text: b.keyring as string };
        this.withdrawn.push(b.deviceId as string);
        return { keyringVersion: this.keyring.version };
      case 'DELETE /keys/copy':
        this.copies.delete(deviceId);
        return null;
      case 'POST /keys/rotate': {
        this.current(b.from);
        const copies = b.copies as { deviceId: string; wrapped: string }[];
        if (!copies.some((c) => c.deviceId === deviceId)) this.refuse(400, 'bad-request', 'copies must include this device.');
        const generation = (this.generation as number) + 1;
        this.generation = generation;
        this.keyring = { version: 1, text: b.keyring as string };
        this.recovery = { generation, wrapped: b.recovery as string };
        this.previous = [...this.previous, { generation, sealed: b.previous as string }];
        this.copies = new Map(copies.filter((c) => this.devices.has(c.deviceId)).map((c) => [c.deviceId, { generation, wrapped: c.wrapped }]));
        this.rotationDue = null;
        for (const [id, p] of this.push) this.push.set(id, { ...p, generation: null, prefs: null });
        return { generation, keyringVersion: 1 };
      }
      case 'DELETE /keys/previous': {
        const stale = [...this.records.values(), ...this.messages.values()].filter((r) => r.generation < (this.generation ?? 0)).length;
        if (stale > 0) this.refuse(409, 'stale-records', `${stale} held records are still sealed under an older key.`);
        this.previous = [];
        return null;
      }
      case 'PUT /held/records/:id': {
        this.current(b.generation);
        const id = parts[2] as string;
        const bytes = (b.body as string).length;
        if (this.used() - (this.records.get(id)?.bytes ?? 0) + bytes > this.limit) this.refuse(413, 'held-full', 'Your account holds as much as it can. Delete some held conversations.');
        if (this.beforeFeed && (b.list !== undefined || b.ifVersion !== undefined)) this.refuse(400, 'bad-request', 'Unrecognized key.');
        const before = this.records.get(id);
        if (b.ifVersion !== undefined && (before?.version ?? null) !== b.ifVersion) this.refuse(409, 'record-changed', 'Another device wrote that record since this one read it. Read it again, merge, and write again.');
        const list = (b.list as string | null) ?? null;
        const record = { id, generation: b.generation as number, session: (b.session as string | null) ?? null, project: (b.project as string | null) ?? null, body: b.body as string, bytes, seq: ++this.seq, version: (before?.version ?? 0) + 1, writer: deviceId, list };
        this.records.set(id, record);
        this.tombstones.delete(id);
        if (list) this.changed(deviceId);
        return { record: { id, generation: b.generation, bytes, seq: record.seq, version: record.version, list }, usage: { bytes: this.used(), limit: this.limit } };
      }
      case 'GET /held/changes': {
        if (this.beforeFeed) this.refuse(404, 'not-found', 'Not found.');
        const list = params.get('list');
        const since = Number(params.get('since') ?? 0);
        const written = [...this.records.values()].filter((r) => r.list === list && (since === 0 || r.seq > since)).map((r) => ({ id: r.id, seq: r.seq, version: r.version, writer: r.writer, deleted: false }));
        const gone = since === 0 ? [] : [...this.tombstones].filter(([, t]) => t.list === list && t.seq > since).map(([id, t]) => ({ id, seq: t.seq, version: null, writer: null, deleted: true }));
        return { changes: [...written, ...gone].sort((a, b) => a.seq - b.seq), next: Math.max(this.seq, since), more: false };
      }
      case 'GET /held/records': {
        const below = Number(params.get('below'));
        return { records: [...this.records.values()].filter((r) => r.generation < below).slice(0, Number(params.get('limit') ?? 100)) };
      }
      case 'POST /held/records/read': {
        const ids = b.ids as string[];
        const held = (i: string) => this.records.has(i) && !this.withhold?.(this.records.get(i)!);
        return { records: ids.flatMap((i) => (held(i) ? [this.records.get(i)] : [])), missing: ids.filter((i) => !held(i)) };
      }
      case 'DELETE /held/records/:id':
        if (!this.records.has(parts[2] as string)) this.refuse(404, 'unknown-record', 'No such record.');
        this.forget(parts[2] as string, deviceId);
        return null;
      case 'DELETE /held/records': {
        const session = params.get('session');
        const project = params.get('project');
        let deleted = 0;
        for (const [id, r] of this.records) {
          if ((session && r.session === session) || (project && r.project === project)) {
            this.forget(id, deviceId);
            deleted += 1;
          }
        }
        return { deleted, bytes: 0 };
      }
      case 'GET /held/usage':
        return { bytes: this.used(), limit: this.limit, records: this.records.size, messages: this.messages.size };
      case 'GET /held/messages/inbox':
        return { messages: [...this.messages.values()].filter((m) => m.to === deviceId) };
      case 'DELETE /held/messages/:id':
        if (!this.messages.delete(parts[2] as string)) this.refuse(404, 'unknown-message', 'It was delivered, withdrawn, or expired.');
        return null;
      default:
        throw new Error(`the fake service has no ${key}`);
    }
  }
}

/**
 * The relay between the desks of one fake service: every frame a desk sends goes to the open socket of the
 * device named in `to`. A frame for a device with no socket open is answered as the service answers one it
 * cannot carry (`{ service: 'refused', id }`), unless `refuses` is off and it is only dropped. `lose` drops
 * the frames a check picks, as a network that ate them would.
 */
export class FakeRelay {
  readonly carried: string[] = [];
  refuses = true;
  private readonly losses: ((text: string) => boolean)[] = [];
  private readonly wired = new Set<FakeSocket>();

  constructor(private readonly service: FakeService) {}

  lose(check: (text: string) => boolean): void {
    this.losses.push(check);
  }

  /** Wires and welcomes every socket opened since the last call. */
  wire(): void {
    for (const socket of this.service.sockets) {
      if (this.wired.has(socket)) continue;
      this.wired.add(socket);
      const send = socket.send;
      socket.send = (text: string) => {
        send(text);
        this.carried.push(text);
        if (!this.losses.some((l) => l(text))) this.deliver(socket, text);
      };
      this.service.welcome(socket, Date.now() + 3_600_000);
    }
  }

  private deliver(from: FakeSocket, text: string): void {
    const frame = JSON.parse(text) as { to?: string; id?: string };
    const socket = [...this.service.sockets].reverse().find((s) => s.deviceId === frame.to && s.closedWith === null);
    if (socket) return queueMicrotask(() => socket.events.message(text));
    if (this.refuses && from.closedWith === null) queueMicrotask(() => from.events.message(JSON.stringify({ service: 'refused', id: frame.id ?? null, code: 'not-connected', reason: 'That device is not connected.' })));
  }
}
