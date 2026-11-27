// Filling the replica (docs/designs/account-sessions.md, sections 5.3, 9.1 and 18): while Kestrel
// Connect is on, signed in, connected and this computer holds the account key, it reads the change feed
// of the account's session heads from where it last stood, opens the heads that were written, and
// stores the lot in the replica (account-replica.ts) in one transaction. After each pass, every kept
// conversation that is behind its head is brought up to it in the background (`prefetch`), so opening a
// session that runs on another computer is a local read (Matt, 2026-11-25: "the sessions on the other
// machine still show instantly because they're all being pulled from the server").
//
// - Nothing is polled. A pass runs when the link comes up, when the service says `changed`, and when
//   the account's devices change. With no account there is no key and no service: `kick` does nothing.
// - Only a machine in the keyring this computer accepted may say it runs a session, and a head counts
//   only under the record id its session makes. Opening it at all proves its writer held the key.
// - The service keeps a delete in the feed for 30 days. Having not read it for `WHOLE_AFTER_MS`, or
//   under another key or device, this computer reads every head again and drops what is not there.
import type { AccountReplica } from '../../account-replica.ts';
import type { ChatMessage } from '../../model.ts';
import { asAccountChunk, asHeadRecord, conversationStamp, headLabel, HEADS_LIST, type AccountChunk, type AccountHead, type HeadRecord, type Machine } from '../../shared/machines.ts';
import { openRecord, tagOf } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { HeldApi } from './held-api.ts';

/** Shorter than the service keeps deletes (30 days), so one is never missed. */
export const WHOLE_AFTER_MS = 25 * 24 * 60 * 60 * 1000;

/**
 * How many conversations are read from the service at once in the background. Two: a computer with hundreds of
 * sessions (a first sign-in, a long time away) is brought up to date as a trickle, newest activity first, so the
 * sessions a person is likely to open are there first and the link is never filled with one burst. Each read
 * asks only for the chunks the head's stamp says may have changed (`fetch`).
 */
export const PREFETCH_AT_ONCE = 2;

/** How long opening a conversation waits for the service when the kept copy is behind: then what is kept is shown, and the read carries on. */
export const OPEN_WAIT_MS = 1_500;

export interface ReplicaSyncDeps {
  replica: AccountReplica;
  /** The service, when the link is up; null otherwise. */
  api(): HeldApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  /** This computer's device, once registered on the signed-in account. */
  desk(): { id: string } | null;
  /** The account's other computers that are in the keyring this computer accepted. */
  machines(): Machine[];
  now?(): number;
  /** Run before each read of the heads: what was seen is read first, so a session arrives already seen (seen-sync.ts). */
  before?(): Promise<void>;
}

/** A remote conversation as it can be shown now. `current` is false when the stored copy may be behind. */
export interface RemoteConversation {
  head: AccountHead;
  messages: ChatMessage[];
  current: boolean;
  /** When this computer last read it from the account, or null when it never has. */
  readAt: number | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ReplicaSync {
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly fetching = new Map<string, Promise<boolean>>();
  private prefetching: Promise<void> | null = null;
  private prefetchAgain = false;
  /** A pass has read the heads since this computer started or signed in: the replica says which sessions exist. */
  private current = false;

  constructor(private readonly deps: ReplicaSyncDeps) {}

  /** Whether the heads have been read in this run, so what is not among them is really gone. */
  headsRead(): boolean {
    return this.current;
  }

  /** Reads the feed now: the link came up, the service said something changed, the account's devices changed. */
  kick(): void {
    if (this.closed) return;
    void this.run();
  }

  /** One pass, one at a time; a pass asked for during one runs after it. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      // Not tried again on a timer: the next notice, or the link coming back, reads from the same place.
      .catch((error: unknown) => console.error(`[kestrel] could not read the account's other computers: ${message(error)}`))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        } else this.prefetch();
      });
    return this.running;
  }

  /**
   * Brings every kept conversation that is behind its head up to it, newest activity first, `PREFETCH_AT_ONCE` at
   * a time; one round at a time, and one asked for during it runs after it. Started after each pass, so only by
   * the feed: nothing is polled. A conversation whose stamp matches is not read again.
   */
  prefetch(): void {
    if (this.closed) return;
    if (this.prefetching) {
      this.prefetchAgain = true;
      return;
    }
    this.prefetching = this.prefetchRound()
      .catch((error: unknown) => console.error(`[kestrel] could not read the account's conversations: ${message(error)}`))
      .finally(() => {
        this.prefetching = null;
        if (this.prefetchAgain) {
          this.prefetchAgain = false;
          this.prefetch();
        }
      });
  }

  /** Resolves when the background reading under way (and any asked for meanwhile) is done. For tests and the dev seed. */
  async settled(): Promise<void> {
    while (this.running || this.prefetching) await (this.running ?? this.prefetching);
  }

  private async prefetchRound(): Promise<void> {
    if (!this.deps.api() || !this.deps.key()) return;
    const [heads, marks] = await Promise.all([this.deps.replica.heads(), this.deps.replica.detailMarks()]);
    // An archived session's conversation is no longer held: the copy kept here stays as it is.
    const behind = heads.filter((h) => !h.archived && marks.get(h.id)?.stamp !== conversationStamp(h)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const worker = async () => {
      for (let head = behind.shift(); head; head = behind.shift()) {
        // The link went down or the person signed out: the next pass starts again where the copies stand.
        if (this.closed || !this.deps.api() || !this.deps.key()) return;
        await this.fetchOnce(head).catch((error: unknown) => console.error(`[kestrel] could not read a conversation from the account: ${message(error)}`));
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_AT_ONCE }, worker));
  }

  /** One read of a conversation's changed chunks at a time, shared by opening it and the background. */
  private fetchOnce(head: AccountHead): Promise<boolean> {
    const pending = this.fetching.get(head.id) ?? this.fetch(head).finally(() => this.fetching.delete(head.id));
    this.fetching.set(head.id, pending);
    return pending;
  }

  private async pass(): Promise<void> {
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    if (!api || !key || !desk) return;
    await this.deps.before?.().catch((error: unknown) => console.error(`[kestrel] could not read what was seen on the account: ${message(error)}`));
    const now = this.deps.now?.() ?? Date.now();
    const tag = (label: string) => tagOf(key.idKey, label);
    const machines = new Map(this.deps.machines().filter((m) => m.id !== desk.id).map((m) => [m.id, m]));
    const scope = `${desk.id}|${tag('scope')}`;
    const mark = await this.deps.replica.feedMark();
    // A machine let in since the last reading wrote its heads before the number kept: read them all.
    const known = new Set(Array.isArray(mark?.members) ? mark.members : []);
    const joined = [...machines.keys()].some((id) => !known.has(id));
    const since = mark && mark.scope === scope && now - mark.at < WHOLE_AFTER_MS && !joined ? mark.seq : 0;

    const feed = await api.changes(tag(HEADS_LIST), since);
    // The last word on each record: a head written and then deleted is deleted.
    const last = new Map(feed.changes.map((c) => [c.id, c]));
    // This computer's own heads are in the feed too: never read back.
    const written = [...last.values()].filter((c) => !c.deleted && c.writer !== desk.id).map((c) => c.id);
    const heads: HeadRecord[] = [];
    for (const record of written.length > 0 ? await api.readRecords(written) : []) {
      if (!record.body) continue;
      try {
        const head = asHeadRecord(openRecord(this.deps.keyFor(record.generation), record.body, 'record', record.id, record.generation));
        // Only a machine of the keyring may say it runs a session, and only under that session's own record.
        if (head && machines.has(head.machine.id) && record.id === tag(headLabel(head.head.id))) heads.push(head);
      } catch {
        // Not something this account's key opens: left out.
      }
    }
    const deleted = new Set([...last.values()].filter((c) => c.deleted).map((c) => c.id));
    const gone = deleted.size > 0 ? (await this.deps.replica.heads()).filter((h) => deleted.has(tag(headLabel(h.id)))).map((h) => h.id) : [];
    await this.deps.replica.apply({ heads, gone, members: [...machines.keys()], whole: since === 0, mark: { seq: feed.next, at: now, scope, members: [...machines.keys()] } });
    this.current = true;
  }

  /**
   * A remote session's conversation as this computer keeps it. Usually current already (`prefetch`); when it is
   * behind its head, its changed chunks are read from the service, waited for at most `waitMs`, and what is kept
   * is answered either way (the read carries on). With no link, what is stored is answered as it is.
   */
  async conversation(sessionId: string, waitMs = OPEN_WAIT_MS): Promise<RemoteConversation | null> {
    const head = await this.deps.replica.head(sessionId);
    if (!head) return null;
    let current = (await this.deps.replica.detailMark(sessionId))?.stamp === conversationStamp(head);
    if (!current && this.deps.api() && this.deps.key()) {
      const read = this.fetchOnce(head).catch((error: unknown) => {
        console.error(`[kestrel] could not read a conversation from the account: ${message(error)}`);
        return false;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), waitMs)));
      current = await Promise.race([read, late]);
      clearTimeout(timer);
    }
    const now = this.deps.now?.() ?? Date.now();
    // Current against a feed this computer is reading now: as fresh as the account has it.
    if (current && this.deps.api() && this.deps.key()) await this.deps.replica.markRead(sessionId, now);
    const readAt = (await this.deps.replica.detailMark(sessionId))?.readAt ?? null;
    return { head, messages: await this.deps.replica.messages(sessionId), current, readAt };
  }

  /** Reads the chunks that may have changed since the stored ones were read; false when the service cannot be asked. */
  private async fetch(head: AccountHead): Promise<boolean> {
    // Archived there: its conversation is no longer held, and the copy kept here is not cut down to nothing.
    if (head.archived) return false;
    const api = this.deps.api();
    const key = this.deps.key();
    if (!api || !key) return false;
    const mark = await this.deps.replica.detailMark(head.id);
    // Messages are added at the end, and the last stored chunk may have been part full or still streaming.
    const from = mark && mark.chunks <= head.chunks ? Math.max(0, mark.chunks - 1) : 0;
    const places = new Map<string, number>();
    for (let n = from; n < head.chunks; n++) places.set(tagOf(key.idKey, `chunk|${head.runsOn}|${head.id}|${n}`), n);
    const read = places.size > 0 ? await api.readRecords([...places.keys()]) : [];
    const chunks: AccountChunk[] = [];
    for (const record of read) {
      const n = places.get(record.id);
      if (n === undefined || !record.body) continue;
      try {
        const chunk = asAccountChunk(openRecord(this.deps.keyFor(record.generation), record.body, 'record', record.id, record.generation), head.id, n);
        if (chunk) chunks.push(chunk);
      } catch {
        // Left out: the copy stays behind and is asked for again.
      }
    }
    const complete = chunks.length === places.size;
    // A stamp is kept only for a whole read, so a part read is tried again when the conversation is next opened.
    await this.deps.replica.putChunks(head.id, chunks, head.chunks, complete ? conversationStamp(head) : '', this.deps.now?.() ?? Date.now());
    return complete;
  }

  /** Signed out: nothing of the account stays. */
  async forget(): Promise<void> {
    await this.running?.catch(() => undefined);
    await this.prefetching;
    this.current = false;
    await this.deps.replica.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.running?.catch(() => undefined);
    await this.prefetching;
  }
}
