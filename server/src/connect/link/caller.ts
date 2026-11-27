// This computer as the caller (account-sessions.md, section 9.2; kestrel-connect.md, "Account stage 1 as
// built"): a channel to another computer of the account, opened when a conversation that runs there is
// looked at. The same protocol 3 a phone speaks (role `caller`, the other computer `callee`): a hello with a
// fresh X25519 key and the time, signed with this computer's identity key; the callee's answer checked
// against the signing key its keyring entry gives; one key per direction through HKDF; every frame after it
// AES-256-GCM with the header bound and a rising counter (../keys.ts). No primitive is written here.
//
// - Only a computer in the keyring this computer accepted is called, and only its answers are believed.
// - Channels open when a request needs one and end with the link, a `bye`, or the device's removal. Nothing
//   is polled: a request that gets no answer fails after `timeoutMs`, and a computer that could not be reached
//   (its hello went unanswered, or the relay said it is not connected) is not asked again for `restMs` unless the
//   link comes back or the person asks again (`fresh`). A request that is slow over a channel that opened does not
//   rest the computer: it answered a moment ago, so it is busy, not away (Matt's desk, 2026-11-25: one late read
//   under load made every read after it fail for thirty seconds).
// - It opens no socket: frames go out through `send`, the relay link's.
import { checkEnvelope, CONNECT_PROTOCOL_VERSION, type ConnectOp, type ConnectResponse, type Envelope } from '../../shared/connect-ops.ts';
import { FrameCipher, helloSigned, newEphemeral, sessionKeys, signHello, type Identity } from '../keys.ts';

/** How long a hello or a request waits for its answer (a request may ask for longer: `timeoutMs`). */
export const CALL_TIMEOUT_MS = 5_000;
/**
 * How long a computer whose hello went unanswered is left alone before it is tried again. Short: it only spares a
 * window from waiting on a computer that is away, and nothing a person waits on is behind it any more (a remote
 * conversation opens from the account's copy, remote-conversation.ts).
 */
export const UNREACHABLE_REST_MS = 10_000;

export interface CallerDeps {
  /** This computer's id and identity, once it is registered. */
  me(): { id: string; identity: Identity } | null;
  /** The signing key of a device in the keyring this computer last accepted, or null. */
  member(deviceId: string): string | null;
  /** Sends a frame's text over the relay link; false when not connected. */
  send(text: string): boolean;
  /** A push from a computer this one called (live output of a session it watches there). */
  push(from: string, body: unknown): void;
  /** A channel to a computer opened: what it watched before must be asked again. */
  opened(deviceId: string): void;
  /** A computer asked for a new channel at once (its link was renewed). */
  renewed(deviceId: string): void;
  now?(): number;
  timeoutMs?: number;
  restMs?: number;
}

interface Waiter {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  to: string;
}

interface Channel {
  toCallee: FrameCipher;
  fromCallee: FrameCipher;
}

/** Why a computer could not be asked: not reached, or it refused in words a person can act on. */
export class CallFailed extends Error {}

/**
 * A request that went over an open channel and got no answer in time: that computer may still be carrying it out
 * (a start it accepted late, item 81), so it is not "nothing was done".
 */
export class CallTimedOut extends CallFailed {}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export class DeskCaller {
  private readonly channels = new Map<string, Channel>();
  private readonly opening = new Map<string, Promise<Channel>>();
  /** The hello under way with each computer, by the hello frame's id. */
  private readonly hellos = new Map<string, Waiter>();
  /** Requests waiting for their response, by request id. */
  private readonly waiting = new Map<string, Waiter>();
  /** When each computer last failed to answer. */
  private readonly unreachable = new Map<string, number>();
  private counter = 0;
  private lastAt = 0;

  constructor(private readonly deps: CallerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  connected(deviceId: string): boolean {
    return this.channels.has(deviceId);
  }

  /** Whether a computer is known not to answer now (it failed within the rest period). */
  resting(deviceId: string): boolean {
    const at = this.unreachable.get(deviceId);
    return at !== undefined && this.now() - at < (this.deps.restMs ?? UNREACHABLE_REST_MS);
  }

  /**
   * Whether a frame from the relay is this side's: a response or a push, or a hello answering one this
   * computer sent. Requests and every other hello are the callee's (channel.ts). A `bye` is both sides'.
   */
  claims(frame: Envelope): boolean {
    if (frame.kind === 'response' || frame.kind === 'push') return true;
    if (frame.kind !== 'hello') return false;
    const body = record(frame.body);
    if (body.join !== undefined) return false;
    // An answer carries no `at` (only a caller's hello does), and is from a computer this one said hello to.
    const answering = (typeof body.refused === 'string' || (typeof body.session === 'object' && body.session !== null && record(body.session).at === undefined)) && [...this.hellos.values()].some((w) => w.to === frame.from);
    return answering;
  }

  /**
   * One operation of the closed list for a computer of the account, its arguments as sent on the wire (the
   * fields `CONNECT_OPS` checks: `session.read` takes `last`, or `before` and `limit`, beside `sessionId`);
   * its answer, or `CallFailed`.
   */
  /**
   * `timeoutMs`: for an answer that waits on a person there (`setup.values`), or one nobody waits on (a read in the
   * background), longer than a call's own. `fresh`: the person asked again, so a computer resting is tried now.
   */
  async request(to: string, op: ConnectOp, args: Record<string, unknown>, opts: { timeoutMs?: number; fresh?: boolean } = {}): Promise<ConnectResponse> {
    if (opts.fresh) this.unreachable.delete(to);
    const channel = await this.channelTo(to);
    const me = this.deps.me();
    if (!me) throw new CallFailed('This computer is not signed in to Kestrel Connect.');
    const head = { v: CONNECT_PROTOCOL_VERSION, from: me.id, to, kind: 'request' as const, id: this.newId() };
    // A slow answer over an open channel does not rest the computer (see the top of this file).
    const answer = this.wait(this.waiting, head.id, to, 'did not answer in time', opts.timeoutMs, false);
    if (!this.deps.send(JSON.stringify({ ...head, body: channel.toCallee.seal(head, { op, args }) }))) {
      this.settle(this.waiting, head.id)?.reject(new CallFailed('Kestrel Connect is not connected.'));
    }
    return (await answer) as ConnectResponse;
  }

  /** The channel to a computer: the open one, the one being opened, or a new one. */
  private channelTo(to: string): Promise<Channel> {
    const open = this.channels.get(to);
    if (open) return Promise.resolve(open);
    if (this.resting(to)) return Promise.reject(new CallFailed('That computer did not answer a moment ago.'));
    const pending = this.opening.get(to) ?? this.open(to).finally(() => this.opening.delete(to));
    this.opening.set(to, pending);
    return pending;
  }

  private async open(to: string): Promise<Channel> {
    const me = this.deps.me();
    const signing = this.deps.member(to);
    if (!me) throw new CallFailed('This computer is not signed in to Kestrel Connect.');
    if (!signing) throw new CallFailed('That computer is not in your account.');
    const ephemeral = newEphemeral();
    // Strictly later than any hello before it, even within one millisecond: the callee refuses an older one.
    const at = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = at;
    const id = this.newId();
    const answer = this.wait(this.hellos, id, to, 'did not answer', undefined, true);
    const sent = this.deps.send(JSON.stringify({ v: CONNECT_PROTOCOL_VERSION, from: me.id, to, kind: 'hello', id, body: { session: { ephemeral: ephemeral.publicKey, at, signature: signHello(me.identity, 'caller', me.id, to, ephemeral.publicKey, '', at) } } }));
    if (!sent) this.settle(this.hellos, id)?.reject(new CallFailed('Kestrel Connect is not connected.'));
    const body = await answer;
    if (typeof body.refused === 'string') throw new CallFailed(body.refused);
    const session = record(body.session);
    // Its keys changed or it left the account while the hello was on its way: not believed.
    if (this.deps.member(to) !== signing) throw new CallFailed('That computer is not in your account.');
    if (typeof session.ephemeral !== 'string' || !helloSigned(signing, session.signature, 'callee', me.id, to, ephemeral.publicKey, session.ephemeral, at)) {
      throw new CallFailed('That computer could not prove it is the one your account lists.');
    }
    let keys: { callerToCallee: Buffer; calleeToCaller: Buffer };
    try {
      keys = sessionKeys(ephemeral, session.ephemeral, ephemeral.publicKey, session.ephemeral);
    } catch {
      throw new CallFailed('The connection could not be set up.');
    }
    const channel: Channel = { toCallee: new FrameCipher(keys.callerToCallee), fromCallee: new FrameCipher(keys.calleeToCaller) };
    this.channels.set(to, channel);
    this.unreachable.delete(to);
    this.deps.opened(to);
    return channel;
  }

  /** A frame `claims` said is this side's, or a `bye`. */
  receive(frame: Envelope): void {
    if (!this.deps.member(frame.from)) return;
    if (frame.kind === 'hello') return this.helloAnswered(frame);
    if (frame.kind === 'bye') return this.bye(frame);
    const channel = this.channels.get(frame.from);
    let body: unknown;
    if (channel && typeof frame.body === 'string') {
      try {
        body = channel.fromCallee.open(frame);
      } catch {
        return; // not sealed by that computer for this channel: dropped, and the channel stays
      }
    } else {
      // In the clear, only a refusal is ever believed: never a result.
      const plain = record(frame.body);
      if (frame.kind !== 'response' || plain.ok !== false) return;
      body = { ok: false, reason: typeof plain.reason === 'string' ? plain.reason : 'That computer refused.' };
    }
    if (frame.kind === 'push') return channel ? this.deps.push(frame.from, body) : undefined;
    if (frame.kind === 'response' && frame.replyTo) {
      const waiter = this.waiting.get(frame.replyTo);
      if (waiter?.to !== frame.from) return;
      this.settle(this.waiting, frame.replyTo)?.resolve(record(body));
    }
  }

  private helloAnswered(frame: Envelope): void {
    const entry = [...this.hellos].find(([, w]) => w.to === frame.from);
    if (!entry) return;
    this.settle(this.hellos, entry[0])?.resolve(record(frame.body));
  }

  private bye(frame: Envelope): void {
    const body = record(frame.body);
    const reason = typeof body.reason === 'string' ? body.reason : 'That computer ended the connection.';
    const had = this.channels.has(frame.from) || [...this.hellos.values()].some((w) => w.to === frame.from);
    this.end(frame.from, reason);
    if (had && body.again === true) this.deps.renewed(frame.from);
  }

  /** The relay could not carry a frame (its device is not connected): what waited on it fails now. */
  refused(frameId: string, reason: string): void {
    const waiter = this.settle(this.hellos, frameId) ?? this.settle(this.waiting, frameId);
    if (!waiter) return;
    this.unreachable.set(waiter.to, this.now());
    waiter.reject(new CallFailed(reason));
  }

  /** Ends a computer's channel at once: it was removed from the account. */
  remove(deviceId: string): void {
    this.end(deviceId, 'That computer was removed from your account.');
  }

  /** Ends every channel to a computer no longer in the keyring. */
  endStrangers(): void {
    for (const id of [...this.channels.keys()]) if (!this.deps.member(id)) this.end(id, 'That computer is no longer in your account.');
  }

  /** The link dropped: every channel ends with it. */
  dropAll(): void {
    const ids = new Set([...this.channels.keys(), ...[...this.hellos.values(), ...this.waiting.values()].map((w) => w.to)]);
    for (const id of ids) this.end(id, 'Kestrel Connect is not connected.');
  }

  /** The link is back: a computer that did not answer before may now. */
  linkBack(): void {
    this.unreachable.clear();
  }

  close(): void {
    this.dropAll();
  }

  private end(deviceId: string, reason: string): void {
    this.channels.delete(deviceId);
    for (const map of [this.hellos, this.waiting]) {
      for (const [id, w] of [...map]) if (w.to === deviceId) this.settle(map, id)?.reject(new CallFailed(reason));
    }
  }

  private newId(): string {
    return `c${++this.counter}`;
  }

  /** `rests`: a timeout leaves the computer alone for `restMs` (a hello), or not (a request over an open channel). */
  private wait(map: Map<string, Waiter>, id: string, to: string, what: string, timeoutMs: number | undefined, rests: boolean): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.settle(map, id)) return;
        if (rests) this.unreachable.set(to, this.now());
        reject(rests ? new CallFailed(`That computer ${what}.`) : new CallTimedOut(`That computer ${what}.`));
      }, timeoutMs ?? this.deps.timeoutMs ?? CALL_TIMEOUT_MS);
      timer.unref?.();
      map.set(id, { to, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
    });
  }

  /** Takes a waiter out of its map, so it is settled once. */
  private settle(map: Map<string, Waiter>, id: string): Waiter | null {
    const waiter = map.get(id) ?? null;
    map.delete(id);
    return waiter;
  }
}

/**
 * Where one frame from the relay goes: the answers to this computer's own calls to the caller, and the rest
 * (true) to the channel that answers callers (channel.ts). A `bye` goes to both: either end may be told its
 * channel ended.
 */
export function routeFrame(text: string, myId: string | null, caller: Pick<DeskCaller, 'claims' | 'receive'>): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return true;
  }
  const checked = checkEnvelope(raw);
  if (!checked.ok || !myId || checked.value.to !== myId || checked.value.v !== CONNECT_PROTOCOL_VERSION) return true;
  const frame = checked.value;
  if (caller.claims(frame)) {
    caller.receive(frame);
    return false;
  }
  if (frame.kind === 'bye') caller.receive(frame);
  return true;
}
