// The account data key on this device (design doc kestrel-connect.md, section 5, "Phase 3 as built, part
// C" and "Account stage 1 as built"): made here when the account has none, opened from this device's
// sealed copy, given to a device this one lets into the account, taken from the device that let this one
// in, rotated when a device is removed, recovered from the 24 words, and the
// records sealed under an older generation re-sealed in the background. The key itself is held in
// memory only; the protected store keeps which devices' keyrings this computer trusts (public keys).
import { createPrivateKey, randomBytes } from 'node:crypto';
import { keyringSigned, newAccountKey, openRecord, openSealed, recoveryKey, recoverySecretFromWords, recoveryWords, sealRecord, sealWith, signKeyring, unwrapKey, wrapKey } from '../account-key.ts';
import { publicIdentity, type Identity, type PublicIdentity } from '../keys.ts';
import { Refused } from '../../refused.ts';
import type { ConnectKeys } from '../../shared/connect.ts';
import type { HeldApi, KeysAnswer } from './held-api.ts';
import { ServiceRefusal } from './service.ts';

export interface KeyringDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'phone';
  signing: string;
  agreement: string;
  addedBy: string;
  addedAt: number;
}

/** The keyring, as sealed under the ADK (the contract's "keyring"). */
export interface Keyring {
  v: 1;
  generation: number;
  idKey: string;
  recovery: { agreement: string; secret: string };
  devices: KeyringDevice[];
}

/** What the protected store keeps: the devices of the last keyring this computer accepted, and whether new words wait to be put away. */
export interface KeysTrust {
  generation: number;
  devices: { id: string; signing: string }[];
  wordsPending: boolean;
  /** The devices whose removal changed the key, for Settings. */
  changedBecause: string[] | null;
}

export interface KeysDeps {
  api(): HeldApi;
  me(): { id: string; name: string; kind?: 'desktop' | 'phone'; identity: Identity } | null;
  trust(): KeysTrust | null;
  saveTrust(next: KeysTrust): Promise<void>;
  changed(): void;
  now?(): number;
}

/** The key, ready to seal with. */
export interface ReadyKey {
  generation: number;
  adk: Buffer;
  idKey: Buffer;
}

export const WAITING = 'Let this computer into your account: open Kestrel on your phone or another computer and type the code shown here, or enter your recovery key.';
const UNTRUSTED = 'The account key offered to this computer was not given by a device it knows, so it was not used. Let this computer in from another of your devices, or enter your recovery key.';

/** The device that let this one in (account-sessions.md 4.4, step 8): trusted once, for the keyring version it granted. */
export interface JoinAnchor {
  id: string;
  signing: string;
  generation: number;
  keyringVersion: number;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function asKeyring(raw: unknown, generation: number): Keyring {
  const k = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Keyring>;
  if (k.v !== 1 || k.generation !== generation || !isText(k.idKey) || !isText(k.recovery?.agreement) || !isText(k.recovery?.secret) || !Array.isArray(k.devices)) throw new Error('not a keyring');
  const devices = k.devices.filter((d): d is KeyringDevice => isText(d?.id) && isText(d?.signing) && isText(d?.agreement));
  return { v: 1, generation, idKey: k.idKey, recovery: { agreement: k.recovery.agreement, secret: k.recovery.secret }, devices };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class AccountKeys {
  private state: ConnectKeys = { state: 'unknown' };
  private current: (ReadyKey & { keyring: Keyring; keyringVersion: number; previous: KeysAnswer['previous'] }) | null = null;
  private readonly older = new Map<number, Buffer>();
  private syncing: Promise<void> | null = null;

  constructor(private readonly deps: KeysDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  view(): ConnectKeys {
    if (this.state.state !== 'ready') return this.state;
    const trust = this.deps.trust();
    return { ...this.state, wordsToShow: trust?.wordsPending ?? false, changedBecause: trust?.changedBecause ?? null };
  }

  ready(): ReadyKey | null {
    return this.current && { generation: this.current.generation, adk: this.current.adk, idKey: this.current.idKey };
  }

  /** The signing key of a device in the keyring this device last accepted, or null: who may open a channel here. */
  member(deviceId: string): string | null {
    // Before the key is opened again after a restart, the keyring last accepted (kept in the protected store) answers.
    const devices = this.current?.keyring.devices ?? this.deps.trust()?.devices ?? [];
    return devices.find((d) => d.id === deviceId)?.signing ?? null;
  }

  /** The ids of the devices in the current keyring. */
  memberIds(): string[] {
    return this.current?.keyring.devices.map((d) => d.id) ?? [];
  }

  /** The state the key is in: locked means the account has a key this device does not hold. */
  keysState(): ConnectKeys['state'] {
    return this.state.state;
  }

  /** Whether a device, with these keys, is in the account's keyring, so has been given its own copy of the key. */
  holds(deviceId: string, keys: PublicIdentity): boolean {
    return this.current?.keyring.devices.some((d) => d.id === deviceId && d.signing === keys.signing && d.agreement === keys.agreement) ?? false;
  }

  private granting: Promise<unknown> = Promise.resolve();
  /** The service holds a copy of the current key for this device that it cannot open: no device it trusts signed the keyring. */
  private strandedCopy = false;

  /** Whether this device has a copy it cannot open (step 8b: deleted when no join is under way). */
  stranded(): boolean {
    return this.strandedCopy && !this.current;
  }

  /** This device discards the copy it was offered or cannot open: deleted at the service, so a key holder withdraws it from the keyring. */
  async discardCopy(): Promise<void> {
    await this.deps.api().deleteCopy();
    this.strandedCopy = false;
    if (!this.current) this.set({ state: 'locked', reason: WAITING });
  }

  /** Forgets the key (signed out, or the link is off). */
  reset(): void {
    this.current = null;
    this.older.clear();
    this.set({ state: 'unknown' });
  }

  private set(next: ConnectKeys): void {
    this.state = next;
    this.deps.changed();
  }

  private me() {
    const me = this.deps.me();
    if (!me) throw new Error('This computer is not registered with Kestrel Connect yet.');
    return me;
  }

  /** Reads the account's key from the service and opens it, makes it, or rotates it. One at a time. */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync(attempt = 0): Promise<void> {
    try {
      const answer = await this.deps.api().keys();
      if (answer.generation === null) return await this.create(attempt);
      await this.open(answer);
      if (!this.current) return;
      if (answer.rotationDue) return await this.rotate(answer.rotationDue.removed.map((d) => d.name), attempt);
      await this.withdrawCopyless(answer.holders);
    } catch (error) {
      if (error instanceof ServiceRefusal && (error.code === 'key-exists' || error.code === 'key-changed') && attempt < 2) return this.doSync(attempt + 1);
      if (error instanceof ServiceRefusal) return this.set({ state: 'failed', reason: error.message });
      // Not reached: the link says so; the key is tried again when it is back.
      if (!this.current) this.set({ state: 'unknown' });
      console.error(`[kestrel] Kestrel Connect could not read the account key: ${message(error)}`);
    }
  }

  /** The signing keys this device trusts a keyring from: its own, and the devices of the last keyring it accepted. Nothing else. */
  private trusted(): Map<string, string> {
    const me = this.me();
    const out = new Map<string, string>();
    for (const d of this.deps.trust()?.devices ?? []) out.set(d.id, d.signing);
    out.set(me.id, publicIdentity(me.identity).signing);
    return out;
  }

  private keyringText(keyring: Keyring, adk: Buffer, version: number): string {
    const sealed = sealRecord(adk, 'keyring', 'keyring', keyring.generation, keyring);
    const me = this.me();
    return JSON.stringify({ sealed, signer: me.id, signature: signKeyring(me.identity, keyring.generation, version, sealed) });
  }

  /** Opens a keyring the service holds; throws when it is not signed by a device this computer trusts. */
  private openKeyring(text: string, adk: Buffer, generation: number, version: number, trustBy: 'signer' | { secret: string } | { anchor: JoinAnchor }): Keyring {
    const stored = JSON.parse(text) as { sealed?: unknown; signer?: unknown; signature?: unknown };
    if (!isText(stored.sealed) || !isText(stored.signer)) throw new Error('not a keyring');
    const keyring = asKeyring(openRecord(adk, stored.sealed, 'keyring', 'keyring', generation), generation);
    if (trustBy === 'signer') {
      const signing = this.trusted().get(stored.signer);
      if (!signing || !keyringSigned(signing, stored.signature, generation, version, stored.sealed)) throw new Refused(UNTRUSTED);
    } else if ('anchor' in trustBy) {
      if (stored.signer !== trustBy.anchor.id || !keyringSigned(trustBy.anchor.signing, stored.signature, generation, version, stored.sealed)) throw new Refused(UNTRUSTED);
    } else if (keyring.recovery.secret !== trustBy.secret || keyring.recovery.agreement !== recoveryKey(Buffer.from(trustBy.secret, 'base64url')).publicRaw.toString('base64url')) {
      // Opened with the words, and its recovery key is the one the words make (account-sessions.md 4.4).
      throw new Refused(UNTRUSTED);
    }
    return keyring;
  }

  private selfEntry(): KeyringDevice {
    const me = this.me();
    const keys = publicIdentity(me.identity);
    return { id: me.id, name: me.name, kind: me.kind ?? 'desktop', signing: keys.signing, agreement: keys.agreement, addedBy: me.id, addedAt: this.now() };
  }

  private async accept(adk: Buffer, keyring: Keyring, version: number, previous: KeysAnswer['previous'], words: Partial<Pick<KeysTrust, 'wordsPending' | 'changedBecause'>> = {}): Promise<void> {
    const before = this.deps.trust();
    this.current = { generation: keyring.generation, adk, idKey: Buffer.from(keyring.idKey, 'base64url'), keyring, keyringVersion: version, previous };
    await this.deps.saveTrust({
      generation: keyring.generation,
      devices: keyring.devices.map((d) => ({ id: d.id, signing: d.signing })),
      wordsPending: words.wordsPending ?? before?.wordsPending ?? false,
      changedBecause: words.changedBecause !== undefined ? words.changedBecause : (before?.changedBecause ?? null),
    });
    this.set({ state: 'ready', generation: keyring.generation, wordsToShow: false, changedBecause: null });
  }

  /** The first device: makes the key, the keyring and the recovery key. */
  private async create(attempt: number): Promise<void> {
    const me = this.me();
    const adk = newAccountKey();
    const secret = randomBytes(32);
    const recovery = recoveryKey(secret);
    const keyring: Keyring = { v: 1, generation: 1, idKey: randomBytes(32).toString('base64url'), recovery: { agreement: recovery.publicRaw.toString('base64url'), secret: secret.toString('base64url') }, devices: [this.selfEntry()] };
    await this.deps.api().createKeys({
      keyring: this.keyringText(keyring, adk, 1),
      recovery: wrapKey(adk, keyring.recovery.agreement, 1, 'recovery'),
      wrapped: wrapKey(adk, publicIdentity(me.identity).agreement, 1, me.id),
    });
    void attempt;
    await this.accept(adk, keyring, 1, [], { wordsPending: true, changedBecause: null });
  }

  private async open(answer: KeysAnswer): Promise<void> {
    const generation = answer.generation as number;
    if (this.current?.generation === generation && this.current.keyringVersion === answer.keyring?.version) {
      this.current.previous = answer.previous;
      return;
    }
    if (!answer.keyring) return this.set({ state: 'failed', reason: 'The service has a key for your account but no keyring. Enter your recovery key.' });
    this.strandedCopy = false;
    if (!answer.copy || answer.copy.generation !== generation) {
      this.current = null;
      return this.set({ state: 'locked', reason: WAITING });
    }
    const me = this.me();
    let adk: Buffer;
    let keyring: Keyring;
    try {
      adk = unwrapKey(answer.copy.wrapped, createPrivateKey(me.identity.agreement.privateKey), generation, me.id);
      keyring = this.openKeyring(answer.keyring.text, adk, generation, answer.keyring.version, 'signer');
    } catch (error) {
      this.current = null;
      this.strandedCopy = true;
      return this.set({ state: 'locked', reason: error instanceof Refused ? error.message : UNTRUSTED });
    }
    if (this.current && this.current.generation < generation) this.older.set(this.current.generation, this.current.adk);
    await this.accept(adk, keyring, answer.keyring.version, answer.previous);
  }

  /**
   * Gives the key to a device whose keys this device checked (one it is letting in, after the code), and
   * says under which generation and keyring version. `again`: even when the keyring has it (a device
   * recovering its own lost copy).
   */
  grant(device: { id: string; name: string; kind: 'desktop' | 'phone'; keys: PublicIdentity }, again = false): Promise<{ generation: number; keyringVersion: number }> {
    // One at a time: two grants at once would both name the same keyring version.
    const next = this.granting.then(() => this.grantOnce(device, 0, again));
    this.granting = next.catch(() => undefined);
    return next;
  }

  private async grantOnce(device: { id: string; name: string; kind: 'desktop' | 'phone'; keys: PublicIdentity }, attempt: number, again: boolean): Promise<{ generation: number; keyringVersion: number }> {
    const current = this.current;
    if (!current) throw new Refused('This device does not hold your account key, so it cannot let another in.');
    if (!again && this.holds(device.id, device.keys)) return { generation: current.generation, keyringVersion: current.keyringVersion };
    const me = this.me();
    const entry: KeyringDevice = { id: device.id, name: device.name, kind: device.kind, signing: device.keys.signing, agreement: device.keys.agreement, addedBy: me.id, addedAt: this.now() };
    const keyring: Keyring = { ...current.keyring, devices: [...current.keyring.devices.filter((d) => d.id !== device.id), entry] };
    const version = current.keyringVersion + 1;
    try {
      await this.deps.api().grant({ generation: current.generation, keyringVersion: current.keyringVersion, keyring: this.keyringText(keyring, current.adk, version), deviceId: device.id, wrapped: wrapKey(current.adk, device.keys.agreement, current.generation, device.id) });
    } catch (error) {
      if (error instanceof ServiceRefusal && error.code === 'key-changed' && attempt < 2) {
        await this.sync();
        return this.grantOnce(device, attempt + 1, again);
      }
      throw error;
    }
    await this.accept(current.adk, keyring, version, current.previous);
    return { generation: current.generation, keyringVersion: version };
  }

  /**
   * Takes the key this device was just given by the device that let it in (account-sessions.md 4.4, step 8):
   * only the copy under the welcome's generation, only a keyring of exactly that version signed by that
   * device, and only one that lists this device with its own keys. Anything else is refused.
   */
  async acceptFrom(anchor: JoinAnchor): Promise<void> {
    const me = this.me();
    const answer = await this.deps.api().keys();
    if (answer.generation !== anchor.generation || answer.keyring?.version !== anchor.keyringVersion || answer.copy?.generation !== anchor.generation) {
      throw new Refused('The account key changed while this device was being let in. Ask again.');
    }
    let adk: Buffer;
    let keyring: Keyring;
    try {
      adk = unwrapKey(answer.copy.wrapped, createPrivateKey(me.identity.agreement.privateKey), anchor.generation, me.id);
      keyring = this.openKeyring(answer.keyring.text, adk, anchor.generation, anchor.keyringVersion, { anchor });
    } catch {
      throw new Refused(UNTRUSTED);
    }
    const mine = publicIdentity(me.identity);
    if (!keyring.devices.some((d) => d.id === me.id && d.signing === mine.signing && d.agreement === mine.agreement)) throw new Refused(UNTRUSTED);
    await this.accept(adk, keyring, anchor.keyringVersion, answer.previous);
  }

  /** A device that held the key was removed: a new key for the devices that remain, and new words. */
  /**
   * Step 8b: every other device in the keyring that holds no copy of the current key (it discarded one it was
   * offered) is withdrawn, one new keyring version each, signed by this device. Never a rotation: no one but that
   * device could open its copy, and it deleted it. The service refuses a device that still holds a copy.
   */
  private async withdrawCopyless(holders: string[]): Promise<void> {
    const me = this.me();
    const holding = new Set(holders);
    for (const device of this.current?.keyring.devices ?? []) {
      const current = this.current;
      if (!current || device.id === me.id || holding.has(device.id)) continue;
      const keyring: Keyring = { ...current.keyring, devices: current.keyring.devices.filter((d) => d.id !== device.id) };
      const version = current.keyringVersion + 1;
      await this.deps.api().withdraw({ generation: current.generation, keyringVersion: current.keyringVersion, keyring: this.keyringText(keyring, current.adk, version), deviceId: device.id });
      await this.accept(current.adk, keyring, version, current.previous);
    }
  }

  private async rotate(removed: string[], attempt: number): Promise<void> {
    const current = this.current;
    if (!current) return;
    const me = this.me();
    const onAccount = new Set((await this.deps.api().devices()).map((d) => d.id));
    const remaining = current.keyring.devices.filter((d) => onAccount.has(d.id) && d.id !== me.id);
    const devices = [...remaining, current.keyring.devices.find((d) => d.id === me.id) ?? this.selfEntry()];
    const generation = current.generation + 1;
    const adk = newAccountKey();
    const secret = randomBytes(32);
    const recovery = recoveryKey(secret);
    const keyring: Keyring = { v: 1, generation, idKey: current.keyring.idKey, recovery: { agreement: recovery.publicRaw.toString('base64url'), secret: secret.toString('base64url') }, devices };
    const previous = sealWith(adk, 'previous', String(current.generation), generation, current.adk);
    await this.deps.api().rotate({
      from: current.generation,
      keyring: this.keyringText(keyring, adk, 1),
      recovery: wrapKey(adk, keyring.recovery.agreement, generation, 'recovery'),
      previous,
      copies: devices.map((d) => ({ deviceId: d.id, wrapped: wrapKey(adk, d.agreement, generation, d.id) })),
    });
    void attempt;
    this.older.set(current.generation, current.adk);
    await this.accept(adk, keyring, 1, [...current.previous, { generation, sealed: previous }], { wordsPending: true, changedBecause: removed });
  }

  /** The key a record sealed under `generation` opens with: the current one, or one before it through the previous keys. */
  keyFor(generation: number): Buffer {
    const current = this.current;
    if (!current) throw new Error('The account key is not open.');
    if (generation === current.generation) return current.adk;
    const known = this.older.get(generation);
    if (known) return known;
    let key = current.adk;
    for (let g = current.generation; g > generation; g--) {
      const older = this.older.get(g - 1);
      if (older) {
        key = older;
        continue;
      }
      const link = current.previous.find((p) => p.generation === g);
      if (!link) throw new Error(`No key for generation ${generation}.`);
      key = openSealed(key, link.sealed, 'previous', String(g - 1), g);
      this.older.set(g - 1, key);
    }
    return key;
  }

  /** Re-seals every record under an older generation with the current key, then asks the service to drop the old keys. */
  async reseal(): Promise<number> {
    const current = this.current;
    if (!current || current.previous.length === 0) return 0;
    const api = this.deps.api();
    let done = 0;
    for (;;) {
      const batch = await api.recordsBelow(current.generation, 50);
      if (batch.length === 0) break;
      for (const record of batch) {
        if (this.current !== current) return done;
        try {
          const plain = openSealed(this.keyFor(record.generation), record.body ?? '', 'record', record.id, record.generation);
          await api.putRecord(record.id, { generation: current.generation, session: record.session, project: record.project, body: sealWith(current.adk, 'record', record.id, current.generation, plain) });
        } catch (error) {
          if (error instanceof ServiceRefusal) throw error;
          // A record nothing can open is no use to anyone: deleted.
          await api.deleteRecord(record.id).catch(() => undefined);
        }
        done += 1;
      }
    }
    try {
      await api.dropPrevious();
      current.previous = [];
      this.older.clear();
    } catch (error) {
      // A waiting message is still under an older key: tried again after the next sync.
      if (!(error instanceof ServiceRefusal && error.code === 'stale-records')) throw error;
    }
    return done;
  }

  /** The recovery words, from a device that holds the key. */
  words(): string[] {
    if (!this.current) throw new Refused('The recovery key can be shown only once this computer holds your account key.');
    return recoveryWords(Buffer.from(this.current.keyring.recovery.secret, 'base64url'));
  }

  async wordsPutAway(): Promise<void> {
    const trust = this.deps.trust();
    if (trust) await this.deps.saveTrust({ ...trust, wordsPending: false, changedBecause: null });
    this.deps.changed();
  }

  /** Lets this computer in with the 24 words, and gives it a copy of its own. */
  async recover(text: string): Promise<void> {
    const secret = recoverySecretFromWords(text);
    if (!secret) throw new Refused('Those are not 24 recovery words: check each word and their order.');
    const answer = await this.deps.api().keys();
    if (answer.generation === null || !answer.keyring || !answer.recovery || answer.recovery.generation !== answer.generation) throw new Refused('Your account has no account key to recover yet.');
    let adk: Buffer;
    let keyring: Keyring;
    try {
      adk = unwrapKey(answer.recovery.wrapped, recoveryKey(secret).privateKey, answer.generation, 'recovery');
      keyring = this.openKeyring(answer.keyring.text, adk, answer.generation, answer.keyring.version, { secret: secret.toString('base64url') });
    } catch {
      throw new Refused('These words are not your account\'s recovery key. If a device was removed since you wrote them down, the key changed then: use the newer words.');
    }
    const me = this.me();
    this.current = { generation: answer.generation, adk, idKey: Buffer.from(keyring.idKey, 'base64url'), keyring, keyringVersion: answer.keyring.version, previous: answer.previous };
    const self = publicIdentity(me.identity);
    await this.grant({ id: me.id, name: me.name, kind: me.kind ?? 'desktop', keys: self }, true);
  }
}
