// Kestrel Connect on the desktop: the sign-in, this computer's device identity, the one switch, and
// the relay link. It owns `ConnectView` (shared/connect.ts), pushes it whole on every change, and
// dials nothing while the switch is off or nobody is signed in (design doc kestrel-connect.md, 8-9).
import { CONNECT_OFF, type ConnectAccount, type ConnectLink, type ConnectView, type PairingOffer } from '../../shared/connect.ts';
import type { Envelope } from '../../shared/connect-ops.ts';
import { newIdentity } from '../keys.ts';
import { DeskChannel, type PairedDevice } from './channel.ts';
import { Refused } from '../../refused.ts';
import type { SettingStore } from '../../suggestions/prefs.ts';
import { SignInEnded, type AuthorizationRequest, type IdentityProvider } from './identity.ts';
import { listenForCallback, type LoopbackCallback } from './loopback.ts';
import { RelayLink } from './relay-link.ts';
import type { ConnectService } from './service.ts';
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

/** The paired devices as stored; anything malformed is dropped. */
function pairedOf(raw: unknown): PairedDevice[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is PairedDevice => typeof d === 'object' && d !== null && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.keys?.signing === 'string' && typeof d.keys?.agreement === 'string' && typeof d.pairedAt === 'number');
}

export class KestrelConnect {
  private data: VaultData = { tokens: null, device: null };
  private enabled = false;
  private account: ConnectAccount = { state: 'signed-out', reason: null };
  private signInUnderWay: { callback: LoopbackCallback; request: AuthorizationRequest } | null = null;
  private refreshing: Promise<StoredTokens> | null = null;
  private registering: Promise<string> | null = null;
  private readonly listeners = new Set<(view: ConnectView) => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private dispatcher: { deviceId: string; dispatch: Dispatch } | null = null;
  readonly link: RelayLink;
  readonly channel: DeskChannel;

  constructor(private readonly deps: ConnectDeps) {
    this.link = new RelayLink({
      service: deps.service,
      token: (fresh) => this.accessToken(fresh),
      deviceId: () => this.deviceId(),
      state: (link) => {
        if (link.state !== 'connected') this.channel.dropAll();
        this.changed();
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
      paired: () => pairedOf(this.data.paired),
      savePaired: (next) => this.save({ ...this.data, paired: next }),
      send: (text) => this.link.send(text),
      deliver: (frame) => void this.dispatchFor(frame.to)?.receive(frame),
      forget: (id) => this.dispatcher?.dispatch.forget(id),
      changed: () => this.changed(),
      here: deps.here ?? 'this computer',
      now: deps.now,
    });
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
    const raw = await this.deps.settings.getSetting(CONNECT_PREFS_KEY).catch(() => null);
    try {
      this.enabled = raw ? JSON.parse(raw).enabled === true : false;
    } catch {
      this.enabled = false;
    }
    const tokens = this.data.tokens;
    this.account = tokens ? { state: 'signed-in', email: tokens.email } : { state: 'signed-out', reason: null };
    this.follow();
    this.changed();
  }

  view(): ConnectView {
    const link: ConnectLink = this.link.link;
    const paired = pairedOf(this.data.paired).map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, connected: this.channel.connected(d.id) }));
    return { enabled: this.enabled, account: this.account, link: this.deps.unavailable ? CONNECT_OFF : link, storage: this.deps.vault.storage, computerName: this.deps.computerName, unavailable: this.deps.unavailable ?? null, paired, pairing: this.channel.pairing() };
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
    await this.deps.settings.putSetting(CONNECT_PREFS_KEY, JSON.stringify({ enabled }));
    this.enabled = enabled;
    this.follow();
    this.changed();
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
  async accessToken(fresh = false): Promise<string> {
    const tokens = this.data.tokens;
    if (!tokens) throw new SignInEnded('Nobody is signed in.');
    const now = this.deps.now?.() ?? Date.now();
    if (!fresh && tokens.accessExpiresAt - now > FRESH_FOR_MS) return tokens.accessToken;
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
        const registered = await this.deps.service.registerDevice(await this.accessToken(), this.deps.computerName);
        const stored: StoredDevice = { subject: tokens.subject, id: registered.id, name: registered.name, signing: keys.signing, agreement: keys.agreement };
        await this.save({ ...this.data, device: stored });
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

  /** Opens the pairing page's code. Refused unless this computer is connected, so a phone can reach it. */
  startPairing(): PairingOffer {
    if (this.deps.unavailable) throw new Refused(this.deps.unavailable);
    if (this.link.link.state !== 'connected') throw new Refused('Turn Kestrel Connect on, sign in, and wait until it says Connected, then pair a phone.');
    return this.channel.startPairing();
  }

  stopPairing(): void {
    this.channel.stopPairing();
  }

  /** Ends a paired device's access to this computer at once. */
  async removeDevice(deviceId: string): Promise<ConnectView> {
    if (!(await this.channel.remove(deviceId))) throw new Refused('That device is not paired with this computer.');
    await this.writes;
    return this.view();
  }

  async close(): Promise<void> {
    this.cancelSignIn();
    this.link.stop();
    this.dispatcher?.dispatch.close();
    this.dispatcher = null;
    this.listeners.clear();
    await this.writes;
  }
}
