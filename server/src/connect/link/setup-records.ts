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
import { asSetupFileRecord, FILE_RECORD_MAX_BYTES, setupFilesLabel, type SetupFileRecord } from '../../shared/setup-files.ts';
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
  /** The file records of the read `inventory` just made (18.3); none when this copy does not carry files. */
  fileRecords?(): readonly SetupFileRecord[];
}

const NOT_READY = 'Set up this computer needs Kestrel Connect on, signed in, connected, and this computer let into your account.';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The record without when it was read: two reads of an unchanged machine hash the same. */
const hashOf = (record: SetupRecord) => createHash('sha256').update(JSON.stringify({ ...record, readAt: 0 })).digest('base64url');

export class SetupRecords {
  private lastHash: string | null = null;
  /** Each file record's hash as last written, by line: one is written only when it changed. */
  private fileHashes = new Map<string, string>();
  /** The other computers as last read, by name: Bring over names them by name. */
  private othersByName = new Map<string, string>();
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
    await this.writeFiles(api, key, desk.id);
    return record;
  }

  /** The file records, each written only when it changed; one too large to hold is left out and logged. */
  private async writeFiles(api: HeldApi, key: ReadyKey, deskId: string): Promise<void> {
    for (const files of this.deps.fileRecords?.() ?? []) {
      const text = JSON.stringify(files);
      const hash = `${key.generation}|${createHash('sha256').update(text).digest('base64url')}`;
      if (this.fileHashes.get(files.line) === hash) continue;
      if (Buffer.byteLength(text) > FILE_RECORD_MAX_BYTES) {
        console.error(`[kestrel] ${files.line} is too large to keep for Set up this computer; it is left out.`);
        continue;
      }
      const id = tagOf(key.idKey, setupFilesLabel(deskId, files.line));
      await api.putRecord(id, { generation: key.generation, session: null, project: null, body: sealRecord(key.adk, 'record', id, key.generation, files) });
      this.fileHashes.set(files.line, hash);
    }
  }

  /** A line's files as the computers named hold them, the most recently read first; null when none does. */
  async files(line: string, from: readonly string[]): Promise<SetupFileRecord | null> {
    const { api, key } = this.ready();
    const ids = new Map(from.flatMap((name) => {
      const machine = this.othersByName.get(name);
      return machine ? [[tagOf(key.idKey, setupFilesLabel(machine, line)), machine] as const] : [];
    }));
    if (ids.size === 0) return null;
    const records = (await api.readRecords([...ids.keys()])).flatMap((r) => {
      try {
        const files = asSetupFileRecord(openRecord(this.deps.keyFor(r.generation), r.body ?? '', 'record', r.id, r.generation));
        // A record says which machine and line it is; it must be the one whose tag it is under.
        return files && files.machine === ids.get(r.id) && files.line === line ? [files] : [];
      } catch {
        return [];
      }
    });
    const order = [...this.othersByName.keys()]; // the most recently read computer first
    return records.sort((a, b) => order.indexOf(this.nameOf(a.machine)) - order.indexOf(this.nameOf(b.machine)))[0] ?? null;
  }

  private nameOf(machine: string): string {
    for (const [name, id] of this.othersByName) if (id === machine) return name;
    return '';
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
    this.othersByName = new Map([...others].sort((a, b) => b.readAt - a.readAt).map((r) => [r.machine.name, r.machine.id]));
    return { here, others };
  }

  /** Kestrel connected: written once a run (a reconnect does not read the machine again), and again after `reset`. */
  refreshOnce(): void {
    if (this.lastHash === null) this.refresh();
  }

  /** Signed out, switched off, or a new account: the next write is made in full. */
  reset(): void {
    this.lastHash = null;
    this.fileHashes = new Map();
  }
}
