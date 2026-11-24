// Kestrel Connect on the desktop: the sign-in, this computer's device identity, the one switch, and
// the relay link. It owns `ConnectView` (shared/connect.ts), pushes it whole on every change, and
// dials nothing while the switch is off or nobody is signed in (design doc kestrel-connect.md, 8-9).
import { CONNECT_OFF, type ConnectAccount, type ConnectDevice, type ConnectHeld, type ConnectLink, type ConnectView, NO_PUSH } from '../../shared/connect.ts';
import type { Envelope } from '../../shared/connect-ops.ts';
import { newIdentity, publicIdentity } from '../keys.ts';
import { DeskChannel } from './channel.ts';
import { AccountJoin } from './join.ts';
import { asJoinRequest, JoinApi, type ServiceDevice } from './join-api.ts';
import { Refused } from '../../refused.ts';
import type { SettingStore } from '../../suggestions/prefs.ts';
import { SignInEnded, type AuthorizationRequest, type IdentityProvider } from './identity.ts';
import { listenForCallback, type LoopbackCallback } from './loopback.ts';
import { DIAL_FRESH_FOR_MS, RelayLink } from './relay-link.ts';
import { ServiceRefusal, type ConnectService, type ServiceMethod } from './service.ts';
import { AccountKeys, type KeysTrust } from './account-keys.ts';
import { HeldApi, type ServiceCall } from './held-api.ts';
import { PushApi } from './push-api.ts';
import { PushNotices, type PushSource } from './push.ts';
import { DEFAULT_HELD_PREFS, HeldConversations, type HeldPrefs, type HeldSource } from './held.ts';
import type { QueueStore } from './held-queue.ts';
import type { StoredDevice, StoredTokens, Vault, VaultData } from './vault.ts';

export const CONNECT_PREFS_KEY = 'kestrel-connect';
/** An access token this close to expiry is renewed before use. */
const FRESH_FOR_MS = 60_000;

export interface ConnectDeps {
  vault: Vault;
  identity: IdentityProvider;
  service: ConnectService;
  settings: SettingStore;
  computerName: string;
  /** Why Connect cannot be used in this copy (sample data), or null. */
  unavailable?: string | null;
  listen?: typeof listenForCallback;
  /** Makes the dispatcher for this computer's device id (connect/dispatcher.ts); none in tests of the link alone. */
  dispatch?: (deviceId: string, send: (frame: Envelope) => void) => Dispatch;
  /** "your Mac", in what a phone is told. */
  here?: string;
  /** Held conversations: what they are read from, and where the upload queue is kept. None in tests of the link alone. */
  held?: { source: HeldSource; queue: QueueStore };
  /** Push notifications: what the rule reads. None in tests of the link alone. */
  push?: { source: PushSource };
  now?(): number;
  random?(): number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What of the dispatcher the module uses. */
export interface Dispatch {
  receive(frame: unknown): Promise<unknown>;
  forget(device: string): void;
  close(): void;
}

/** The switch and the held-conversation choices, as kept in the settings store. */
function prefsOf(raw: string | null): { enabled: boolean; held: HeldPrefs } {
  try {
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const keptOff = Array.isArray(value.keptOff) ? value.keptOff.filter((p): p is string => typeof p === 'string') : [];
    return { enabled: value.enabled === true, held: { keptOff, attachments: value.attachments === true } };
  } catch {
    return { enabled: false, held: DEFAULT_HELD_PREFS };
  }
}

function trustOf(raw: unknown): KeysTrust | null {
  const t = (typeof raw === 'object' && raw !== null ? raw : null) as Partial<KeysTrust> | null;
  if (!t || typeof t.generation !== 'number' || !Array.isArray(t.devices)) return null;
  return { generation: t.generation, devices: t.devices.filter((d) => typeof d?.id === 'string' && typeof d.signing === 'string'), wordsPending: t.wordsPending === true, changedBecause: Array.isArray(t.changedBecause) ? t.changedBecause.filter((n): n is string => typeof n === 'string') : null };
}

const NO_HELD: ConnectHeld = { ...DEFAULT_HELD_PREFS, problem: null, usage: null, lastUploadAt: null };

export class KestrelConnect {
  private data: VaultData = { tokens: null, device: null };
  private enabled = false;
  private heldPrefs: HeldPrefs = DEFAULT_HELD_PREFS;
  private account: ConnectAccount = { state: 'signed-out', reason: null };
  private signInUnderWay: { callback: LoopbackCallback; request: AuthorizationRequest } | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private registering: Promise<string> | null = null;
  private readonly listeners = new Set<(view: ConnectView) => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private dispatcher: { deviceId: string; dispatch: Dispatch } | null = null;
  /** The account's devices, read from the service while connected. */
  private accountDevices: ServiceDevice[] = [];
  /** Devices removed here: refused at once, before the keyring is rotated without them. */
  private readonly removedHere = new Set<string>();
  readonly link: RelayLink;
  readonly channel: DeskChannel;
  readonly keys: AccountKeys;
  readonly join: AccountJoin;
  readonly held: HeldConversations | null;
  readonly push: PushNotices | null;

  constructor(private readonly deps: ConnectDeps) {
    this.keys = new AccountKeys({
      api: () => this.api(),
      me: () => {
        const device = this.data.device;
        return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: device.name, kind: 'desktop' as const, identity: device } : null;
      },
      trust: () => trustOf(this.data.keys),
      saveTrust: (next) => this.save({ ...this.data, keys: next }),
      changed: () => this.changed(),
      now: deps.now,
    });
    this.held = deps.held
      ? new HeldConversations({
          source: deps.held.source,
          queue: deps.held.queue,
          api: () => (this.link.link.state === 'connected' ? this.api() : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          resync: () => this.keys.sync(),
          desk: () => {
            const device = this.data.device;
            return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: device.name } : null;
          },
          prefs: () => this.heldPrefs,
          changed: () => this.changed(),
          here: deps.here ?? 'this computer',
          now: deps.now,
        })
      : null;
    this.push = deps.push
      ? new PushNotices({
          source: deps.push.source,
          api: () => (this.link.link.state === 'connected' ? new PushApi(this.call()) : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          desk: () => {
            const device = this.data.device;
            return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: device.name } : null;
          },
          changed: () => this.changed(),
          now: deps.now,
        })
      : null;
    this.link = new RelayLink({
      service: deps.service,
      token: (fresh) => this.accessToken(fresh, DIAL_FRESH_FOR_MS),
      deviceId: () => this.deviceId(),
      state: (link) => {
        if (link.state !== 'connected') this.channel.dropAll();
        else {
          this.channel.linkBack();
          void this.linkUp();
        }
        this.changed();
      },
      notice: (kind, notice) => {
        if (kind === 'held-messages') void this.held?.deliverWaiting();
        if (kind === 'push-devices') void this.push?.refreshPhones();
        // Another device rotated the key or this one was given a copy: open it now, not at the next reconnect.
        if (kind === 'key-changed') void this.linkUp();
        if (kind === 'join') {
          const request = asJoinRequest(notice.join);
          if (request) this.join.noticed(request);
          void this.refreshDevices();
        }
        if (kind === 'join-ended' && typeof notice.id === 'string') this.join.ended(notice.id);
      },
      frame: (text) => void this.channel.receive(text),
      signedOut: (reason) => void this.endSignIn(`the sign-in expired or was ended (${reason}). Sign in again.`),
      deviceGone: () => void this.save({ ...this.data, device: null }),
      now: deps.now,
      random: deps.random,
    });
    this.channel = new DeskChannel({
      me: () => {
        const device = this.data.device;
        return device && device.subject === this.data.tokens?.subject ? { id: device.id, identity: device } : null;
      },
      member: (id) => (this.removedHere.has(id) ? null : this.keys.member(id)),
      holdsKey: () => {
        const device = this.data.device;
        return device !== null && this.keys.member(device.id) !== null;
      },
      join: (from, body) => this.join.receive(from, body),
      send: (text) => this.link.send(text),
      deliver: (frame) => void this.dispatchFor(frame.to)?.receive(frame),
      forget: (id) => this.dispatcher?.dispatch.forget(id),
      changed: () => this.changed(),
      here: deps.here ?? 'this computer',
      now: deps.now,
    });
    this.join = new AccountJoin({
      api: () => (this.link.link.state === 'connected' ? new JoinApi(this.call()) : null),
      me: () => {
        const device = this.data.device;
        return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: device.name, kind: 'desktop', identity: device } : null;
      },
      keys: this.keys,
      hello: (to, body) => this.channel.sendHello(to, body),
      changed: () => this.changed(),
      joined: () => void this.linkUp(),
      letIn: () => void this.refreshDevices(),
      now: deps.now,
    });
  }

  /** The service's API as this computer's device, the token renewed once when it is refused as expired. */
  private api(): HeldApi {
    return new HeldApi(this.call());
  }

  /** One call to the service as this computer's device (signedIn). */
  private call(): ServiceCall {
    return async (method: ServiceMethod, path: string, body?: unknown) => {
      const deviceId = await this.deviceId();
      return this.signedIn((token) => this.deps.service.call(token, deviceId, method, path, body));
    };
  }

  /**
   * Every HTTP call to the service goes through here: with a token renewed when it is close to expiry
   * (accessToken), and, when the service still refuses it as expired or revoked (401), once more with a
   * token renewed now. A second 401 is the caller's to say.
   */
  private async signedIn<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(await this.accessToken());
    } catch (error) {
      if (!(error instanceof ServiceRefusal && error.status === 401)) throw error;
      return request(await this.accessToken(true));
    }
  }

  /**
   * Connected: this computer's public keys are put, the account key is read, the account's devices and
   * open requests are read; then, holding the key, held conversations catch up and waiting messages are
   * taken, or, not holding it, this computer asks to be let in (once on its own).
   */
  private async linkUp(): Promise<void> {
    const up = () => this.link.link.state === 'connected';
    await this.putKeys();
    if (!up()) return;
    await this.keys.sync();
    // The link may have ended meanwhile (this computer was removed: its device is forgotten, and nothing
    // here may register it again).
    if (!up()) return;
    void this.refreshDevices();
    this.channel.endStrangers();
    if (!this.keys.ready()) {
      // Step 8b: a copy it cannot open, with no join under way (it was closed part-way through one), is deleted, so
      // this computer comes back out of the account, not half in, and asks again.
      if (this.keys.stranded() && !this.join.busy()) await this.keys.discardCopy().catch((error: unknown) => console.error(`[kestrel] could not delete a key copy this computer cannot open: ${message(error)}`));
      if (this.keys.keysState() === 'locked') await this.join.askOnce();
      return;
    }
    await this.join.refresh().catch((error: unknown) => console.error(`[kestrel] could not read requests to join the account: ${message(error)}`));
    this.held?.kick();
    void this.push?.refreshPhones();
    await this.held?.deliverWaiting();
    await this.keys.reseal().catch((error: unknown) => console.error(`[kestrel] could not re-seal held conversations under the new key: ${message(error)}`));
  }

  /** Puts this computer's public keys at the service when it has none (a device registered before protocol 3). */
  private async putKeys(): Promise<void> {
    const device = this.data.device;
    if (!device || this.data.keysPut === device.id) return;
    try {
      await new JoinApi(this.call()).putKeys(publicIdentity(device));
      await this.save({ ...this.data, keysPut: device.id });
    } catch (error) {
      console.error(`[kestrel] could not give Kestrel Connect this computer's public keys: ${message(error)}`);
    }
  }

  /** Reads the account's devices again, for the device list. */
  private async refreshDevices(): Promise<void> {
    if (this.link.link.state !== 'connected') return;
    try {
      this.accountDevices = await new JoinApi(this.call()).devices();
      this.changed();
    } catch (error) {
      console.error(`[kestrel] could not read the account's devices: ${message(error)}`);
    }
  }

  /** The dispatcher for this computer's id, made when first needed and remade if the id changes. */
  private dispatchFor(deviceId: string): Dispatch | null {
    if (!this.deps.dispatch) return null;
    if (this.dispatcher?.deviceId !== deviceId) {
      this.dispatcher?.dispatch.close();
      this.dispatcher = { deviceId, dispatch: this.deps.dispatch(deviceId, (frame) => this.channel.sendSealed(frame)) };
    }
    return this.dispatcher.dispatch;
  }

  /** Reads the stored sign-in and switch, and starts the link when both say so. */
  async start(): Promise<void> {
    this.data = await this.deps.vault.read();
    // Protocol 3: nothing is paired any more; the list kept for part B is gone (kestrel-connect.md, "Account stage 1 as built").
    if (this.data.paired !== undefined) {
      const { paired: _gone, ...rest } = this.data;
      void _gone;
      await this.save(rest);
    }
    const prefs = prefsOf(await this.deps.settings.getSetting(CONNECT_PREFS_KEY).catch(() => null));
    this.enabled = prefs.enabled;
    this.heldPrefs = prefs.held;
    const tokens = this.data.tokens;
    this.account = tokens ? { state: 'signed-in', email: tokens.email } : { state: 'signed-out', reason: null };
    this.follow();
    this.changed();
  }

  view(): ConnectView {
    const link: ConnectLink = this.link.link;
    const connected = link.state === 'connected';
    const members = new Set(this.keys.memberIds());
    const here = this.data.device?.id ?? null;
    const devices: ConnectDevice[] = connected ? this.accountDevices.map((d) => ({ id: d.id, name: d.name, kind: d.kind, inAccount: members.has(d.id), connected: this.channel.connected(d.id), here: d.id === here })) : [];
    return {
      enabled: this.enabled,
      account: this.account,
      link: this.deps.unavailable ? CONNECT_OFF : link,
      storage: this.deps.vault.storage,
      computerName: this.deps.computerName,
      unavailable: this.deps.unavailable ?? null,
      devices,
      joining: connected ? this.join.joining() : null,
      requests: connected && this.keys.ready() ? this.join.requests() : [],
      keys: this.keys.view(),
      held: this.held?.view() ?? { ...NO_HELD, ...this.heldPrefs },
      push: this.push?.view() ?? NO_PUSH,
    };
  }

  onChange(listener: (view: ConnectView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }

  /** Starts or stops the link to match the switch and the sign-in. */
  private follow(): void {
    const should = !this.deps.unavailable && this.enabled && this.account.state === 'signed-in';
    if (should) this.link.start();
    else if (this.link.link.state !== 'off') this.link.stop();
  }

  private save(data: VaultData): Promise<void> {
    this.data = data;
    const work = this.writes.then(() => this.deps.vault.write(data));
    this.writes = work.catch((error: unknown) => console.error(`[kestrel] could not store Kestrel Connect's sign-in: ${message(error)}`));
    return work;
  }

  async setEnabled(enabled: boolean): Promise<ConnectView> {
    if (this.deps.unavailable) throw new Refused(this.deps.unavailable);
    await this.savePrefs(enabled, this.heldPrefs);
    this.enabled = enabled;
    if (!enabled) {
      this.keys.reset();
      this.join.reset();
    }
    this.follow();
    this.changed();
    return this.view();
  }

  private savePrefs(enabled: boolean, held: HeldPrefs): Promise<void> {
    return this.deps.settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled, keptOff: held.keptOff, attachments: held.attachments }));
  }

  /** Which projects are kept off, and whether attachments are held. Saved as changed; what is no longer held is deleted from the service. */
  async setHeld(change: { keptOff?: string[]; attachments?: boolean }): Promise<ConnectView> {
    if (this.deps.unavailable) throw new Refused(this.deps.unavailable);
    const before = this.heldPrefs;
    const keptOff = change.keptOff ? [...new Set(change.keptOff)] : before.keptOff;
    if (keptOff.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 200)) throw new Refused('keptOff must list project ids.');
    const after: HeldPrefs = { keptOff, attachments: change.attachments ?? before.attachments };
    await this.savePrefs(this.enabled, after);
    this.heldPrefs = after;
    await this.held?.prefsChanged(before, after);
    this.changed();
    return this.view();
  }

  /** The recovery words, shown from this computer because it holds the account key. */
  recoveryWords(): { words: string[] } {
    return { words: this.keys.words() };
  }

  async recoveryPutAway(): Promise<ConnectView> {
    await this.keys.wordsPutAway();
    return this.view();
  }

  /** Lets this computer in with the recovery words. */
  async recover(words: string): Promise<ConnectView> {
    if (this.link.link.state !== 'connected') throw new Refused('Turn Kestrel Connect on, sign in, and wait until it says Connected, then enter the recovery key.');
    await this.keys.recover(words);
    void this.linkUp();
    return this.view();
  }

  /** Begins a sign-in: the browser is sent to the returned address and comes back to a loopback listener. */
  async signIn(): Promise<{ url: string }> {
    if (this.deps.unavailable) throw new Refused(this.deps.unavailable);
    if (this.account.state === 'signed-in') throw new Refused(`Already signed in as ${this.account.email}. Sign out first to use another account.`);
    if (this.signInUnderWay) return { url: this.signInUnderWay.request.url };
    let callback: LoopbackCallback | null = null;
    let request: AuthorizationRequest;
    try {
      let state: string | null = null;
      callback = await (this.deps.listen ?? listenForCallback)(() => state);
      request = await this.deps.identity.authorize(callback.redirectUri);
      state = request.state;
    } catch (error) {
      callback?.close();
      throw new Refused(`Kestrel Connect could not be reached to sign in: ${message(error)}`);
    }
    const underWay = { callback, request };
    this.signInUnderWay = underWay;
    this.account = { state: 'signing-in', url: request.url };
    this.changed();
    void callback.result.then((result) => this.finishSignIn(underWay, result));
    return { url: request.url };
  }

  private async finishSignIn(underWay: NonNullable<KestrelConnect['signInUnderWay']>, result: { code: string } | { error: string }): Promise<void> {
    if (this.signInUnderWay !== underWay) return;
    try {
      if ('error' in result) throw new Error(result.error);
      const tokens = await this.deps.identity.exchange(result.code, underWay.request);
      if (this.signInUnderWay !== underWay) return;
      const device = this.data.device?.subject === tokens.subject ? this.data.device : null;
      await this.save({ ...this.data, tokens, device });
      this.account = { state: 'signed-in', email: tokens.email };
    } catch (error) {
      if (this.signInUnderWay !== underWay) return;
      this.account = { state: 'signed-out', reason: message(error) };
    } finally {
      if (this.signInUnderWay === underWay) this.signInUnderWay = null;
    }
    this.follow();
    this.changed();
  }

  cancelSignIn(): void {
    const underWay = this.signInUnderWay;
    if (!underWay) return;
    this.signInUnderWay = null;
    underWay.callback.close();
    this.account = { state: 'signed-out', reason: null };
    this.changed();
  }

  async signOut(): Promise<ConnectView> {
    this.cancelSignIn();
    const tokens = this.data.tokens;
    this.link.stop();
    this.keys.reset();
    this.join.reset();
    // The device keys stay: signing in again to the same account keeps this computer's identity.
    await this.save({ ...this.data, tokens: null });
    this.account = { state: 'signed-out', reason: null };
    this.changed();
    if (tokens) void this.deps.identity.revoke(tokens).catch(() => undefined);
    return this.view();
  }

  private async endSignIn(reason: string): Promise<void> {
    this.link.stop();
    await this.save({ ...this.data, tokens: null });
    this.account = { state: 'signed-out', reason };
    this.changed();
  }

  /** A current access token, renewed when it is about to expire or when `fresh`. */
  async accessToken(fresh = false, goodFor = FRESH_FOR_MS): Promise<string> {
    const tokens = this.data.tokens;
    if (!tokens) throw new SignInEnded('Nobody is signed in.');
    const now = this.deps.now?.() ?? Date.now();
    if (!fresh && tokens.accessExpiresAt - now > goodFor) return tokens.accessToken;
    this.refreshing ??= (async () => {
      try {
        const renewed = await this.deps.identity.refresh(tokens);
        await this.save({ ...this.data, tokens: renewed });
        return renewed;
      } finally {
        this.refreshing = null;
      }
    })();
    return (await this.refreshing).accessToken;
  }

  /** This computer's id on the signed-in account, registering it (with new keys) the first time. */
  async deviceId(): Promise<string> {
    const tokens = this.data.tokens;
    if (!tokens) throw new SignInEnded('Nobody is signed in.');
    const device = this.data.device;
    if (device && device.subject === tokens.subject) return device.id;
    this.registering ??= (async () => {
      try {
        const keys = device?.subject === tokens.subject ? device : newIdentity();
        const identity = { signing: keys.signing, agreement: keys.agreement };
        const registered = await this.signedIn((token) => this.deps.service.registerDevice(token, this.deps.computerName, 'desktop', publicIdentity(identity)));
        const stored: StoredDevice = { subject: tokens.subject, id: registered.id, name: registered.name, signing: keys.signing, agreement: keys.agreement };
        await this.save({ ...this.data, device: stored, keysPut: stored.id });
        return stored.id;
      } finally {
        this.registering = null;
      }
    })();
    return this.registering;
  }

  /** This computer's stored device, for part B's keys. */
  device(): StoredDevice | null {
    return this.data.device;
  }

  /** Asks again to be let into the account, with a new nonce. */
  async askToJoin(): Promise<ConnectView> {
    if (this.keys.ready()) throw new Refused('This computer is in your account already.');
    await this.join.ask();
    return this.view();
  }

  /** Step 8a: the second code, shown on the device that let this computer in, typed here. */
  async confirmJoin(code: string): Promise<ConnectView> {
    await this.join.confirm(code);
    return this.view();
  }

  /** Step 8a, cancelled: the key offered is not kept. */
  async cancelJoin(): Promise<ConnectView> {
    await this.join.cancel();
    return this.view();
  }

  /** The second code was typed on the new device: it stops being shown here. */
  dismissRequest(id: string): ConnectView {
    this.join.dismiss(id);
    return this.view();
  }

  /** Opens another device's request here, so the code it shows can be typed. */
  openRequest(id: string): ConnectView {
    this.join.open(id);
    return this.view();
  }

  /** The code typed for a request: the device is let in when it is right. */
  async typeCode(id: string, code: string): Promise<ConnectView> {
    await this.join.type(id, code);
    return this.view();
  }

  /** Not me: the request is refused. */
  async refuseRequest(id: string): Promise<ConnectView> {
    await this.join.refuse(id);
    return this.view();
  }

  /**
   * Removes a device: its access to this computer ends at once, it is removed from the account, and
   * the account key is rotated so it cannot read what is held from now on. No Undo: it asks first.
   */
  async removeDevice(deviceId: string): Promise<ConnectView> {
    if (deviceId === this.data.device?.id) throw new Refused('This computer cannot remove itself. Sign out, or remove it from another device.');
    if (this.link.link.state === 'connected' && !this.accountDevices.some((d) => d.id === deviceId)) throw new Refused('That device is not on your account.');
    this.removedHere.add(deviceId);
    this.channel.remove(deviceId);
    await this.writes;
    if (this.data.tokens) {
      try {
        await this.signedIn((token) => this.deps.service.removeDevice(token, deviceId));
      } catch (error) {
        throw new Refused(`The device can no longer reach this computer, but Kestrel Connect could not remove it from your account: ${message(error)} Remove it again when Connect is back.`);
      }
      this.accountDevices = this.accountDevices.filter((d) => d.id !== deviceId);
      if (this.link.link.state === 'connected') void this.keys.sync().then(() => this.keys.reseal()).catch((error: unknown) => console.error(`[kestrel] could not rotate the account key: ${message(error)}`));
    }
    return this.view();
  }

  async close(): Promise<void> {
    this.cancelSignIn();
    this.link.stop();
    this.dispatcher?.dispatch.close();
    this.dispatcher = null;
    await this.held?.close();
    this.push?.close();
    this.listeners.clear();
    await this.writes;
  }
}
