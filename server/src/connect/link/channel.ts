// The desk's end of Kestrel Connect between devices (kestrel-connect.md, "Account stage 1 as built"): the
// per-connection handshake with any device of the account's keyring that calls this computer, and every
// frame after it sealed both ways (../keys.ts). A decrypted request goes to the dispatcher's `receive`;
// what the dispatcher sends is sealed for its device here. A `hello` that carries `join` goes to the join
// flow (join.ts). A device not in the keyring gets a refusal in plain words and nothing else.
import { CONNECT_PROTOCOL_VERSION, checkEnvelope, versionRefusal, type Envelope } from '../../shared/connect-ops.ts';
import { FrameCipher, helloSigned, newEphemeral, sessionKeys, signHello, type Identity } from '../keys.ts';

/** How far a caller's signed hello time may be from this computer's clock. */
export const HELLO_WINDOW_MS = 5 * 60_000;

/** What the channel needs of the module around it. */
export interface ChannelDeps {
  /** This computer's id and identity, once it is registered. */
  me(): { id: string; identity: Identity } | null;
  /** The signing key of a device in the keyring this computer last accepted, or null (not in, or this computer holds no key). */
  member(deviceId: string): string | null;
  /** Whether this computer holds the account key: until it does, it takes no channel. */
  holdsKey(): boolean;
  /** A `hello` carrying `join`, for the join flow. */
  join(from: string, body: unknown): void;
  /** Sends a frame's text over the relay link; false when not connected. */
  send(text: string): boolean;
  /** A decrypted frame for the dispatcher. */
  deliver(frame: Envelope): void;
  /** The device went away (bye, removed, its channel ended): it watches nothing any more. */
  forget(deviceId: string): void;
  /** Something the Settings part shows changed (who is connected). */
  changed(): void;
  /** "your Mac", in refusals. */
  here: string;
  now?(): number;
}

interface Channel {
  toCaller: FrameCipher;
  fromCaller: FrameCipher;
}

const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export class DeskChannel {
  private readonly channels = new Map<string, Channel>();
  /** The newest hello time accepted from each caller: an older or equal one is a replay. */
  private readonly lastHello = new Map<string, number>();
  private counter = 0;
  /** Callers whose channel ended with the link: told to say hello again when the link is back. */
  private readonly dropped = new Set<string>();

  constructor(private readonly deps: ChannelDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  connected(deviceId: string): boolean {
    return this.channels.has(deviceId);
  }

  /** The devices with a channel open to this computer now. */
  connectedIds(): string[] {
    return [...this.channels.keys()];
  }

  /** Ends a device's channel at once (it is being removed from the account). */
  remove(deviceId: string): void {
    this.endChannel(deviceId, 'This device was removed from your Kestrel account.');
    this.dropped.delete(deviceId);
    this.lastHello.delete(deviceId);
  }

  /** Ends every channel whose device is no longer in the keyring (the key was rotated without it). */
  endStrangers(): void {
    for (const id of [...this.channels.keys()]) if (!this.deps.member(id)) this.endChannel(id, 'This device is no longer in your Kestrel account.');
  }

  /** A `hello` in the clear, for the join flow. */
  sendHello(to: string, body: unknown): void {
    this.plain(to, 'hello', body);
  }

  /** The link dropped: every channel ends; callers say hello again when it is back. */
  dropAll(): void {
    for (const id of [...this.channels.keys()]) {
      this.channels.delete(id);
      this.deps.forget(id);
      this.dropped.add(id);
    }
    this.deps.changed();
  }

  /**
   * The link is back: each caller whose channel ended with it is told, so it says hello again now
   * rather than finding out at its next request. Its own socket may never have dropped.
   */
  linkBack(): void {
    for (const id of this.dropped) if (this.deps.member(id) && !this.channels.has(id)) this.sayHelloAgain(id);
    this.dropped.clear();
  }

  /** A `bye` in the clear that asks the caller to open a new channel at once (`again`). */
  private sayHelloAgain(deviceId: string): void {
    this.plain(deviceId, 'bye', { reason: `The connection to ${this.deps.here} was renewed. Say hello again.`, again: true });
  }

  /** Seals a frame the dispatcher sends for its device; dropped when that device has no channel. */
  sendSealed(frame: Envelope): boolean {
    const channel = this.channels.get(frame.to);
    if (!channel) return false;
    const { body, ...head } = frame;
    return this.deps.send(JSON.stringify({ ...head, body: channel.toCaller.seal(head, body) }));
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
    const member = this.deps.member(frame.from);
    const channel = this.channels.get(frame.from);
    if (!member) return this.refuse(frame, me.id, notKnown(this.deps.here));
    if (!channel) {
      // The caller still thinks it has a channel (this side's link dropped, or this computer restarted):
      // answer the request, then end the channel it holds so it says hello again.
      if (frame.kind === 'request') this.plain(frame.from, 'response', { ok: false, reason: 'Say hello again first: the connection to this computer was renewed.' }, frame.id);
      if (frame.kind !== 'bye') this.sayHelloAgain(frame.from);
      return;
    }
    let body: unknown;
    try {
      body = channel.fromCaller.open(frame);
    } catch {
      // Changed on the way, replayed, or not sealed by the caller: dropped, and nothing in it is
      // trusted. The channel stays: anyone on the path could send such a frame, and ending the
      // channel for it would let them cut the real caller off. The counter did not move.
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
    if (body.join !== undefined) return this.deps.join(frame.from, body.join);
    if (body.session !== undefined) return this.session(frame.from, body.session, me);
    // A `hello { refused }` is an answer to a hello this computer never sends: ignored, never answered.
    if (body.refused !== undefined) return;
    if (body.pair !== undefined) return this.plain(frame.from, 'hello', { refused: 'Pairing was replaced by letting a device into the account. Update Kestrel on this device.' });
    this.plain(frame.from, 'hello', { refused: 'A hello must join or open a session.' });
  }

  /**
   * A device of the account opens its channel. A refusal is a `hello`, not a `bye`: a caller only reads it
   * while it is opening one, so a replayed or forged hello cannot end the channel a caller already has.
   */
  private session(callerId: string, raw: unknown, me: { id: string; identity: Identity }): void {
    const ask = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (!this.deps.holdsKey()) return this.plain(callerId, 'hello', { refused: `${capital(this.deps.here)} cannot take connections until it is let into your account.` });
    const signing = this.deps.member(callerId);
    if (!signing) return this.plain(callerId, 'hello', { refused: notKnown(this.deps.here) });
    const at = typeof ask.at === 'number' && Number.isSafeInteger(ask.at) ? ask.at : NaN;
    if (!isText(ask.ephemeral, 64) || !helloSigned(signing, ask.signature, 'caller', callerId, me.id, ask.ephemeral, '', at)) {
      return this.plain(callerId, 'hello', { refused: 'The connection could not be verified as a device of your account. Connect again.' });
    }
    // A signed hello is still a recording if it is old, or not newer than the last one taken.
    if (Math.abs(this.now() - at) > HELLO_WINDOW_MS || at <= (this.lastHello.get(callerId) ?? 0)) {
      return this.plain(callerId, 'hello', { refused: 'That connection request is stale. Check the clock on this device and connect again.' });
    }
    this.lastHello.set(callerId, at);
    const ephemeral = newEphemeral();
    let keys: { callerToCallee: Buffer; calleeToCaller: Buffer };
    try {
      keys = sessionKeys(ephemeral, ask.ephemeral, ask.ephemeral, ephemeral.publicKey);
    } catch {
      return this.plain(callerId, 'hello', { refused: 'The connection could not be set up. Connect again.' });
    }
    this.deps.forget(callerId); // a new connection starts watching nothing
    this.dropped.delete(callerId);
    this.channels.set(callerId, { toCaller: new FrameCipher(keys.calleeToCaller), fromCaller: new FrameCipher(keys.callerToCallee) });
    this.plain(callerId, 'hello', { session: { ephemeral: ephemeral.publicKey, signature: signHello(me.identity, 'callee', callerId, me.id, ask.ephemeral, ephemeral.publicKey, at) } });
    this.deps.changed();
  }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const notKnown = (here: string): string => `${capital(here)} does not know this device. Let it into your account first.`;
