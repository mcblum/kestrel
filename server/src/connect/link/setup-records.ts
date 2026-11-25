// Set-up records on Kestrel Connect (docs/designs/onboarding.md, section 3): each computer of the
// account keeps one sealed record of its configuration, with no secret in it, at
// `tag("setup|<machine id>")`, through the same held-record routes and sealing as held conversations
// (`sealRecord`, `openRecord`; no change to either). It is rewritten when Kestrel connects and when
// Settings → Connections is opened, never on a timer, and only when what it holds changed. Other
// computers' records are read by their ids, from the account's device list.
//
// With no account there is no key and no service: nothing here reads the machine or opens a socket.
import { createHash } from 'node:crypto';
import { Refused } from '../../refused.ts';
import { asSetupRecord, setupLabel, type SetupRecord } from '../../shared/setup-record.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { AccountDevice, HeldApi } from './held-api.ts';

export interface SetupRecordsDeps {
  /** The service, when the link is up; null otherwise. */
  api(): HeldApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  /** This computer's device, once registered on the signed-in account. */
  desk(): { id: string; name: string } | null;
  /** Reads this machine and splits it into its record (setup-inventory/). Called only with an account. */
  inventory(desk: { id: string; name: string }): Promise<SetupRecord>;
}

const NOT_READY = 'Set up this computer needs Kestrel Connect on, signed in, connected, and this computer let into your account.';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The record without when it was read: two reads of an unchanged machine hash the same. */
const hashOf = (record: SetupRecord) => createHash('sha256').update(JSON.stringify({ ...record, readAt: 0 })).digest('base64url');

export class SetupRecords {
  private lastHash: string | null = null;
  private writing: Promise<SetupRecord> | null = null;

  constructor(private readonly deps: SetupRecordsDeps) {}

  private ready(): { api: HeldApi; key: ReadyKey; desk: { id: string; name: string } } {
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    if (!api || !key || !desk) throw new Refused(NOT_READY);
    return { api, key, desk };
  }

  /** Reads this machine and writes its record when it changed; answers the record. One at a time. */
  write(): Promise<SetupRecord> {
    this.writing ??= this.writeNow().finally(() => (this.writing = null));
    return this.writing;
  }

  private async writeNow(): Promise<SetupRecord> {
    const { api, key, desk } = this.ready();
    const record = await this.deps.inventory(desk);
    const hash = `${key.generation}|${hashOf(record)}`;
    if (hash === this.lastHash) return record;
    const id = tagOf(key.idKey, setupLabel(desk.id));
    await api.putRecord(id, { generation: key.generation, session: null, project: null, body: sealRecord(key.adk, 'record', id, key.generation, record) });
    this.lastHash = hash;
    return record;
  }

  /** Writes in the background, saying only in the log when it could not: Kestrel connected, or Connections was opened. */
  refresh(): void {
    if (!this.deps.api() || !this.deps.key() || !this.deps.desk()) return;
    void this.write().catch((error: unknown) => console.error(`[kestrel] could not write this computer's set-up record: ${message(error)}`));
  }

  /** This machine's record, read now, and every other computer's record the account holds. */
  async read(devices: readonly AccountDevice[]): Promise<{ here: SetupRecord; others: SetupRecord[] }> {
    const { api, key, desk } = this.ready();
    const here = await this.write();
    const ids = new Map(devices.filter((d) => d.kind === 'desktop' && d.id !== desk.id).map((d) => [tagOf(key.idKey, setupLabel(d.id)), d.id]));
    if (ids.size === 0) return { here, others: [] };
    const read = await api.readRecords([...ids.keys()]);
    const others = read.flatMap((r) => {
      try {
        const record = asSetupRecord(openRecord(this.deps.keyFor(r.generation), r.body ?? '', 'record', r.id, r.generation));
        // A record says which machine it is; it must be the one whose tag it is under.
        return record && record.machine.id === ids.get(r.id) ? [record] : [];
      } catch {
        return [];
      }
    });
    return { here, others };
  }

  /** Kestrel connected: written once a run (a reconnect does not read the machine again), and again after `reset`. */
  refreshOnce(): void {
    if (this.lastHash === null) this.refresh();
  }

  /** Signed out, switched off, or a new account: the next write is made in full. */
  reset(): void {
    this.lastHash = null;
  }
}
