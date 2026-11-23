// The phone's end of Kestrel Connect, as a stand-in: what the iPhone app does, written from the same
// protocol, for the command-line phone (server/scripts/connect-phone.ts) and the end-to-end tests.
// Not used by the desktop. The iPhone app has its own Swift implementation (design doc, section 2).
import { CONNECT_PROTOCOL_VERSION, checkEnvelope, type ConnectResponse, type Envelope } from '../../shared/connect-ops.ts';
import { FrameCipher, helloSigned, newEphemeral, pairingProof, parsePairingCode, proofMatches, publicIdentity, sessionKeys, signHello, type Identity, type PublicIdentity } from '../keys.ts';

/** A desk this phone has paired with. */
export interface PairedDesk {
  id: string;
  keys: PublicIdentity;
}

export interface PhoneDeps {
  id: string;
  name: string;
  identity: Identity;
  /** Sends a frame's text over the relay. */
  send(text: string): void;
  /** How long to wait for an answer. */
  timeoutMs?: number;
}

type Waiter = { resolve(body: Record<string, unknown>): void; reject(error: Error): void };

export class PhoneChannel {
  private counter = 0;
  private hello: Waiter | null = null;
  private readonly answers = new Map<string, (response: ConnectResponse) => void>();
  private channel: { desk: string; toDesk: FrameCipher; fromDesk: FrameCipher } | null = null;
  /** The desk a pairing or hello is under way with: only its frames are listened to then. */
  private talkingTo: string | null = null;
  private readonly pushes = new Set<(body: unknown) => void>();
  private lastAt = 0;
  /** Why the desk ended the channel, the last time it did. */
  lastBye: string | null = null;

  constructor(private readonly deps: PhoneDeps) {}

  private newId(): string {
    return `p${++this.counter}`;
  }

  private sendPlain(to: string, kind: 'hello' | 'bye', body: unknown): void {
    this.deps.send(JSON.stringify({ v: CONNECT_PROTOCOL_VERSION, from: this.deps.id, to, kind, id: this.newId(), body }));
  }

  private waitHello(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.hello = null;
        reject(new Error('The computer did not answer.'));
      }, this.deps.timeoutMs ?? 15_000);
      this.hello = { resolve: (b) => (clearTimeout(timer), resolve(b)), reject: (e) => (clearTimeout(timer), reject(e)) };
    });
  }

  /** Pairs with the desk whose code was scanned or typed. */
  async pair(code: string): Promise<PairedDesk> {
    const parsed = parsePairingCode(code);
    if (!parsed) throw new Error('That is not a Kestrel pairing code.');
    const keys = publicIdentity(this.deps.identity);
    this.talkingTo = parsed.deskId;
    const answer = this.waitHello();
    this.sendPlain(parsed.deskId, 'hello', { pair: { name: this.deps.name, keys, proof: pairingProof(parsed.secret, 'phone', parsed.deskId, this.deps.id, keys, this.deps.name) } });
    const body = await answer;
    if (typeof body.refused === 'string') throw new Error(body.refused);
    const paired = body.paired as { keys?: PublicIdentity; proof?: unknown } | undefined;
    if (!paired?.keys || !proofMatches(pairingProof(parsed.secret, 'desk', parsed.deskId, this.deps.id, paired.keys), paired.proof)) throw new Error('The computer could not prove it showed that code. Do not pair with it.');
    return { id: parsed.deskId, keys: paired.keys };
  }

  /** Opens the encrypted channel to a paired desk, fresh keys for this connection. */
  async open(desk: PairedDesk): Promise<void> {
    const ephemeral = newEphemeral();
    this.talkingTo = desk.id;
    // Strictly later than any hello before it, even within one millisecond.
    const at = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = at;
    const answer = this.waitHello();
    this.sendPlain(desk.id, 'hello', { session: { ephemeral: ephemeral.publicKey, at, signature: signHello(this.deps.identity, 'phone', this.deps.id, desk.id, ephemeral.publicKey, '', at) } });
    const body = await answer;
    const session = body.session as { ephemeral?: unknown; signature?: unknown } | undefined;
    if (typeof body.refused === 'string') throw new Error(body.refused);
    if (typeof session?.ephemeral !== 'string' || !helloSigned(desk.keys.signing, session.signature, 'desk', this.deps.id, desk.id, ephemeral.publicKey, session.ephemeral, at)) throw new Error('The computer could not prove it is the one this phone paired with.');
    const keys = sessionKeys(ephemeral, session.ephemeral, ephemeral.publicKey, session.ephemeral);
    this.channel = { desk: desk.id, toDesk: new FrameCipher(keys.phoneToDesk), fromDesk: new FrameCipher(keys.deskToPhone) };
  }

  /** One operation (a name from CONNECT_OPS, and its arguments as sent), sealed; the desk's answer. */
  request(op: string, args: Record<string, unknown> = {}): Promise<ConnectResponse> {
    const channel = this.channel;
    if (!channel) return Promise.reject(new Error('Open the channel first.'));
    const head = { v: CONNECT_PROTOCOL_VERSION, from: this.deps.id, to: channel.desk, kind: 'request' as const, id: this.newId() };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.answers.delete(head.id);
        reject(new Error('The computer did not answer.'));
      }, this.deps.timeoutMs ?? 15_000);
      this.answers.set(head.id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.deps.send(JSON.stringify({ ...head, body: channel.toDesk.seal(head, { op, args }) }));
    });
  }

  /** Sends a frame exactly as given (tests use it to send what a phone should not). */
  sendRaw(frame: object): void {
    this.deps.send(JSON.stringify(frame));
  }

  /** The sealed frame `request` would send, without sending it (tests change it on the way). */
  sealedRequest(op: string, args: Record<string, unknown> = {}): Envelope<string> {
    if (!this.channel) throw new Error('Open the channel first.');
    const head = { v: CONNECT_PROTOCOL_VERSION, from: this.deps.id, to: this.channel.desk, kind: 'request' as const, id: this.newId() };
    return { ...head, body: this.channel.toDesk.seal(head, { op, args }) };
  }

  onPush(listener: (body: unknown) => void): () => void {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }

  /** One frame's text from the relay. */
  receive(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof (raw as { service?: unknown }).service === 'string') return;
    const checked = checkEnvelope(raw);
    if (!checked.ok || checked.value.to !== this.deps.id) return;
    const frame = checked.value;
    // Only the desk this phone is talking to is listened to.
    if (frame.from !== (this.channel?.desk ?? this.talkingTo)) return;
    if (frame.kind === 'hello') {
      const waiter = this.hello;
      this.hello = null;
      waiter?.resolve(typeof frame.body === 'object' && frame.body !== null ? (frame.body as Record<string, unknown>) : {});
      return;
    }
    if (frame.kind === 'bye') {
      this.lastBye = String((frame.body as { reason?: unknown })?.reason ?? 'The computer ended the connection.');
      this.channel = null;
      this.hello?.reject(new Error(this.lastBye));
      this.hello = null;
      for (const answer of this.answers.values()) answer({ ok: false, reason: this.lastBye });
      this.answers.clear();
      return;
    }
    // A refusal in the clear (no channel): only ever `{ ok: false }`, never a result.
    const sealed = this.channel && frame.from === this.channel.desk && typeof frame.body === 'string';
    let body: unknown;
    if (sealed && this.channel) {
      try {
        body = this.channel.fromDesk.open(frame);
      } catch {
        return; // dropped: not sealed by the desk; the channel stays
      }
    } else {
      const plain = frame.body as ConnectResponse;
      body = plain && typeof plain === 'object' && plain.ok === false ? plain : null;
      if (!body) return;
    }
    if (frame.kind === 'response' && frame.replyTo) {
      const answer = this.answers.get(frame.replyTo);
      this.answers.delete(frame.replyTo);
      answer?.(body as ConnectResponse);
    } else if (frame.kind === 'push') {
      for (const listener of this.pushes) listener(body);
    }
  }
}
