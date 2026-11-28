// This computer's copy of what the account's other computers offer for a new session (shared/machine-offers.ts):
// local data behind `Persistence`, kept as account records of their own, written by the offers sync
// (connect/link/offers-sync.ts), and pushed whole to every window's `machineOffers` slice. One other write: a worker
// node's answer to a change of one of its settings (`takeNodeAnswer`), which is what its record will say once the node
// writes it; the next reading of the feed replaces it with the node's own. It is on disk, so a
// window has it at once at start-up, before the link is up.
import type { Persistence } from './persistence/types.ts';
import type { HeldOffers, MachineOffersView } from './shared/machine-offers.ts';
import type { NodePublished } from './shared/node-facts.ts';

const OFFERS = 'aoffers|';
const FEED = 'feed|offers';

/** Where the reading of the offers feed stands, as the projects' mark does. */
export interface OffersFeedMark {
  seq: number;
  at: number;
  scope: string;
  members: string[];
}

export interface OffersBatch {
  /** The records read, by machine id. */
  offers: readonly HeldOffers[];
  /** Machines whose record the feed says was deleted. */
  gone: readonly string[];
  /** The account's other computers now: any other computer's record is dropped. */
  members: readonly string[];
  /** The records given are every one there is. */
  whole: boolean;
  mark: OffersFeedMark | null;
}

function parsed<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class AccountOffers {
  private readonly listeners = new Set<(view: MachineOffersView) => void>();

  constructor(private readonly db: Persistence) {}

  async view(): Promise<MachineOffersView> {
    const records = (await this.db.listAccountRecords()).filter((r) => r.key.startsWith(OFFERS));
    return Object.fromEntries(records.flatMap((r) => ((held) => (held ? [[held.machine.id, held] as const] : []))(parsed<HeldOffers>(r.value))));
  }

  async feedMark(): Promise<OffersFeedMark | null> {
    const record = (await this.db.listAccountRecords()).find((r) => r.key === FEED);
    return record ? parsed<OffersFeedMark>(record.value) : null;
  }

  /** Told with the whole view each time it changes. Returns the undo. */
  onChange(listener: (view: MachineOffersView) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Takes one reading of the feed, in one transaction; tells the listeners only when something differs. */
  async apply(batch: OffersBatch): Promise<boolean> {
    const differs = await this.db.transaction(async (tx) => {
      const before = new Map((await tx.listAccountRecords()).filter((r) => r.key.startsWith(OFFERS)).map((r) => [r.key.slice(OFFERS.length), r.value]));
      const keep = new Set(batch.members);
      const given = new Set<string>();
      let any = false;
      for (const held of batch.offers) {
        if (!keep.has(held.machine.id)) continue;
        given.add(held.machine.id);
        const json = JSON.stringify(held);
        if (before.get(held.machine.id) === json) continue;
        await tx.putAccountRecord(OFFERS + held.machine.id, json);
        any = true;
      }
      const gone = new Set(batch.gone.filter((id) => before.has(id) && !given.has(id)));
      for (const id of before.keys()) if (!keep.has(id) || (batch.whole && !given.has(id))) gone.add(id);
      for (const id of gone) await tx.deleteAccountRecord(OFFERS + id);
      if (batch.mark) await tx.putAccountRecord(FEED, JSON.stringify(batch.mark));
      return any || gone.size > 0;
    });
    if (differs) {
      const view = await this.view();
      for (const listener of this.listeners) listener(view);
    }
    return differs;
  }

  /**
   * A worker node answered a change of its settings with what it publishes now: held in its record at once, so its page
   * shows the new value without waiting for the node's record to come round the feed. Nothing when no record is held.
   */
  async takeNodeAnswer(machineId: string, node: NodePublished): Promise<boolean> {
    const held = (await this.view())[machineId];
    if (!held) return false;
    const next: HeldOffers = { ...held, offers: { ...held.offers, node } };
    if (JSON.stringify(next) === JSON.stringify(held)) return false;
    await this.db.putAccountRecord(OFFERS + machineId, JSON.stringify(next));
    const view = await this.view();
    for (const listener of this.listeners) listener(view);
    return true;
  }

  /** Signed out: nothing of the account stays. */
  async clear(): Promise<void> {
    await this.apply({ offers: [], gone: [], members: [], whole: true, mark: null });
    await this.db.deleteAccountRecord(FEED);
  }
}
