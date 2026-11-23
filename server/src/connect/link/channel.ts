// The desk's end of Kestrel Connect between devices: pairing a phone with the code the pairing page
// shows, the per-connection handshake with a paired phone, and every frame after it sealed both
// ways (../keys.ts). A decrypted request goes to the dispatcher's `receive`; what the dispatcher
// sends is sealed for its device here. A device that is not paired, or was removed, gets a refusal
// in plain words and nothing else; a frame that does not open ends that device's channel.
import { CONNECT_PROTOCOL_VERSION, checkEnvelope, versionRefusal, type Envelope } from '../../shared/connect-ops.ts';
import type { PairingOffer } from '../../shared/connect.ts';
import { FrameCipher, helloSigned, newEphemeral, newPairingSecret, pairingCode, pairingProof, proofMatches, publicIdentity, sessionKeys, signHello, type Identity, type PublicIdentity } from '../keys.ts';

/** A phone paired with this computer, as kept in the protected store. */
export interface PairedDevice {
  id: string;
  name: string;
  keys: PublicIdentity;
  pairedAt: number;
}


export const PAIRING_WAIT_MS = 10 * 60_000;
/** How far a phone's signed hello time may be from this computer's clock. */
export const HELLO_WINDOW_MS = 5 * 60_000;
const NAME_MAX = 60;

/** What the channel needs of the module around it. */
export interface ChannelDeps {
  /** This computer's id and identity, once it is registered. */
  me(): { id: string; identity: Identity } | null;
  paired(): readonly PairedDevice[];
  savePaired(next: readonly PairedDevice[]): Promise<void>;
  /** Sends a frame's text over the relay link; false when not connected. */
  send(text: string): boolean;
  /** A decrypted frame for the dispatcher. */
  deliver(frame: Envelope): void;
  /** The device went away (bye, removed, its channel ended): it watches nothing any more. */
  forget(deviceId: string): void;
  /** Something the Settings part shows changed (an offer, a pairing, who is connected). */
  changed(): void;
  /** "your Mac", in refusals. */
  here: string;
  now?(): number;
}

interface Channel {
  toPhone: FrameCipher;
  fromPhone: FrameCipher;
}

const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isKeys = (value: unknown): value is PublicIdentity => typeof value === 'object' && value !== null && isText((value as PublicIdentity).signing, 64) && isText((value as PublicIdentity).agreement, 64);

export class DeskChannel {
  private offer: { secret: Buffer; code: string; expiresAt: number } | null = null;
  private readonly channels = new Map<string, Channel>();
  /** The newest hello time accepted from each phone: an older or equal one is a replay. */
  private readonly lastHello = new Map<string, number>();
  private counter = 0;

  constructor(private readonly deps: ChannelDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Opens the pairing page's code: one at a time, single use, ten minutes. */
  startPairing(): PairingOffer {
    const me = this.deps.me();
    if (!me) throw new Error('This computer is not registered with Kestrel Connect yet.');
    const secret = newPairingSecret();
    this.offer = { secret, code: pairingCode(me.id, secret), expiresAt: this.now() + PAIRING_WAIT_MS };
    this.deps.changed();
    return { code: this.offer.code, expiresAt: this.offer.expiresAt };
  }

  stopPairing(): void {
    if (!this.offer) return;
    this.offer = null;
    this.deps.changed();
  }

  pairing(): PairingOffer | null {
    if (this.offer && this.offer.expiresAt <= this.now()) this.offer = null;
    return this.offer && { code: this.offer.code, expiresAt: this.offer.expiresAt };
  }

  connected(deviceId: string): boolean {
    return this.channels.has(deviceId);
  }

  /** Ends a paired device's access at once: its channel is dropped and its keys forgotten. */
  async remove(deviceId: string): Promise<boolean> {
    const before = this.deps.paired();
    if (!before.some((d) => d.id === deviceId)) return false;
    this.endChannel(deviceId, 'This device was removed from Kestrel Connect on that computer.');
    await this.deps.savePaired(before.filter((d) => d.id !== deviceId));
    this.deps.changed();
    return true;
  }

  /** The link dropped: every channel ends; phones say hello again when it is back. */
  dropAll(): void {
    for (const id of [...this.channels.keys()]) {
      this.channels.delete(id);
      this.deps.forget(id);
    }
    this.deps.changed();
  }

  /** Seals a frame the dispatcher sends for its device; dropped when that device has no channel. */
  sendSealed(frame: Envelope): boolean {
    const channel = this.channels.get(frame.to);
    if (!channel) return false;
    const { body, ...head } = frame;
    return this.deps.send(JSON.stringify({ ...head, body: channel.toPhone.seal(head, body) }));
  }

  /** One frame's text from the relay. */
  async receive(text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const checked = checkEnvelope(raw);
    const me = this.deps.me();
    if (!checked.ok || !me || checked.value.to !== me.id) return;
    const frame = checked.value;
    // Another version cannot be read here: say what to update, in the clear, and nothing else.
    if (frame.v !== CONNECT_PROTOCOL_VERSION) return this.refuse(frame, me.id, versionRefusal(frame.v, this.deps.here) ?? 'Update Kestrel.');
    if (frame.kind === 'hello') return this.hello(frame, me);
    const paired = this.deps.paired().find((d) => d.id === frame.from);
    const channel = this.channels.get(frame.from);
    if (!paired || !channel) return this.refuse(frame, me.id, paired ? 'Say hello again first: the connection to this computer was renewed.' : `This device is not paired with ${this.deps.here}. Pair it from Settings there.`);
    let body: unknown;
    try {
      body = channel.fromPhone.open(frame);
    } catch {
      // Changed on the way, replayed, or not sealed by the phone: dropped, and nothing in it is
      // trusted. The channel stays: anyone on the path could send such a frame, and ending the
      // channel for it would let them cut the real phone off. The counter did not move.
      return this.refuse(frame, me.id, 'A frame could not be read and was ignored. Try again.');
    }
    this.deps.deliver({ ...frame, body });
  }

  private newId(): string {
    return `h${++this.counter}`;
  }

  private plain(to: string, kind: 'hello' | 'bye' | 'response', body: unknown, replyTo?: string): void {
    const me = this.deps.me();
    if (!me) return;
    this.deps.send(JSON.stringify({ v: CONNECT_PROTOCOL_VERSION, from: me.id, to, kind, id: this.newId(), ...(replyTo ? { replyTo } : {}), body }));
  }

  /** A refusal in the clear, where there is no channel to seal it in. Says nothing about this computer. */
  private refuse(frame: Envelope, myId: string, reason: string): void {
    if (frame.kind === 'request') this.plain(frame.from, 'response', { ok: false, reason }, frame.id);
    else if (frame.kind !== 'bye' && frame.kind !== 'response') this.plain(frame.from, 'bye', { reason });
    void myId;
  }

  private endChannel(deviceId: string, reason: string): void {
    const had = this.channels.delete(deviceId);
    this.deps.forget(deviceId);
    this.plain(deviceId, 'bye', { reason });
    if (had) this.deps.changed();
  }

  private async hello(frame: Envelope, me: { id: string; identity: Identity }): Promise<void> {
    const body = (typeof frame.body === 'object' && frame.body !== null ? frame.body : {}) as Record<string, unknown>;
    if (body.pair !== undefined) return this.pair(frame.from, body.pair, me);
    if (body.session !== undefined) return this.session(frame.from, body.session, me);
    this.plain(frame.from, 'hello', { refused: 'A hello must pair or open a session.' });
  }

  private async pair(phoneId: string, raw: unknown, me: { id: string; identity: Identity }): Promise<void> {
    const ask = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const offer = this.offer && this.offer.expiresAt > this.now() ? this.offer : null;
    if (!offer) return this.plain(phoneId, 'hello', { refused: `${this.deps.here} is not pairing right now. Open Pair a phone in Settings there and use the code it shows.` });
    if (!isKeys(ask.keys) || !isText(ask.name, NAME_MAX) || !proofMatches(pairingProof(offer.secret, 'phone', me.id, phoneId, ask.keys, ask.name), ask.proof)) {
      return this.plain(phoneId, 'hello', { refused: 'That pairing code is not the one this computer is showing. Check it and try again.' });
    }
    const keys = ask.keys;
    const mine = publicIdentity(me.identity);
    // Single use, taken before anything waits, so a second hello with the same code finds none.
    this.offer = null;
    const device: PairedDevice = { id: phoneId, name: ask.name, keys, pairedAt: this.now() };
    await this.deps.savePaired([...this.deps.paired().filter((d) => d.id !== phoneId), device]);
    // Paired again: an old channel (old keys) ends quietly; the phone opens a new one.
    if (this.channels.delete(phoneId)) this.deps.forget(phoneId);
    this.plain(phoneId, 'hello', { paired: { keys: mine, proof: pairingProof(offer.secret, 'desk', me.id, phoneId, mine) } });
    this.deps.changed();
  }

  /**
   * A phone opens its channel. A refusal is a `hello`, not a `bye`: a phone only reads it while it
   * is opening one, so a replayed or forged hello cannot end the channel a phone already has.
   */
  private session(phoneId: string, raw: unknown, me: { id: string; identity: Identity }): void {
    const ask = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const paired = this.deps.paired().find((d) => d.id === phoneId);
    if (!paired) return this.plain(phoneId, 'hello', { refused: `This device is not paired with ${this.deps.here}. Pair it from Settings there.` });
    const at = typeof ask.at === 'number' && Number.isSafeInteger(ask.at) ? ask.at : NaN;
    if (!isText(ask.ephemeral, 64) || !helloSigned(paired.keys.signing, ask.signature, 'phone', phoneId, me.id, ask.ephemeral, '', at)) {
      return this.plain(phoneId, 'hello', { refused: 'The connection could not be verified as this paired device. Pair it again.' });
    }
    // A signed hello is still a recording if it is old, or not newer than the last one taken.
    if (Math.abs(this.now() - at) > HELLO_WINDOW_MS || at <= (this.lastHello.get(phoneId) ?? 0)) {
      return this.plain(phoneId, 'hello', { refused: 'That connection request is stale. Check the clock on this device and connect again.' });
    }
    this.lastHello.set(phoneId, at);
    const ephemeral = newEphemeral();
    let keys: { phoneToDesk: Buffer; deskToPhone: Buffer };
    try {
      keys = sessionKeys(ephemeral, ask.ephemeral, ask.ephemeral, ephemeral.publicKey);
    } catch {
      return this.plain(phoneId, 'hello', { refused: 'The connection could not be set up. Connect again.' });
    }
    this.deps.forget(phoneId); // a new connection starts watching nothing
    this.channels.set(phoneId, { toPhone: new FrameCipher(keys.deskToPhone), fromPhone: new FrameCipher(keys.phoneToDesk) });
    this.plain(phoneId, 'hello', { session: { ephemeral: ephemeral.publicKey, signature: signHello(me.identity, 'desk', phoneId, me.id, ask.ephemeral, ephemeral.publicKey, at) } });
    this.deps.changed();
  }
}
