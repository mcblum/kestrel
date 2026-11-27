// What each computer offers for a new session, the desk's side (docs/designs/kestrel-connect.md, "What a computer
// offers, as built"; shared/machine-offers.ts has the record). This computer holds one sealed record in the list
// `offers`, built by the same function as the live `session.startChoices` answer, and reads every other
// computer's into `AccountOffers`, which the windows are pushed.
//
// - Written when the link comes up (always, so `made` says when this computer last connected) and whenever what
//   it says changes: the change sources (an agent's answer, the presets, the New session box's choices, the
//   switch, the projects, the projects kept off; remote-starts/offers.ts calls back only when the part the record
//   is made from changed) only schedule a write, which runs after `settleMs`, so a burst is one, and writes only
//   when the record differs from what was last sent. Nothing is polled.
// - The feed is read only when the link comes up, when the service says `changed`, and when the account's devices
//   change; a change here writes without reading. A read that fails does not stop the write after it.
// - The agents are asked only when the link comes up and when one of them answered differently: every other
//   pass reuses their last answer, so a burst of workspace changes never runs an agent's probe.
// - Reading runs when the link comes up, when the service says `changed`, and when the account's devices change.
//   Only a computer in the keyring this one accepted counts, only under the record id its own id makes, and only
//   as the writer the service names. Opening it at all proves the key.
import type { AccountOffers } from '../../account-offers.ts';
import { offersOf, type OffersSource } from '../../remote-starts/offers.ts';
import type { AgentModels } from '../../remote-starts/session-start.ts';
import { asOffersRecord, MAX_OFFERS_BODY, OFFERS_LIST, offersLabel, offersRecordOf, type HeldOffers } from '../../shared/machine-offers.ts';
import type { Machine } from '../../shared/machines.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { HeldApi } from './held-api.ts';
import { SETTLE_MS } from './held.ts';
import { WHOLE_AFTER_MS } from './replica-sync.ts';
import { ServiceRefusal } from './service.ts';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface OffersSyncDeps {
  source: OffersSource;
  store: AccountOffers;
  /** Calls back on each change of what the record is built from; `agents`: an agent's answer changed. Returns the undo. */
  watch(changed: (agents: boolean) => void): () => void;
  /** The service, when the link is up; null otherwise. */
  api(): HeldApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  desk(): Machine | null;
  /** The account's other computers that are in the keyring this computer accepted. */
  machines(): Machine[];
  /** Project ids kept off Kestrel Connect. */
  keptOff(): readonly string[];
  now?(): number;
  settleMs?: number;
}

export class OffersSync {
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What was last sent, by scope and link-up: sent again only when it differs, or after the link came up again. */
  private sent: { scope: string; epoch: number; json: string } | null = null;
  /** Rises each time the link comes up: a write made before it does not count as the one owed after it. */
  private epoch = 0;
  /** A pass asked for during one reads the feed too when any asker wanted that. */
  private againRead = false;
  /** The agents' last answer; null: ask them on the next pass. */
  private agents: AgentModels[] | null = null;
  /** A service from before the change feed refuses a listed record: not tried again this run. */
  private refused = false;
  /** How many records this computer has written in this run (tests count them). */
  writes = 0;
  private readonly unwatch: () => void;

  constructor(private readonly deps: OffersSyncDeps) {
    // Cheap on purpose: a change only schedules the pass.
    this.unwatch = deps.watch((agents) => {
      if (agents) this.agents = null;
      this.schedule();
    });
  }

  /** The link came up: the agents are asked again and the record is written, changed or not. */
  connected(): void {
    this.epoch++;
    this.agents = null;
    this.kick();
  }

  /** Reads the feed and writes now: the service said something changed, the account's devices changed. */
  kick(): void {
    if (this.closed) return;
    void this.run(true);
  }

  /** A change here: a write after it settles, with no read of the feed. */
  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) void this.run(false);
    }, this.deps.settleMs ?? SETTLE_MS);
    this.timer.unref?.();
  }

  /** One pass, one at a time; a pass asked for during one runs after it. `read`: read the feed first. */
  run(read = true): Promise<void> {
    if (this.running) {
      this.again = true;
      this.againRead ||= read;
      return this.running;
    }
    this.running = this.pass(read)
      .catch((error: unknown) => console.error(`[kestrel] could not share what this computer offers with the account: ${message(error)}`))
      .finally(() => {
        this.running = null;
        if (this.again && !this.closed) {
          const next = this.againRead;
          this.again = false;
          this.againRead = false;
          void this.run(next);
        }
      });
    return this.running;
  }

  /** Resolves when the pass under way (and one asked for meanwhile) is done. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async pass(read: boolean): Promise<void> {
    if (this.refused) return;
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    if (!api || !key || !desk) return;
    const tag = (label: string) => tagOf(key.idKey, label);
    const scope = `${desk.id}|${tag('scope')}`;
    const list = tag(OFFERS_LIST);
    if (read) {
      try {
        await this.read(api, desk, scope, list, tag);
      } catch (error) {
        if (this.oldService(error)) return;
        // The other computers' records wait for the next reading; this computer's own is still written.
        console.error(`[kestrel] could not read what the account's other computers offer: ${message(error)}`);
      }
    }
    try {
      await this.write(api, key, desk, scope, list, tag);
    } catch (error) {
      if (!this.oldService(error)) throw error;
    }
  }

  /** A service from before the change feed: not asked again this run. */
  private oldService(error: unknown): boolean {
    if (!(error instanceof ServiceRefusal && (error.status === 400 || error.status === 404))) return false;
    this.refused = true;
    console.error(`[kestrel] Kestrel Connect does not take a record of what a computer offers yet, so devices ask each computer: ${message(error)}`);
    return true;
  }

  private async read(api: HeldApi, desk: Machine, scope: string, list: string, tag: (label: string) => string): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const machines = new Map(this.deps.machines().filter((m) => m.id !== desk.id).map((m) => [m.id, m]));
    const members = [...machines.keys()];
    const mark = await this.deps.store.feedMark();
    const known = new Set(Array.isArray(mark?.members) ? mark.members : []);
    const joined = members.some((id) => !known.has(id));
    const since = mark && mark.scope === scope && now - mark.at < WHOLE_AFTER_MS && !joined ? mark.seq : 0;
    const feed = await api.changes(list, since);
    const last = new Map(feed.changes.map((c) => [c.id, c]));
    const byRecord = new Map(members.map((id) => [tag(offersLabel(id)), id]));
    const written = [...last.values()].filter((c) => !c.deleted && c.writer !== desk.id && byRecord.get(c.id) === c.writer);
    const offers: HeldOffers[] = [];
    for (const record of written.length > 0 ? await api.readRecords(written.map((c) => c.id)) : []) {
      // Nothing this large is a record of offers: refused before it is opened.
      if (!record.body || record.body.length > MAX_OFFERS_BODY) continue;
      try {
        const held = asOffersRecord(openRecord(this.deps.keyFor(record.generation), record.body, 'record', record.id, record.generation));
        // Only a computer of the keyring, under its own record; named as this computer's keyring names it when it gave no name.
        if (held && byRecord.get(record.id) === held.machine.id) offers.push({ ...held, machine: { id: held.machine.id, name: held.machine.name || machines.get(held.machine.id)!.name } });
      } catch {
        // Not something this account's key opens: left out.
      }
    }
    const gone = [...last.values()].filter((c) => c.deleted && byRecord.has(c.id)).map((c) => byRecord.get(c.id)!);
    await this.deps.store.apply({ offers, gone, members, whole: since === 0, mark: { seq: feed.next, at: now, scope, members } });
  }

  private async write(api: HeldApi, key: ReadyKey, desk: Machine, scope: string, list: string, tag: (label: string) => string): Promise<void> {
    const { source } = this.deps;
    const epoch = this.epoch;
    const [settings, agents] = await Promise.all([source.settings(), this.agents ?? source.agents()]);
    this.agents = agents;
    const offers = offersOf(source, settings, agents, this.deps.keptOff());
    const json = JSON.stringify(offers);
    if (this.sent?.scope === scope && this.sent.epoch === epoch && this.sent.json === json) return;
    const id = tag(offersLabel(desk.id));
    const made = this.deps.now?.() ?? Date.now();
    const body = sealRecord(key.adk, 'record', id, key.generation, offersRecordOf(desk, made, offers));
    if (body.length > MAX_OFFERS_BODY) {
      console.error(`[kestrel] what this computer offers is too large to hold on Kestrel Connect (${body.length} characters); devices will ask it`);
      return;
    }
    await api.putRecord(id, { generation: key.generation, session: null, project: null, list, body });
    this.sent = { scope, epoch, json };
    this.writes++;
  }

  /** Signed out, or another account: the other computers' records go. */
  async forget(): Promise<void> {
    await this.running?.catch(() => undefined);
    this.sent = null;
    await this.deps.store.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unwatch();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}
