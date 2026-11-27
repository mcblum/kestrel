// The answering computer's side of copying set-up values (docs/designs/onboarding.md, 19.4 to 19.7 and
// 19.14). Another desktop of the keyring asks `setup.values` for a step's names; this checks the step and
// every name against this computer's OWN record, read now (never the request), shows the request to the
// person here for two minutes, and only on their Allow reads the values (read.ts) and hands them to the
// dispatcher's reply, which seals them into one channel frame. A Deny, the time running out, a withdraw,
// the asking computer going away, or a refusal reads nothing.
//
// What is held while a request waits is names only (`ValueRequestView`). Values exist here from the read
// to the reply and are kept in no field. The record of what was sent (19.14) is names only, one machine
// setting, this computer's own: not in the set-up record, not uploaded, never pushed to a phone. Nothing
// here logs.
import { randomUUID } from 'node:crypto';
import { Refused } from '../refused.ts';
import { NEVER_REMOTE } from '../shared/connect-ops.ts';
import type { SetupRecord } from '../shared/setup-record.ts';
import { asSentList, copyableNames, copyStepOf, SETUP_SENT_KEY, stepText, VALUE_REQUEST_TTL_MS, VALUE_WORDS, withSent, type SentEntry, type ValueRequestView, type ValuesAnswer } from '../shared/setup-values.ts';
import type { SettingStore } from '../suggestions/prefs.ts';
import { ReadFailed } from './read.ts';

export interface ValueRequestsDeps {
  /** This computer's own set-up record, read now. Throws when it cannot be (no account, not let in). */
  ownRecord(): Promise<SetupRecord>;
  /** What this computer's keyring says the asking device is; null when it is not in it. */
  device(id: string): { kind: 'desktop' | 'phone'; name: string } | null;
  /** Reads exactly the named values of a step (read.ts). Throws only `ReadFailed`. */
  read(lineId: string, names: readonly string[], own: SetupRecord): Promise<ValuesAnswer>;
  /** Where the values would be read from, in words for the card (read.ts `sourceText`). */
  source(lineId: string, own: SetupRecord): string;
  /** Where the record of what was sent is kept. */
  settings: SettingStore;
  /** This computer's name, as the asking computer is told it. */
  here(): string;
  now?(): number;
  ttlMs?: number;
}

/** What the person's Allow did, for the toast here: names only. */
export interface SentReport {
  to: string;
  step: string;
  sent: string[];
  notThere: string[];
}

interface Pending {
  view: ValueRequestView;
  device: string;
  requestId: string;
  own: SetupRecord;
  timer: NodeJS.Timeout;
  /** Hands the values to the dispatcher's reply, once. */
  resolve(answer: ValuesAnswer): void;
  reject(error: Error): void;
}

export class ValueRequests {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(view: ValueRequestView[]) => void>();
  private readonly cleared = new Map<string, SentEntry[]>();
  private clearCount = 0;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ValueRequestsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The requests waiting on the person here, as the window shows them: names only. */
  view(): ValueRequestView[] {
    return [...this.pending.values()].map((p) => p.view);
  }

  onChange(listener: (view: ValueRequestView[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }

  /**
   * A desktop of the keyring asks for a step's values: checked, shown, and answered when the person here
   * says Allow. Refused with the reason, having read nothing, for anything else.
   */
  async ask(device: string, args: { requestId: string; line: string; names: string[] }): Promise<ValuesAnswer> {
    const here = this.deps.here();
    const asker = this.deps.device(device);
    if (!asker || asker.kind !== 'desktop') throw new Refused(NEVER_REMOTE.setup!);
    if ([...this.pending.values()].some((p) => p.device === device)) throw new Refused(VALUE_WORDS.busy(here));
    if (!copyStepOf(args.line)) throw new Refused(VALUE_WORDS.kind);
    let own: SetupRecord;
    try {
      own = await this.deps.ownRecord();
    } catch {
      throw new Refused(VALUE_WORDS.notReady(here));
    }
    const names = copyableNames(own, args.line);
    if (!names) throw new Refused(VALUE_WORDS.noStep(here, args.line));
    const stray = args.names.find((n) => !names.includes(n));
    if (stray) throw new Refused(VALUE_WORDS.noName(here, stepText(args.line), stray));
    // Checked again after the await: a second request from the same computer may have arrived meanwhile.
    if ([...this.pending.values()].some((p) => p.device === device)) throw new Refused(VALUE_WORDS.busy(here));
    const id = randomUUID();
    const view: ValueRequestView = { id, from: { id: device, name: asker.name }, line: args.line, step: stepText(args.line), names: [...args.names], source: this.deps.source(args.line, own), expiresAt: this.now() + (this.deps.ttlMs ?? VALUE_REQUEST_TTL_MS) };
    return new Promise<ValuesAnswer>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new Refused(VALUE_WORDS.expired(here))), this.deps.ttlMs ?? VALUE_REQUEST_TTL_MS);
      timer.unref?.();
      this.pending.set(id, { view, device, requestId: args.requestId, own, timer, resolve, reject });
      this.changed();
    });
  }

  /** Ends a request without an answer: it is refused with `error`, and nothing was read. */
  private settle(id: string, error: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.reject(error);
    this.changed();
  }

  /**
   * The person here answered. Deny: refused, nothing read, nothing recorded. Allow: only now are the
   * values read, handed to the reply, and the names recorded. Answers what was sent, by name.
   */
  async answer(id: string, allow: boolean): Promise<SentReport | null> {
    const p = this.pending.get(id);
    if (!p) throw new Refused('That request is no longer waiting: it was answered, withdrawn or ran out of time.');
    const here = this.deps.here();
    if (!allow) {
      this.settle(id, new Refused(VALUE_WORDS.denied(here)));
      return null;
    }
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.changed();
    let answer: ValuesAnswer;
    try {
      answer = await this.deps.read(p.view.line, p.view.names, p.own);
    } catch (error) {
      const reason = error instanceof ReadFailed ? `${here} could not read the values: ${error.message}` : `${here} could not read the values.`;
      p.reject(new Refused(reason));
      throw new Refused(reason);
    }
    const sent = Object.keys(answer.values);
    p.resolve(answer);
    if (sent.length > 0) await this.record({ at: this.now(), to: p.view.from, line: p.view.line, step: p.view.step, names: sent, notThere: answer.notThere });
    return { to: p.view.from.name, step: p.view.step, sent, notThere: answer.notThere };
  }

  /** The asking computer took its request back. */
  withdraw(device: string, requestId: string): void {
    for (const [id, p] of this.pending) if (p.device === device && p.requestId === requestId) this.settle(id, new Refused(VALUE_WORDS.withdrawn));
  }

  /** The asking computer's channel ended, it was removed, or Kestrel is quitting: its requests go. */
  dropDevice(device: string): void {
    for (const [id, p] of this.pending) if (p.device === device) this.settle(id, new Refused(VALUE_WORDS.withdrawn));
  }

  close(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, new Refused(VALUE_WORDS.withdrawn));
  }

  // ---- the record of what was sent (19.14) -------------------------------------------------------

  async sent(): Promise<SentEntry[]> {
    try {
      return asSentList(JSON.parse((await this.deps.settings.getSetting(SETUP_SENT_KEY)) ?? '[]'));
    } catch {
      return [];
    }
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private record(entry: SentEntry): Promise<void> {
    return this.queued(async () => this.deps.settings.putSetting(SETUP_SENT_KEY, JSON.stringify(withSent(await this.sent(), entry))));
  }

  /** Empties the record; answers a token Undo puts it back with. */
  clearSent(): Promise<string> {
    return this.queued(async () => {
      const before = await this.sent();
      await this.deps.settings.putSetting(SETUP_SENT_KEY, '[]');
      const token = `sent-${++this.clearCount}`;
      this.cleared.set(token, before);
      return token;
    });
  }

  /** Undo of Clear: the record as it was, with anything sent since kept in front. */
  restoreSent(token: string): Promise<SentEntry[]> {
    return this.queued(async () => {
      const before = this.cleared.get(token);
      if (!before) throw new Refused('That can no longer be undone.');
      this.cleared.delete(token);
      const since = await this.sent();
      await this.deps.settings.putSetting(SETUP_SENT_KEY, JSON.stringify(asSentList([...since, ...before])));
      return this.sent();
    });
  }
}
