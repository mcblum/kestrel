// The replica: this computer's copy of what the account's other machines say about their sessions
// (docs/designs/account-sessions.md, section 9.1). It is local data behind `Persistence`, in tables of
// its own, written only by the sync (connect/link/replica-sync.ts) and read by `Workspace.state()` and
// by whoever opens a remote conversation. A batch is one transaction and one `changed()`.
//
// Nothing here is a session of this computer: these rows are never in `sessions`, so the runtime, the
// bring-up code and every adapter never see them.
import type { ChatMessage } from './model.ts';
import type { Persistence } from './persistence/types.ts';
import type { AccountChunk, AccountHead, HeadRecord, Machine } from './shared/machines.ts';

const MACHINE = 'machine|';
const DETAIL = 'detail|';
const FEED = 'feed|heads';

/** What is kept of a machine: who it is. */
export type MachineCard = Machine;

/** Where the reading of the change feed stands: the number read up to, when, and for which key and device. */
export interface FeedMark {
  seq: number;
  at: number;
  scope: string;
  /** The machines whose heads were being read. One that joins later has heads from before this number. */
  members: string[];
}

/** One reading of the change feed, to be stored whole or not at all. */
export interface ReplicaBatch {
  heads: readonly HeadRecord[];
  /** Sessions whose heads were deleted. */
  gone: readonly string[];
  /** The account's other machines now: any other machine's rows are dropped. */
  members: readonly string[];
  /** The heads given are all there are. */
  whole: boolean;
  mark: FeedMark | null;
}

/** What is kept about a conversation's stored chunks: the head's stamp they were fetched at, and how many. */
export interface DetailMark {
  stamp: string;
  chunks: number;
  /** When this computer last read the conversation whole from the account (ms), shown as "as of" while its machine cannot be reached. */
  readAt?: number;
}

function parsed<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** The machine cards among the replica's records, by name. */
export function machineCards(records: readonly { key: string; value: string }[]): MachineCard[] {
  return records
    .filter((r) => r.key.startsWith(MACHINE))
    .flatMap((r) => parsed<MachineCard>(r.value) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class AccountReplica {
  constructor(
    private readonly db: Persistence,
    private readonly changed: () => void,
  ) {}

  /** The other machines this computer holds sessions of. */
  async machines(): Promise<MachineCard[]> {
    return machineCards(await this.db.listAccountRecords());
  }

  /** Every head held. */
  heads(): Promise<AccountHead[]> {
    return this.db.listAccountSessions();
  }

  async head(sessionId: string): Promise<AccountHead | null> {
    return (await this.db.listAccountSessions()).find((h) => h.id === sessionId) ?? null;
  }

  /** Where this computer's reading of the change feed stands, or null when it has not read it. */
  async feedMark(): Promise<FeedMark | null> {
    const record = (await this.db.listAccountRecords()).find((r) => r.key === FEED);
    return record ? parsed<FeedMark>(record.value) : null;
  }

  /**
   * Takes what was read of the change feed: heads written, sessions deleted, and where the feed now
   * stands. `whole` says the heads given are every head there is, so any other is dropped. Every
   * machine not in `members` (removed from the account) is dropped with its sessions. One transaction;
   * the workspace is told once, and only when something it draws differs. Answers whether anything did.
   */
  async apply(batch: ReplicaBatch): Promise<boolean> {
    const differs = await this.db.transaction(async (tx) => {
      const [stored, records] = await Promise.all([tx.listAccountSessions(), tx.listAccountRecords()]);
      const before = new Map(stored.map((h) => [h.id, h]));
      const cards = new Map(machineCards(records).map((c) => [c.id, c]));
      const keep = new Set(batch.members);
      const puts: AccountHead[] = [];
      const given = new Set<string>();
      let any = false;

      for (const { machine, head } of batch.heads) {
        if (!keep.has(machine.id)) continue;
        const was = before.get(head.id);
        // A session belongs to the machine that first said it runs it: another machine never takes it over.
        if (was && was.runsOn !== head.runsOn) continue;
        given.add(head.id);
        if (!was || JSON.stringify(was) !== JSON.stringify(head)) puts.push(head);
        const card = cards.get(machine.id);
        if (!card || card.name !== machine.name) {
          cards.set(machine.id, machine);
          await tx.putAccountRecord(MACHINE + machine.id, JSON.stringify(machine satisfies MachineCard));
          any = true;
        }
      }
      for (const card of cards.values()) {
        if (keep.has(card.id)) continue;
        await tx.deleteAccountRecord(MACHINE + card.id);
        any = true;
      }
      const gone = new Set(batch.gone.filter((id) => before.has(id) && !given.has(id)));
      for (const was of stored) if (!keep.has(was.runsOn) || (batch.whole && !given.has(was.id))) gone.add(was.id);

      if (puts.length > 0) await tx.putAccountSessions(puts);
      if (gone.size > 0) {
        await tx.deleteAccountSessions([...gone]);
        for (const id of gone) await tx.deleteAccountRecord(DETAIL + id);
      }
      if (batch.mark) await tx.putAccountRecord(FEED, JSON.stringify(batch.mark));
      return any || puts.length + gone.size > 0;
    });
    if (differs) this.changed();
    return differs;
  }

  /**
   * A session this computer just started on another computer (remote-start.ts): its head as the start's answer
   * says, until that computer's own head arrives through the feed and replaces it. Never over a head already held.
   */
  async started(machine: MachineCard, head: AccountHead): Promise<void> {
    const differs = await this.db.transaction(async (tx) => {
      const [stored, records] = await Promise.all([tx.listAccountSessions(), tx.listAccountRecords()]);
      if (stored.some((h) => h.id === head.id)) return false;
      if (!machineCards(records).some((c) => c.id === machine.id)) await tx.putAccountRecord(MACHINE + machine.id, JSON.stringify({ id: machine.id, name: machine.name } satisfies MachineCard));
      await tx.putAccountSessions([head]);
      return true;
    });
    if (differs) this.changed();
  }

  /** Signed out: nothing of the account stays. */
  async clear(): Promise<void> {
    await this.apply({ heads: [], gone: [], members: [], whole: true, mark: null });
    await this.db.deleteAccountRecord(FEED);
  }

  async detailMark(sessionId: string): Promise<DetailMark | null> {
    const record = (await this.db.listAccountRecords()).find((r) => r.key === DETAIL + sessionId);
    return record ? parsed<DetailMark>(record.value) : null;
  }

  /** Every conversation's detail mark, by session id: one read, for deciding which are behind. */
  async detailMarks(): Promise<Map<string, DetailMark>> {
    const marks = new Map<string, DetailMark>();
    for (const r of await this.db.listAccountRecords()) {
      const mark = r.key.startsWith(DETAIL) ? parsed<DetailMark>(r.value) : null;
      if (mark) marks.set(r.key.slice(DETAIL.length), mark);
    }
    return marks;
  }

  /**
   * Stores chunks fetched for a conversation that has `total` of them at the head's `stamp`; chunks
   * past the end are dropped. An empty stamp says the read was not whole: every chunk is read again next time. Nothing is kept for a session the replica has no head of.
   */
  async putChunks(sessionId: string, chunks: readonly AccountChunk[], total: number, stamp: string, at?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!(await tx.listAccountSessions()).some((h) => h.id === sessionId)) return;
      const before = (await tx.listAccountRecords()).find((r) => r.key === DETAIL + sessionId);
      const readAt = stamp && at !== undefined ? at : (before && parsed<DetailMark>(before.value)?.readAt);
      await tx.putAccountDetails(sessionId, chunks);
      await tx.deleteAccountDetails(sessionId, total);
      await tx.putAccountRecord(DETAIL + sessionId, JSON.stringify({ stamp, chunks: stamp ? total : 0, ...(readAt !== undefined ? { readAt } : {}) } satisfies DetailMark));
    });
  }

  /** The kept copy was found current against the account's feed at `at`: that is when it was last read. */
  async markRead(sessionId: string, at: number): Promise<void> {
    const mark = await this.detailMark(sessionId);
    if (!mark?.stamp || (mark.readAt ?? 0) >= at) return;
    await this.db.putAccountRecord(DETAIL + sessionId, JSON.stringify({ ...mark, readAt: at } satisfies DetailMark));
  }

  /** The stored messages of chunks `from` up to `to` (all of them by default), in order. */
  async messages(sessionId: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<ChatMessage[]> {
    return (await this.db.listAccountDetails(sessionId, from, to)).flatMap((c) => c.messages);
  }
}
