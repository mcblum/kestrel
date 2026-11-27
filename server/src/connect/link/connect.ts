// Kestrel Connect on the desktop: the sign-in, this computer's device identity, the one switch, and
// the relay link. It owns `ConnectView` (shared/connect.ts), pushes it whole on every change, and
// dials nothing while the switch is off or nobody is signed in (design doc kestrel-connect.md, 8-9).
import { CONNECT_OFF, CONNECT_SIGN_IN, deviceKindFor, deviceNameOf, isComputerKind, recoveryWordsRefusal, type ConnectAccount, type ConnectDevice, type ConnectHeld, type ConnectLink, type ConnectView, NO_PUSH } from '../../shared/connect.ts';
import type { Envelope } from '../../shared/connect-ops.ts';
import { newIdentity, publicIdentity } from '../keys.ts';
import { DeskChannel } from './channel.ts';
import { routeFrame, type DeskCaller } from './caller.ts';
import { remoteCalls, type RemoteSessions } from './remote-sessions.ts';
import { AccountJoin } from './join.ts';
import { asJoinRequest, JoinApi, type ServiceDevice } from './join-api.ts';
import { Refused } from '../../refused.ts';
import type { SettingStore } from '../../suggestions/prefs.ts';
import { SignInEnded, type AuthorizationRequest, type DeviceAuthorization, type IdentityProvider } from './identity.ts';
import { pollDeviceGrant, promptOf, type DeviceSignInPrompt } from './device-sign-in.ts';
import type { KestrelKind } from '../../shared/host-kind.ts';
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
import { SetupRecords } from './setup-records.ts';
import type { PublishedGit } from '../../shared/node-commands.ts';
import type { DeskOps } from '../dispatcher.ts';
import { copyValues, type CopyDeps, type CopyReport } from '../../setup-values/copy.ts';
import { readValues, sourceText, type ValueSources } from '../../setup-values/read.ts';
import { ValueRequests } from '../../setup-values/requests.ts';
import type { DiscoveredServer } from '../../shared/setup.ts';
import { ReplicaSync } from './replica-sync.ts';
import type { AccountReplica } from '../../account-replica.ts';
import type { AccountProjects } from '../../account-projects.ts';
import { ProjectSync, ProjectUploader } from './project-sync.ts';
import { SeenSync, type SeenSource } from './seen-sync.ts';
import { OffersSync, type OffersSyncDeps } from './offers-sync.ts';
import type { AccountOffers } from '../../account-offers.ts';
import type { OffersSource } from '../../remote-starts/offers.ts';
import type { SetupRecord } from '../../shared/setup-record.ts';
import { setupListOf, type SetupChecks, type SetupList } from '../../shared/setup-list.ts';
import { SetupSteps, type Execute } from '../../setup-actions/steps.ts';
import type { SetupFileRecord } from '../../shared/setup-files.ts';

export const CONNECT_PREFS_KEY = 'kestrel-connect';
/** The name the user gave this computer, kept here whether or not Connect is on: `{ name, unsent }`. */
export const COMPUTER_NAME_KEY = 'connect.computerName';
/** An access token this close to expiry is renewed before use. */
const FRESH_FOR_MS = 60_000;

export interface ConnectDeps {
  vault: Vault;
  identity: IdentityProvider;
  service: ConnectService;
  settings: SettingStore;
  /** The host name, the name when the user gave none. */
  computerName: string;
  /** Why Connect cannot be used in this copy (sample data), or null. */
  unavailable?: string | null;
  /** Which kind of server this is (`hostKind`): how it signs in and what it registers as (`CONNECT_SIGN_IN`). Default: the app. */
  kind?: KestrelKind;
  listen?: typeof listenForCallback;
  /** Makes the dispatcher for this computer's device id (connect/dispatcher.ts); none in tests of the link alone. `desk`: the desk-only operations' part. */
  dispatch?: (deviceId: string, send: (frame: Envelope) => void, desk: DeskOps) => Dispatch;
  /** "your Mac", in what a phone is told. */
  here?: string;
  /** Held conversations: what they are read from, and where the upload queue is kept. None in tests of the link alone. */
  held?: { source: HeldSource; queue: QueueStore };
  /** Push notifications: what the rule reads. None in tests of the link alone. */
  push?: { source: PushSource };
  /** Set-up records (onboarding.md): how this machine is read, given the projects kept off. None in tests of the link alone. */
  setup?: {
    inventory(desk: { id: string; name: string }, keptOff: readonly string[]): Promise<SetupRecord>;
    checks: SetupChecks;
    sample?: () => SetupList;
    preview?: (name: string) => Promise<SetupList>;
    execute?: Execute;
    fileRecords?(): readonly SetupFileRecord[];
    /** Reads what the checks answer from Kestrel itself (its MCP servers) before the list is built. */
    refresh?(): Promise<void>;
    /** Where this computer's values are read for another computer, on its person's Allow (onboarding.md 19.5); none: it answers no copy. */
    values?: Omit<ValueSources, 'mcpServers'> & { mcpServers(keptOff: readonly string[]): DiscoveredServer[] | Promise<DiscoveredServer[]>; /** Tests make the two minutes short. */ requestTtlMs?: number };
    /** Kestrel's own MCP list, where copied values are written (setup-values/copy.ts). */
    mcp?: CopyDeps['mcp'];
  };
  /** Where the other computers' sessions are kept (account-replica.ts). None in tests of the link alone. */
  replica?: AccountReplica;
  /** Where the other computers' projects are kept (account-projects.ts); with it, this computer writes its own. */
  projects?: AccountProjects;
  /** What was seen (seen.ts); with it, this computer's marks are one record of the account's (seen-sync.ts). */
  seen?: SeenSource;
  /** What this computer offers for a new session, where the other computers' records are kept, and what tells of a change (offers-sync.ts). */
  offers?: { source: OffersSource; store: AccountOffers; watch: OffersSyncDeps['watch'] };
  /** How long a call to another computer waits for its answer (caller.ts); tests make it short. */
  callTimeoutMs?: number;
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

/** The switch and the held-conversation choices, as the settings store keeps them (read back by `prefsOf`). */
export const connectPrefsJson = (enabled: boolean, held: HeldPrefs = DEFAULT_HELD_PREFS): string => JSON.stringify({ enabled, keptOff: held.keptOff, attachments: held.attachments });

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

/** The name the user gave this computer, and whether the service still has to be told it. */
interface GivenName {
  name: string | null;
  unsent: boolean;
}

function givenOf(raw: string | null): GivenName {
  try {
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { name: typeof value.name === 'string' && value.name ? value.name : null, unsent: value.unsent === true };
  } catch {
    return { name: null, unsent: false };
  }
}

/** The text of a name that cannot be one, as a refusal. */
function nameOrRefuse(text: string): string | null {
  try {
    return deviceNameOf(text);
  } catch (error) {
    throw new Refused(message(error));
  }
}

const NO_HELD: ConnectHeld = { ...DEFAULT_HELD_PREFS, problem: null, usage: null, lastUploadAt: null };

export class KestrelConnect {
  private data: VaultData = { tokens: null, device: null };
  private enabled = false;
  private heldPrefs: HeldPrefs = DEFAULT_HELD_PREFS;
  private given: GivenName = { name: null, unsent: false };
  /** Why the service has not taken this computer's name yet, or null. */
  private nameProblem: string | null = null;
  private account: ConnectAccount = { state: 'signed-out', reason: null };
  private signInUnderWay: { callback: LoopbackCallback; request: AuthorizationRequest } | null = null;
  /** A worker node's sign-in by a device authorization grant, while it is polled. */
  private deviceSignIn: { request: DeviceAuthorization; abort: AbortController } | null = null;
  /** This computer was removed from the account by another device: nothing is dialled until it joins again. */
  private removedFromAccount = false;
  private readonly kind: KestrelKind;
  /** Why the recovery words may not be shown or typed here (a worker node), or null. */
  private readonly wordsRefusal: string | null;
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
  /** This computer calling another of the account (caller.ts), and the conversations it reads and watches there. */
  readonly caller: DeskCaller;
  readonly remote: RemoteSessions;
  readonly keys: AccountKeys;
  readonly join: AccountJoin;
  readonly held: HeldConversations | null;
  readonly push: PushNotices | null;
  readonly setup: SetupRecords | null;
  /** Set up this computer's dismissals and runs (setup-actions/); only with set-up records. */
  readonly steps: SetupSteps | null;
  /** Other computers' requests for a set-up step's values, waiting on the person here (onboarding.md section 19). */
  readonly values: ValueRequests | null;
  private copyCount = 0;
  /** Reads the account's other computers into the replica. */
  readonly replica: ReplicaSync | null;
  /** Reads the account's other computers' projects into the replica (project-sync.ts). */
  readonly projects: ProjectSync | null;
  /** Shares what was seen with the account's other computers (seen-sync.ts). */
  readonly seen: SeenSync | null;
  /** Shares what this computer offers for a new session, and reads the other computers' (offers-sync.ts). */
  readonly offers: OffersSync | null;

  constructor(private readonly deps: ConnectDeps) {
    this.kind = deps.kind ?? 'app';
    this.wordsRefusal = recoveryWordsRefusal(this.kind);
    const kind = deviceKindFor(this.kind);
    this.keys = new AccountKeys({
      api: () => this.api(),
      me: () => {
        const device = this.data.device;
        return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: this.name(), kind, identity: device } : null;
      },
      wordsRefusal: this.wordsRefusal,
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
            return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: this.name() } : null;
          },
          prefs: () => this.heldPrefs,
          changed: () => this.changed(),
          here: deps.here ?? 'this computer',
          now: deps.now,
          ...(deps.projects ? { projects: new ProjectUploader() } : {}),
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
            return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: this.name() } : null;
          },
          changed: () => this.changed(),
          now: deps.now,
        })
      : null;
    const setup = deps.setup;
    this.setup = setup
      ? new SetupRecords({
          api: () => (this.link.link.state === 'connected' ? this.api() : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          desk: () => {
            const device = this.data.device;
            // The name the user gave this computer, as every other screen calls it.
            return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: this.name() } : null;
          },
          inventory: (desk) => setup.inventory(desk, this.heldPrefs.keptOff),
          ...(setup.fileRecords ? { fileRecords: setup.fileRecords } : {}),
        })
      : null;
    this.steps = setup ? new SetupSteps({ list: () => this.setupList(), settings: deps.settings, execute: setup.execute, files: (line, from) => this.setup!.files(line, from), now: deps.now }) : null;
    const sources = setup?.values;
    this.values = sources
      ? new ValueRequests({
          ownRecord: () => (this.setup ? this.setup.write() : Promise.reject(new Error('no set-up records'))),
          device: (id) => (this.removedHere.has(id) ? null : this.keys.device(id)),
          read: (line, names, own) => readValues({ ...sources, mcpServers: () => sources.mcpServers(this.heldPrefs.keptOff) }, line, names, own),
          source: sourceText,
          settings: deps.settings,
          here: () => this.name(),
          now: deps.now,
          ...(sources.requestTtlMs ? { ttlMs: sources.requestTtlMs } : {}),
        })
      : null;
    // The account's computers, desktops and worker nodes alike (W2): whose sessions, projects, offers and seen marks are read.
    const machines = () => this.accountDevices.filter((d) => isComputerKind(d.kind) && !this.removedHere.has(d.id) && this.keys.member(d.id) !== null).map((d) => ({ id: d.id, name: d.name }));
    this.seen = deps.seen
      ? new SeenSync({
          source: deps.seen,
          api: () => (this.link.link.state === 'connected' ? this.api() : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          desk: () => ((device) => device && { id: device.id, name: this.name() })(this.myDevice()),
          machines,
          keptOff: () => this.heldPrefs.keptOff,
          headsRead: () => this.replica?.headsRead() ?? true,
          now: deps.now,
        })
      : null;
    const offers = deps.offers;
    this.offers = offers
      ? new OffersSync({
          source: offers.source,
          store: offers.store,
          // The projects kept off are this module's: a change of them is a change of the record too.
          watch: (changed) => {
            const offs = [offers.watch(changed), this.onKeptOff(() => changed(false))];
            return () => offs.forEach((off) => off());
          },
          api: () => (this.link.link.state === 'connected' ? this.api() : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          desk: () => ((device) => device && { id: device.id, name: this.name() })(this.myDevice()),
          machines,
          keptOff: () => this.heldPrefs.keptOff,
          now: deps.now,
        })
      : null;
    this.replica = deps.replica
      ? new ReplicaSync({
          replica: deps.replica,
          api: () => (this.link.link.state === 'connected' ? this.api() : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          desk: () => this.myDevice(),
          now: deps.now,
          machines,
          ...(this.seen ? { before: () => this.seen!.run() } : {}),
        })
      : null;
    this.projects = deps.projects
      ? new ProjectSync({
          store: deps.projects,
          api: () => (this.link.link.state === 'connected' ? this.api() : null),
          key: () => this.keys.ready(),
          keyFor: (generation) => this.keys.keyFor(generation),
          desk: () => this.myDevice(),
          now: deps.now,
          machines,
        })
      : null;
    this.link = new RelayLink({
      service: deps.service,
      token: (fresh) => this.accessToken(fresh, DIAL_FRESH_FOR_MS),
      deviceId: () => this.deviceId(),
      state: (link) => {
        if (link.state !== 'connected') {
          this.channel.dropAll();
          this.caller.dropAll();
        } else {
          this.channel.linkBack();
          void this.linkUp();
        }
        this.changed();
      },
      notice: (kind, notice) => {
        if (kind === 'held-messages') void this.held?.deliverWaiting();
        if (kind === 'push-devices') void this.push?.refreshPhones();
        // A device of the account was renamed (or added or removed): read the list again.
        if (kind === 'devices-changed') void this.refreshDevices();
        // A session head was written or deleted somewhere in the account: read the change feed.
        if (kind === 'changed') {
          this.seen?.kick();
          this.offers?.kick();
          this.replica?.kick();
          this.projects?.kick();
        }
        // Another device rotated the key or this one was given a copy: open it now, not at the next reconnect.
        if (kind === 'key-changed') void this.linkUp();
        if (kind === 'join') {
          const request = asJoinRequest(notice.join);
          if (request) this.join.noticed(request);
          void this.refreshDevices();
        }
        if (kind === 'join-ended' && typeof notice.id === 'string') this.join.ended(notice.id);
        // The relay could not carry a frame of this computer's (its device is not connected).
        if (kind === 'refused' && typeof notice.id === 'string') this.caller.refused(notice.id, typeof notice.reason === 'string' ? notice.reason : 'That computer cannot be reached.');
      },
      // Answers to this computer's own calls go to the caller, the rest to the channel (caller.ts).
      frame: (text) => void (routeFrame(text, this.myDevice()?.id ?? null, this.caller) && this.channel.receive(text)),
      signedOut: (reason) => void this.endSignIn(`the sign-in expired or was ended (${reason}). Sign in again.`),
      deviceGone: () => void this.dropRemoved(),
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
    ({ caller: this.caller, remote: this.remote } = remoteCalls({
      me: () => ((device) => device && { id: device.id, identity: device })(this.myDevice()),
      member: (id) => (this.removedHere.has(id) ? null : this.keys.member(id)),
      send: (text) => this.link.send(text),
      now: deps.now,
      timeoutMs: deps.callTimeoutMs,
    }));
    this.join = new AccountJoin({
      api: () => (this.link.link.state === 'connected' ? new JoinApi(this.call()) : null),
      me: () => {
        const device = this.data.device;
        return device && device.subject === this.data.tokens?.subject ? { id: device.id, name: this.name(), kind, identity: device } : null;
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
    await this.sendName();
    void this.refreshDevices();
    this.channel.endStrangers();
    this.caller.endStrangers();
    if (!this.keys.ready()) {
      // Step 8b: a copy it cannot open, with no join under way (it was closed part-way through one), is deleted, so
      // this computer comes back out of the account, not half in, and asks again.
      if (this.keys.stranded() && !this.join.busy()) await this.keys.discardCopy().catch((error: unknown) => console.error(`[kestrel] could not delete a key copy this computer cannot open: ${message(error)}`));
      if (this.keys.keysState() === 'locked') await this.join.askOnce();
      return;
    }
    await this.join.refresh().catch((error: unknown) => console.error(`[kestrel] could not read requests to join the account: ${message(error)}`));
    this.held?.kick();
    this.seen?.kick();
    this.offers?.connected();
    this.replica?.kick();
    this.projects?.kick();
    this.setup?.refreshOnce();
    void this.push?.refreshPhones();
    // What a window watches on another computer is asked for again over a new channel.
    this.caller.linkBack();
    this.remote.linkBack();
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
      await this.adoptName();
      // A computer joined or left: its sessions arrive, or go.
      if (this.keys.ready()) {
        this.seen?.kick();
        this.offers?.kick();
        this.replica?.kick();
        this.projects?.kick();
      }
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
      const desk: DeskOps = { kindOf: (id) => (this.removedHere.has(id) ? null : (this.keys.device(id)?.kind ?? null)), values: this.values };
      this.dispatcher = { deviceId, dispatch: this.deps.dispatch(deviceId, (frame) => this.channel.sendSealed(frame), desk) };
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
    this.given = givenOf(await this.deps.settings.getSetting(COMPUTER_NAME_KEY).catch(() => null));
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
      computerName: this.name(),
      hostName: this.deps.computerName,
      givenName: this.given.name,
      nameProblem: this.nameProblem,
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
    // Off and on again registers this computer afresh: removed no longer applies.
    if (enabled) this.removedFromAccount = false;
    if (!enabled) {
      this.keys.reset();
      this.join.reset();
      this.setup?.reset();
    }
    this.follow();
    this.changed();
    return this.view();
  }

  private savePrefs(enabled: boolean, held: HeldPrefs): Promise<void> {
    return this.deps.settings.putSetting(CONNECT_PREFS_KEY, connectPrefsJson(enabled, held));
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
    if (after.keptOff.join('|') !== before.keptOff.join('|')) for (const listener of this.keptOffListeners) listener();
    this.changed();
    return this.view();
  }

  private readonly keptOffListeners = new Set<() => void>();
  private onKeptOff(listener: () => void): () => void {
    this.keptOffListeners.add(listener);
    return () => void this.keptOffListeners.delete(listener);
  }

  /** The projects kept off Kestrel Connect now (what this computer offers leaves them out, live and held alike). */
  keptOff(): readonly string[] {
    return this.heldPrefs.keptOff;
  }

  /** Settings → Connections was opened: this computer's set-up record is written again if it changed. */
  setupRefresh(): void {
    this.setup?.refresh();
  }

  /**
   * What the account's other computers publish about their git (their set-up records: name, email, whether they sign),
   * newest first, for a worker node's `kestrel-node git`. Refused, with the reason, when this computer cannot read them.
   */
  async publishedGit(): Promise<PublishedGit[]> {
    if (!this.setup) throw new Refused('This copy of Kestrel does not read set-up records.');
    if (this.link.link.state !== 'connected' || !this.keys.ready()) throw new Refused('Not connected to your Kestrel Connect account, so what your other computers use could not be read.');
    const others = await this.setup.others(await this.api().devices());
    return [...others].sort((a, b) => b.readAt - a.readAt).map((r) => ({ computer: r.machine.name, name: r.git.name, email: r.git.email, signs: r.git.signs }));
  }

  /** The set-up list for this computer, from every other computer's record and this one read now (onboarding.md, section 7). */
  async setupList(): Promise<SetupList> {
    if (!this.setup || !this.deps.setup) throw new Refused('Set up this computer is not available in this copy of Kestrel.');
    // Sample data: a sample list, and nothing read from this machine.
    if (this.deps.unavailable && this.deps.setup.sample) return this.deps.setup.sample();
    // A checkout looking at the page with this computer's real record, as a new Mac would be shown it.
    if (this.deps.setup.preview) return this.deps.setup.preview(this.name());
    if (this.link.link.state !== 'connected' || !this.keys.ready()) throw new Refused('Set up this computer needs Kestrel Connect on, signed in, connected, and this computer let into your account.');
    const { here, others } = await this.setup.read(await this.api().devices());
    await this.deps.setup.refresh?.();
    return setupListOf(here, others, this.deps.setup.checks);
  }

  /**
   * Copy values from another computer, on the button of a line that names them (onboarding.md 19.4): asked
   * there over the sealed channel and written here where a typed value would go. Answers names only.
   */
  async copyValues(lineId: string, machineId: string): Promise<CopyReport> {
    const steps = this.steps;
    if (!steps || !this.setup) throw new Refused('Set up this computer is not available in this copy of Kestrel.');
    return copyValues(
      {
        list: () => steps.list(),
        ask: (machine, op, args, opts) => this.remote.ask(machine, op, args, opts),
        runLine: (id, input) => steps.runLine(id, input),
        mcp: this.deps.setup?.mcp ?? null,
        keepUndo: (undo) => steps.keepUndo(undo),
        newId: () => `v${Date.now().toString(36)}${++this.copyCount}`,
      },
      lineId,
      machineId,
    );
  }

  /** The recovery words, shown from this computer because it holds the account key. Never on a worker node. */
  recoveryWords(): { words: string[] } {
    return { words: this.keys.words() };
  }

  async recoveryPutAway(): Promise<ConnectView> {
    await this.keys.wordsPutAway();
    return this.view();
  }

  /** Lets this computer in with the recovery words. Never a worker node: it joins by the two codes only. */
  async recover(words: string): Promise<ConnectView> {
    if (this.wordsRefusal) throw new Refused(this.wordsRefusal);
    if (this.link.link.state !== 'connected') throw new Refused('Turn Kestrel Connect on, sign in, and wait until it says Connected, then enter the recovery key.');
    await this.keys.recover(words);
    void this.linkUp();
    return this.view();
  }

  /** Begins a sign-in: the browser is sent to the returned address and comes back to a loopback listener. */
  async signIn(): Promise<{ url: string }> {
    if (this.deps.unavailable) throw new Refused(this.deps.unavailable);
    if (CONNECT_SIGN_IN[this.kind].grant !== 'loopback') throw new Refused('A worker node has no browser. Sign it in from its terminal with "kestrel-node join".');
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
      await this.adopt(tokens);
    } catch (error) {
      if (this.signInUnderWay !== underWay) return;
      this.account = { state: 'signed-out', reason: message(error) };
    } finally {
      if (this.signInUnderWay === underWay) this.signInUnderWay = null;
    }
    this.follow();
    this.changed();
  }

  /** The sign-in's tokens are this computer's: kept in the protected store, with its device when the account is the same. */
  private async adopt(tokens: StoredTokens): Promise<void> {
    const device = this.data.device?.subject === tokens.subject ? this.data.device : null;
    await this.save({ ...this.data, tokens, device });
    this.account = { state: 'signed-in', email: tokens.email };
  }

  /**
   * Begins a worker node's sign-in (worker-nodes.md, section 5): a device authorization grant, whose address and
   * short code the person opens on any device. Polled in the background until it ends; the account's state says how.
   */
  async signInWithCode(): Promise<DeviceSignInPrompt> {
    if (this.deps.unavailable) throw new Refused(this.deps.unavailable);
    if (CONNECT_SIGN_IN[this.kind].grant !== 'device') throw new Refused('This computer signs in to Kestrel Connect through the browser.');
    if (this.account.state === 'signed-in') throw new Refused(`Already signed in as ${this.account.email}. Sign out first to use another account.`);
    if (this.deviceSignIn) return promptOf(this.deviceSignIn.request);
    let request: DeviceAuthorization;
    try {
      request = await this.deps.identity.deviceAuthorize();
    } catch (error) {
      throw new Refused(`Kestrel Connect could not be reached to sign in: ${message(error)}`);
    }
    const underWay = { request, abort: new AbortController() };
    this.deviceSignIn = underWay;
    this.account = { state: 'signing-in', url: request.verificationUriComplete ?? request.verificationUri };
    this.changed();
    void pollDeviceGrant({ identity: this.deps.identity, ...(this.deps.now ? { now: this.deps.now } : {}) }, request, underWay.abort.signal)
      .then(
        async (tokens) => {
          if (this.deviceSignIn === underWay) await this.adopt(tokens);
        },
        (error: unknown) => {
          if (this.deviceSignIn === underWay) this.account = { state: 'signed-out', reason: message(error) };
        },
      )
      .finally(() => {
        if (this.deviceSignIn !== underWay) return;
        this.deviceSignIn = null;
        this.follow();
        this.changed();
      });
    return promptOf(request);
  }

  cancelSignIn(): void {
    const device = this.deviceSignIn;
    const underWay = this.signInUnderWay;
    if (!underWay && !device) return;
    this.deviceSignIn = null;
    device?.abort.abort();
    this.signInUnderWay = null;
    underWay?.callback.close();
    this.account = { state: 'signed-out', reason: null };
    this.changed();
  }

  /** Removed from the account by another device (the relay says so): the device and the key are dropped, and nothing is dialled. */
  private async dropRemoved(): Promise<void> {
    this.removedFromAccount = true;
    this.keys.reset();
    this.join.reset();
    await this.save({ ...this.data, device: null });
  }

  /** Whether another device removed this computer from the account, and it has not joined again since. */
  wasRemoved(): boolean {
    return this.removedFromAccount;
  }

  /** Whether this computer is in the account now: let in, by the keyring it holds or last accepted, and not removed since. */
  inAccount(): boolean {
    const device = this.myDevice();
    return !this.removedFromAccount && device !== null && (this.keys.ready() !== null || this.keys.member(device.id) !== null);
  }

  /** Starts afresh after a removal: the link dials again and this computer is registered as a new device, to ask to join. */
  rejoin(): void {
    this.removedFromAccount = false;
    this.link.stop();
    this.follow();
    this.changed();
  }

  async signOut(): Promise<ConnectView> {
    this.cancelSignIn();
    const tokens = this.data.tokens;
    this.link.stop();
    this.keys.reset();
    this.join.reset();
    this.setup?.reset();
    await this.seen?.forget();
    await this.offers?.forget();
    await this.replica?.forget();
    await this.projects?.forget();
    // The device keys stay: signing in again to the same account keeps this computer's identity.
    await this.save({ ...this.data, tokens: null });
    this.account = { state: 'signed-out', reason: null };
    this.removedFromAccount = false;
    this.changed();
    if (tokens) void this.deps.identity.revoke(tokens).catch(() => undefined);
    return this.view();
  }

  /**
   * This computer leaves the account for good (`kestrel-node uninstall`): the service removes it as Remove does from
   * another device, which leaves the key's rotation due for the next device that may rotate it; then it signs out
   * and forgets its device keys. Nothing is dropped when the service refuses: the caller deletes nothing then.
   */
  async leaveAccount(): Promise<'left' | 'not-signed-in'> {
    const device = this.data.device;
    if (!this.data.tokens) return 'not-signed-in';
    if (device) {
      try {
        await this.signedIn((token) => this.deps.service.removeDevice(token, device.id));
      } catch (error) {
        throw new Refused(`Kestrel Connect could not remove this computer from your account: ${message(error)} Try again when it is connected, or remove it from another device.`);
      }
    }
    await this.signOut();
    await this.save({ ...this.data, device: null });
    return 'left';
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
        // Another account than the one this computer was in: nothing of the old one stays.
        if (device) {
          await this.seen?.forget();
          await this.offers?.forget();
          await this.replica?.forget();
          await this.projects?.forget();
        }
        const identity = { signing: keys.signing, agreement: keys.agreement };
        const registered = await this.signedIn((token) => this.deps.service.registerDevice(token, this.name(), deviceKindFor(this.kind), publicIdentity(identity)));
        const stored: StoredDevice = { subject: tokens.subject, id: registered.id, name: registered.name, signing: keys.signing, agreement: keys.agreement };
        await this.save({ ...this.data, device: stored, keysPut: stored.id });
        // The service has the name now: it was given at registration.
        if (this.given.unsent && registered.name === this.name()) await this.saveGiven({ ...this.given, unsent: false });
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

  /** This computer's name: the one the user gave, or the host name. A label only, never identity. */
  name(): string {
    return this.given.name ?? this.deps.computerName;
  }

  private async saveGiven(given: GivenName): Promise<void> {
    this.given = given;
    await this.deps.settings.putSetting(COMPUTER_NAME_KEY, JSON.stringify(given));
  }

  /**
   * The account's other computers a session may be started on from here (issue 52): every desktop and worker node of
   * the keyring this computer accepted but itself, by name. Empty while not connected or with no account.
   */
  otherComputers(): { id: string; name: string }[] {
    const me = this.myDevice()?.id;
    return this.accountDevices.filter((d) => isComputerKind(d.kind) && d.id !== me && !this.removedHere.has(d.id) && this.keys.member(d.id) !== null).map((d) => ({ id: d.id, name: d.name }));
  }

  /** This computer's registered device on the signed-in account, or null. */
  private myDevice(): StoredDevice | null {
    const device = this.data.device;
    return device && device.subject === this.data.tokens?.subject ? device : null;
  }

  /**
   * Names this computer (empty: its host name). Kept here at once, Connect on or off; told to the service now
   * when the link is up, else when it is next up. A name the service did not take is kept, with why.
   */
  async setComputerName(text: string): Promise<ConnectView> {
    const name = nameOrRefuse(text);
    await this.saveGiven({ name, unsent: true });
    this.nameProblem = null;
    await this.sendName();
    this.changed();
    return this.view();
  }

  /** Tells the service this computer's name when it has not been told it yet. */
  private async sendName(): Promise<void> {
    const device = this.myDevice();
    if (!this.given.unsent || !device || this.link.link.state !== 'connected') return;
    const name = this.name();
    try {
      await new JoinApi(this.call()).rename(device.id, name);
      // Typed again while it went: the newer one is sent next time.
      if (this.name() === name) await this.saveGiven({ ...this.given, unsent: false });
      this.nameProblem = null;
      void this.refreshDevices();
    } catch (error) {
      this.nameProblem = `Kestrel Connect could not take the new name yet: ${message(error)} It is used here, and sent again when Connect reconnects.`;
    }
  }

  /** Renamed from another device: the service's name for this computer is taken as its own, unless one typed here waits. */
  private async adoptName(): Promise<void> {
    const device = this.myDevice();
    const listed = device ? this.accountDevices.find((d) => d.id === device.id) : undefined;
    if (!listed || this.given.unsent || listed.name === this.name()) return;
    await this.saveGiven({ name: listed.name === this.deps.computerName ? null : listed.name, unsent: false });
  }

  /** Renames a device of the account (this computer's own row is its name field). A label only: nothing about trust changes. */
  async renameDevice(deviceId: string, text: string): Promise<ConnectView> {
    if (deviceId === this.myDevice()?.id) return this.setComputerName(text);
    if (this.link.link.state !== 'connected') throw new Refused('Connect this computer to rename the devices of your account.');
    if (!this.accountDevices.some((d) => d.id === deviceId)) throw new Refused('That device is not on your account.');
    const name = nameOrRefuse(text);
    if (!name) throw new Refused('A device needs a name.');
    try {
      await new JoinApi(this.call()).rename(deviceId, name);
    } catch (error) {
      throw new Refused(`Kestrel Connect could not rename it: ${message(error)}`);
    }
    this.accountDevices = this.accountDevices.map((d) => (d.id === deviceId ? { ...d, name } : d));
    this.changed();
    void this.refreshDevices();
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
    this.values?.dropDevice(deviceId);
    this.channel.remove(deviceId);
    this.caller.remove(deviceId);
    await this.writes;
    if (this.data.tokens) {
      try {
        await this.signedIn((token) => this.deps.service.removeDevice(token, deviceId));
      } catch (error) {
        throw new Refused(`The device can no longer reach this computer, but Kestrel Connect could not remove it from your account: ${message(error)} Remove it again when Connect is back.`);
      }
      this.accountDevices = this.accountDevices.filter((d) => d.id !== deviceId);
      this.seen?.kick();
      this.offers?.kick();
      this.replica?.kick();
      this.projects?.kick();
      if (this.link.link.state === 'connected') void this.keys.sync().then(() => this.keys.reseal()).catch((error: unknown) => console.error(`[kestrel] could not rotate the account key: ${message(error)}`));
    }
    return this.view();
  }

  async close(): Promise<void> {
    this.cancelSignIn();
    this.link.stop();
    this.caller.close();
    this.dispatcher?.dispatch.close();
    this.dispatcher = null;
    await this.held?.close();
    await this.seen?.close();
    await this.offers?.close();
    await this.replica?.close();
    await this.projects?.close();
    this.push?.close();
    this.listeners.clear();
    await this.writes;
  }
}
