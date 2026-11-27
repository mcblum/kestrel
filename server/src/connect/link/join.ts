// Letting a device into the account (account-sessions.md, section 4.4; the contract is
// kestrel-connect.md, "Account stage 1 as built"). Both ends on one device: as the new device (N) it asks,
// reveals to the first device that opens its request, shows the code, and takes the key only from that
// device and only once the person types the second code that device shows (step 8a); as a device that holds
// the key (A) it lists requests, opens one when the person chooses it, checks the reveal against the
// commitment, takes the code the person types and, when it is right, grants the key, sends a signed welcome
// and shows the second code. The service carries every step and is trusted with none of it. Every frame
// here is a `hello` in the clear.
import { codesMatch, joinCode, joinConfirmCode, joinDeclinedSigned, joinJoinedSigned, signJoinDeclined, signJoinJoined, JOIN_DECLINED_REASONS, type JoinDeclined, joinCommitment, joinCommitted, joinWelcomeSigned, newJoinNonce, publicIdentity, shownCode, signJoinWelcome, typedCode, type Identity, type PublicIdentity } from '../keys.ts';
import { Refused } from '../../refused.ts';
import type { DeviceKind, ConnectJoining, ConnectJoinRequest } from '../../shared/connect.ts';
import type { JoinAnchor } from './account-keys.ts';
import type { JoinApi, JoinRequest } from './join-api.ts';

export const MAX_WRONG_CODES = 3;


export interface JoinDeps {
  /** The service's join routes, or null while not connected. */
  api(): JoinApi | null;
  me(): { id: string; name: string; kind: DeviceKind; identity: Identity } | null;
  keys: {
    ready(): unknown;
    grant(device: { id: string; name: string; kind: DeviceKind; keys: PublicIdentity }): Promise<{ generation: number; keyringVersion: number }>;
    acceptFrom(anchor: JoinAnchor): Promise<void>;
    /** Deletes this device's copy at the service (step 8b). */
    discardCopy(): Promise<void>;
    /** Reads the key again; a key holder then withdraws copyless devices (step 8b). */
    sync(): Promise<void>;
  };
  /** Sends a `hello` in the clear to a device. */
  hello(to: string, body: unknown): void;
  changed(): void;
  /** This device was let in by `by`. */
  joined?(by: string): void;
  /** This device let `name` in. */
  letIn?(name: string): void;
  now?(): number;
}

interface Approver {
  id: string;
  name: string;
  keys: PublicIdentity;
  nonce: Buffer;
}

interface Asking {
  request: JoinRequest;
  nonce: Buffer;
  approver: Approver | null;
  code: string | null;
  welcome: JoinAnchor | null;
  /** The second code as this device works it out from the welcome it was given (step 8a). */
  confirmCode: string | null;
  wrong: number;
  problem: string | null;
  signature: string | null;
}

interface Opened {
  request: JoinRequest;
  state: ConnectJoinRequest['state'];
  nonce: Buffer | null;
  theirKeys: PublicIdentity | null;
  theirNonce: Buffer | null;
  code: string | null;
  wrong: number;
  problem: string | null;
  /** The second code, shown once the device was let in, until the device answers or the join's time runs out. */
  confirmCode: string | null;
  /** The grant, for checking the device's `joined`. */
  granted: { generation: number; keyringVersion: number } | null;
  /** What happened, once it did (step 8c). */
  outcome: string | null;
}

type Step = Record<string, unknown>;

const B64U_32 = /^[A-Za-z0-9_-]{43}$/;
const isKeys = (value: unknown): value is PublicIdentity => {
  const k = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return typeof k.signing === 'string' && B64U_32.test(k.signing) && typeof k.agreement === 'string' && B64U_32.test(k.agreement);
};
const nonceOf = (value: unknown): Buffer | null => (typeof value === 'string' && B64U_32.test(value) ? Buffer.from(value, 'base64url') : null);
const nameOf = (value: unknown): string => (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 64) : 'another device');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const notMeAdvice = (name: string): string => `If you did not sign in on ${name}, someone has your sign-in. Remove it and sign out everywhere.`;

export class AccountJoin {
  private asking: Asking | null = null;
  private outcome: { state: 'in'; by: string } | { state: 'ended'; reason: string } | null = null;
  private readonly opened = new Map<string, Opened>();
  private askedOnItsOwn = false;
  /** An ask on its way to the service: a second ask meanwhile joins it rather than racing it. */
  private askInFlight: Promise<void> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: JoinDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private api(): JoinApi {
    const api = this.deps.api();
    if (!api) throw new Refused('Turn Kestrel Connect on, sign in, and wait until it says Connected.');
    return api;
  }

  private me() {
    const me = this.deps.me();
    if (!me) throw new Refused('This device is not registered with Kestrel Connect yet.');
    return me;
  }

  /** What Settings shows of this device asking. */
  joining(): ConnectJoining | null {
    const a = this.asking;
    if (a) {
      if (a.welcome && a.approver) return { state: 'confirm', by: a.approver.name, wrong: a.wrong, problem: a.problem };
      if (a.request.expiresAt <= this.now()) return { state: 'ended', reason: 'The request to join expired. Ask again.' };
      if (a.code && a.approver) return { state: 'code', code: shownCode(a.code), by: a.approver.name, expiresAt: a.request.expiresAt };
      return { state: 'asking', expiresAt: a.request.expiresAt };
    }
    return this.outcome;
  }

  /** What Settings shows of other devices asking. */
  requests(): ConnectJoinRequest[] {
    const now = this.now();
    return [...this.opened.values()]
      .filter((o) => o.state === 'showing' || o.state === 'done' || o.state === 'letting-in' || o.request.expiresAt > now)
      .sort((a, b) => a.request.createdAt - b.request.createdAt)
      .map((o) => {
        const name = o.request.device.name;
        // Step 8c: no word from the device by the join's time limit.
        const silent = o.state === 'showing' && o.request.expiresAt <= now;
        const state = silent ? 'done' : o.state;
        const outcome = silent ? `${name} did not say whether it finished. If it is not in your account, remove it.` : o.outcome;
        return { id: o.request.id, name, kind: o.request.device.kind, expiresAt: o.request.expiresAt, state, wrong: o.wrong, problem: o.problem, code: state === 'showing' && o.confirmCode ? shownCode(o.confirmCode) : null, outcome };
      });
  }

  /** Forgets everything (signed out, or Connect off). */
  reset(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.asking = null;
    this.outcome = null;
    this.opened.clear();
    this.askedOnItsOwn = false;
    this.deps.changed();
  }

  // As the new device.

  /** Asks to be let in, with a new nonce (never one shown to another device before). One at a time. */
  ask(): Promise<void> {
    this.askInFlight ??= this.askNow().finally(() => (this.askInFlight = null));
    return this.askInFlight;
  }

  private async askNow(): Promise<void> {
    const me = this.me();
    const nonce = newJoinNonce();
    const request = await this.api().ask(joinCommitment(nonce, publicIdentity(me.identity)));
    this.asking = { request, nonce, approver: null, code: null, welcome: null, confirmCode: null, wrong: 0, problem: null, signature: null };
    this.outcome = null;
    this.deps.changed();
  }

  /** Asks once on its own, the first time this device finds it is not in: later asks are the person's (Ask again). */
  async askOnce(): Promise<void> {
    if (this.asking || this.askedOnItsOwn || this.outcome?.state === 'in') return;
    this.askedOnItsOwn = true;
    try {
      await this.ask();
    } catch (error) {
      this.outcome = { state: 'ended', reason: `Could not ask to join your account: ${message(error)}` };
      this.deps.changed();
    }
  }

  /**
   * Step 8a: the second code, shown on the device that let this one in, typed here. The key is kept only when it
   * is the code this device works out from the welcome it was given; the third wrong one discards the key.
   */
  async confirm(text: string): Promise<void> {
    const a = this.asking;
    if (!a?.welcome || !a.approver || !a.confirmCode) throw new Refused('Nothing is waiting to be confirmed.');
    const by = a.approver.name;
    const typed = typedCode(text);
    if (!typed) throw new Refused(`Type the six digits ${by} shows.`);
    if (!codesMatch(a.confirmCode, typed)) {
      a.wrong += 1;
      if (a.wrong >= MAX_WRONG_CODES) {
        await this.discard('wrong-code', `Three wrong codes were typed, so ${this.me().name} did not keep the key it was offered. ${notMeAdvice(this.me().name)} Then ask again.`);
        throw new Refused(this.outcome?.state === 'ended' ? this.outcome.reason : 'Not let in.');
      }
      a.problem = `That is not the code ${by} shows. ${MAX_WRONG_CODES - a.wrong} ${MAX_WRONG_CODES - a.wrong === 1 ? 'try' : 'tries'} left.`;
      this.deps.changed();
      throw new Refused(a.problem);
    }
    this.asking = null;
    try {
      await this.deps.keys.acceptFrom(a.welcome);
    } catch (error) {
      this.asking = a;
      await this.discard('cancelled', message(error));
      return;
    }
    const me = this.me();
    this.deps.hello(a.approver.id, { join: { step: 'joined', id: a.request.id, signature: signJoinJoined(me.identity, a.request.id, me.id, a.approver.id, a.welcome.generation, a.welcome.keyringVersion) } });
    this.outcome = { state: 'in', by };
    this.deps.joined?.(by);
    this.deps.changed();
  }

  /** Cancel at step 8a: the key offered is not kept. */
  async cancel(): Promise<void> {
    if (!this.asking) throw new Refused('Nothing is waiting to be confirmed.');
    await this.discard('cancelled', `${this.me().name} did not keep the key it was offered. Ask again when you are ready.`);
  }

  /**
   * Step 8b: the key offered is not kept. Its copy is deleted at the service first (so a key holder withdraws
   * this device from the keyring), then the device that let it in is told, signed.
   */
  private async discard(why: JoinDeclined, reason: string): Promise<void> {
    const a = this.asking;
    this.asking = null;
    if (a?.welcome) {
      await this.deps.keys.discardCopy().catch((error: unknown) => console.error(`[kestrel] could not delete the key copy this device did not keep: ${message(error)}`));
    }
    if (a?.welcome && a.approver) {
      const me = this.me();
      this.deps.hello(a.approver.id, { join: { step: 'declined', id: a.request.id, reason: why, signature: signJoinDeclined(me.identity, a.request.id, me.id, a.approver.id, why) } });
    }
    if (a) await this.deps.api()?.end(a.request.id).catch(() => undefined);
    this.outcome = { state: 'ended', reason };
    this.deps.changed();
  }

  /** Whether this device is part-way through being let in (a copy it cannot open yet is expected then). */
  busy(): boolean {
    return this.asking?.approver != null;
  }

  private after(ms: number, work: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, Math.max(0, ms));
    timer.unref?.();
    this.timers.add(timer);
  }

  // As a device that holds the key.

  /** Reads the account's open requests (on connecting). */
  async refresh(): Promise<void> {
    const api = this.deps.api();
    const me = this.deps.me();
    if (!api || !me) return;
    const list = await api.list();
    const open = new Set(list.map((r) => r.id));
    for (const [id, o] of this.opened) if (!open.has(id) && o.state !== 'letting-in') this.opened.delete(id);
    for (const request of list) this.noticed(request, false);
    this.deps.changed();
  }

  /** The service says a device asked. */
  noticed(request: JoinRequest, announce = true): void {
    const me = this.deps.me();
    if (!me || request.device.id === me.id || this.opened.has(request.id)) return;
    this.opened.set(request.id, { request, state: 'waiting', nonce: null, theirKeys: null, theirNonce: null, code: null, wrong: 0, problem: null, confirmCode: null, granted: null, outcome: null });
    if (announce) this.deps.changed();
  }

  /** The service says a request ended (withdrawn, refused, replaced, or answered by a grant). */
  ended(id: string): void {
    const o = this.opened.get(id);
    if (o && o.state !== 'letting-in' && o.state !== 'showing' && o.state !== 'done') this.opened.delete(id);
    // This device's own request: ended before anyone opened it (a grant ends it too, before the welcome arrives).
    if (this.asking?.request.id === id && !this.asking.approver) {
      this.asking = null;
      this.outcome = { state: 'ended', reason: 'The request to join ended before another device opened it. Ask again.' };
    }
    this.deps.changed();
  }

  /** The person chose a request here: it is opened, never on its own (two devices opening one would race). */
  open(id: string): void {
    const o = this.opened.get(id);
    if (!o) throw new Refused('That request has ended. The device can ask again.');
    if (!this.deps.keys.ready()) throw new Refused('This computer does not hold your account key yet, so it cannot let another device in.');
    const me = this.me();
    o.nonce = newJoinNonce();
    o.state = 'opening';
    o.problem = null;
    this.deps.hello(o.request.device.id, { join: { step: 'open', id, nonce: o.nonce.toString('base64url'), keys: publicIdentity(me.identity), name: me.name } });
    this.deps.changed();
  }

  /** The code the person typed: Allow when it is right; the third wrong one refuses the request. */
  async type(id: string, text: string): Promise<void> {
    const o = this.opened.get(id);
    if (!o || o.state !== 'typing' || !o.code || !o.theirKeys) throw new Refused('That request is not waiting for a code. Open it first.');
    const typed = typedCode(text);
    if (!typed) throw new Refused(`Type the six digits ${o.request.device.name} shows.`);
    if (!codesMatch(o.code, typed)) {
      o.wrong += 1;
      if (o.wrong >= MAX_WRONG_CODES) {
        await this.refuse(id, `Three wrong codes were typed on ${this.me().name}. Ask again if this was you.`);
        throw new Refused(`That was the third wrong code, so ${o.request.device.name} was not let in. ${notMeAdvice(o.request.device.name)}`);
      }
      o.problem = `That is not the code ${o.request.device.name} shows. ${MAX_WRONG_CODES - o.wrong} ${MAX_WRONG_CODES - o.wrong === 1 ? 'try' : 'tries'} left.`;
      this.deps.changed();
      throw new Refused(o.problem);
    }
    await this.letIn(o);
  }

  private async letIn(o: Opened): Promise<void> {
    const me = this.me();
    const keys = o.theirKeys as PublicIdentity;
    const device = o.request.device;
    o.state = 'letting-in';
    o.problem = null;
    this.deps.changed();
    try {
      const granted = await this.deps.keys.grant({ id: device.id, name: device.name, kind: device.kind, keys });
      const signature = signJoinWelcome(me.identity, o.request.id, device.id, me.id, keys, granted.generation, granted.keyringVersion);
      this.deps.hello(device.id, { join: { step: 'welcome', id: o.request.id, generation: granted.generation, keyringVersion: granted.keyringVersion, signature } });
      // Step 8a: the second code, for the person to type on the new device.
      o.confirmCode = joinConfirmCode(o.theirNonce as Buffer, o.nonce as Buffer, { joinId: o.request.id, newId: device.id, approverId: me.id, newKeys: keys, approverKeys: publicIdentity(me.identity), generation: granted.generation, keyringVersion: granted.keyringVersion, signature });
      o.state = 'showing';
      o.granted = granted;
      // Step 8c: when the join's time runs out with no word from the device, the page says so.
      this.after(o.request.expiresAt - this.now(), () => this.deps.changed());
      await this.deps.api()?.end(o.request.id).catch(() => undefined);
      this.deps.letIn?.(device.name);
    } catch (error) {
      o.state = 'typing';
      o.problem = `${device.name} could not be let in: ${message(error)}`;
      throw new Refused(o.problem);
    } finally {
      this.deps.changed();
    }
  }

  /** Done: the second code, or what happened, is no longer shown. Nothing else changes. */
  dismiss(id: string): void {
    const o = this.opened.get(id);
    if (o?.state !== 'showing' && o?.state !== 'done') throw new Refused('That device is not waiting for a second code.');
    this.opened.delete(id);
    this.deps.changed();
  }

  /** Not me, or the third wrong code: the device is told, and the request ends. */
  async refuse(id: string, reason = 'Not let in: the person said it was not them.'): Promise<void> {
    const o = this.opened.get(id);
    if (!o) return;
    this.opened.delete(id);
    // Already let in: only the second code stops being shown, and the device decides for itself.
    if (o.state === 'showing' || o.state === 'done') return this.deps.changed();
    this.deps.hello(o.request.device.id, { join: { step: 'refused', id, reason } });
    await this.deps.api()?.end(id).catch(() => undefined);
    this.deps.changed();
  }

  /** A `hello` whose body has `join`, from `from` as the relay says. */
  receive(from: string, raw: unknown): void {
    const step = (typeof raw === 'object' && raw !== null ? raw : {}) as Step;
    const id = typeof step.id === 'string' ? step.id : '';
    if (step.step === 'open') return this.opening(from, id, step);
    if (step.step === 'reveal') return this.revealed(from, id, step);
    if (step.step === 'welcome') return this.welcomed(from, id, step);
    if (step.step === 'refused') return this.refused(from, id, step);
    if (step.step === 'joined' || step.step === 'declined') return this.answered(from, id, step);
  }

  /** N: the first device to open this request gets the reveal; any other is told it is taken. */
  private opening(from: string, id: string, step: Step): void {
    const a = this.asking;
    const me = this.deps.me();
    // Not this device's open request (or this device is in already): ignored.
    if (!a || !me || a.request.id !== id || a.request.expiresAt <= this.now()) return;
    if (a.approver) {
      if (a.approver.id !== from) this.deps.hello(from, { join: { step: 'refused', id, reason: `${me.name} is already being let in from another device.` } });
      return;
    }
    const nonce = nonceOf(step.nonce);
    if (!nonce || !isKeys(step.keys)) return;
    const mine = publicIdentity(me.identity);
    a.approver = { id: from, name: nameOf(step.name), keys: step.keys, nonce };
    a.code = joinCode(a.nonce, nonce, mine, step.keys);
    this.deps.hello(from, { join: { step: 'reveal', id, nonce: a.nonce.toString('base64url'), keys: mine } });
    this.deps.changed();
  }

  /** A: the reveal must be what was committed to; then the code is made and the person may type it. */
  private revealed(from: string, id: string, step: Step): void {
    const o = this.opened.get(id);
    const me = this.deps.me();
    if (!o || !me || o.state !== 'opening' || from !== o.request.device.id || !o.nonce) return;
    const nonce = nonceOf(step.nonce);
    if (!nonce || !isKeys(step.keys) || !joinCommitted(o.request.commitment, nonce, step.keys)) {
      void this.refuse(id, 'The request could not be checked, so it was refused.');
      return;
    }
    o.theirKeys = step.keys;
    o.theirNonce = nonce;
    o.code = joinCode(nonce, o.nonce, step.keys, publicIdentity(me.identity));
    o.state = 'typing';
    this.deps.changed();
  }

  /** N: a welcome only from the device it revealed to, signed over its keys; then the person confirms (8a). */
  private welcomed(from: string, id: string, step: Step): void {
    const a = this.asking;
    const me = this.deps.me();
    if (!a?.approver || !me || a.request.id !== id || from !== a.approver.id || a.welcome) return;
    const generation = step.generation;
    const keyringVersion = step.keyringVersion;
    if (typeof generation !== 'number' || typeof keyringVersion !== 'number') return;
    if (!joinWelcomeSigned(a.approver.keys.signing, step.signature, id, me.id, a.approver.id, publicIdentity(me.identity), generation, keyringVersion)) return;
    a.welcome = { id: a.approver.id, signing: a.approver.keys.signing, generation, keyringVersion };
    a.signature = step.signature as string;
    // Step 8b: the join's time limit holds for the second code too.
    this.after(a.request.expiresAt - this.now(), () => {
      if (this.asking === a) void this.discard('expired', `The time to type the second code ran out, so ${me.name} did not keep the key it was offered. Ask again.`);
    });
    a.confirmCode = joinConfirmCode(a.nonce, a.approver.nonce, { joinId: id, newId: me.id, approverId: a.approver.id, newKeys: publicIdentity(me.identity), approverKeys: a.approver.keys, generation, keyringVersion, signature: step.signature as string });
    this.deps.changed();
  }

  /** A: the device it let in says whether it kept the key (step 8b), signed with the keys it revealed. */
  private answered(from: string, id: string, step: Step): void {
    const o = this.opened.get(id);
    const me = this.deps.me();
    if (!o || !me || o.state !== 'showing' || from !== o.request.device.id || !o.theirKeys || !o.granted) return;
    const name = o.request.device.name;
    if (step.step === 'joined') {
      if (!joinJoinedSigned(o.theirKeys.signing, step.signature, id, from, me.id, o.granted.generation, o.granted.keyringVersion)) return;
      o.outcome = `${name} is in your account.`;
    } else {
      const why = step.reason as JoinDeclined;
      if (!JOIN_DECLINED_REASONS.includes(why) || !joinDeclinedSigned(o.theirKeys.signing, step.signature, id, from, me.id, why)) return;
      const words: Record<JoinDeclined, string> = { 'wrong-code': 'the second code typed there was wrong', cancelled: 'it was cancelled there', expired: 'the time ran out there' };
      o.outcome = `${name} was not let in: ${words[why]}.`;
      // It deleted its copy first: withdraw it from the keyring now.
      void this.deps.keys.sync().catch((error: unknown) => console.error(`[kestrel] could not withdraw a device that did not keep the key: ${message(error)}`));
    }
    o.state = 'done';
    o.confirmCode = null;
    this.deps.changed();
  }

  /** A refusal, from the device each side is talking to only. */
  private refused(from: string, id: string, step: Step): void {
    const reason = typeof step.reason === 'string' ? step.reason.slice(0, 300) : 'Not let in.';
    const a = this.asking;
    if (a && a.request.id === id && a.approver?.id === from && !a.welcome) {
      this.asking = null;
      this.outcome = { state: 'ended', reason };
      this.deps.changed();
      return;
    }
    const o = this.opened.get(id);
    if (o && from === o.request.device.id && o.state === 'opening') {
      o.state = 'waiting';
      o.problem = reason;
      this.deps.changed();
    }
  }
}
