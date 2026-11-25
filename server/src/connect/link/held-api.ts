// The service's API for the account data key, held records and waiting messages, typed (design doc
// kestrel-connect.md, "Phase 3 as built, part C, and phase 5 as built": the route table). Every
// sealed string here is opaque to the service; nothing is opened in this file.
import type { ServiceMethod } from './service.ts';

/** One call, with the token and this computer's device id already bound (connect.ts). */
export type ServiceCall = (method: ServiceMethod, path: string, body?: unknown) => Promise<unknown>;

export interface KeysAnswer {
  generation: number | null;
  keyring: { version: number; text: string } | null;
  copy: { generation: number; wrapped: string } | null;
  recovery: { generation: number; wrapped: string } | null;
  previous: { generation: number; sealed: string }[];
  rotationDue: { removed: { name: string; removedAt: string }[] } | null;
  /** The account's devices with a copy of the current generation (step 8b). */
  holders: string[];
}

export interface AccountDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'phone';
}

export interface HeldRecord {
  id: string;
  generation: number;
  session: string | null;
  project: string | null;
  bytes: number;
  body?: string;
}

export interface WaitingMessage {
  id: string;
  from: string | null;
  to: string;
  generation: number;
  body: string;
}

export interface HeldUsage {
  bytes: number;
  limit: number;
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const q = encodeURIComponent;

function asRecord(raw: unknown): HeldRecord | null {
  const r = obj(raw);
  const id = str(r.id);
  const generation = num(r.generation);
  if (!id || generation === null) return null;
  return { id, generation, session: str(r.session), project: str(r.project), bytes: num(r.bytes) ?? 0, ...(typeof r.body === 'string' ? { body: r.body } : {}) };
}

export class HeldApi {
  constructor(private readonly call: ServiceCall) {}

  async keys(): Promise<KeysAnswer> {
    const a = obj(await this.call('GET', '/keys'));
    const keyring = obj(a.keyring);
    const copy = obj(a.copy);
    const recovery = obj(a.recovery);
    const due = a.rotationDue ? obj(a.rotationDue) : null;
    return {
      generation: num(a.generation),
      keyring: num(keyring.version) !== null && str(keyring.text) ? { version: keyring.version as number, text: keyring.text as string } : null,
      copy: num(copy.generation) !== null && str(copy.wrapped) ? { generation: copy.generation as number, wrapped: copy.wrapped as string } : null,
      recovery: num(recovery.generation) !== null && str(recovery.wrapped) ? { generation: recovery.generation as number, wrapped: recovery.wrapped as string } : null,
      previous: list(a.previous).flatMap((p) => {
        const r = obj(p);
        return num(r.generation) !== null && str(r.sealed) ? [{ generation: r.generation as number, sealed: r.sealed as string }] : [];
      }),
      rotationDue: due ? { removed: list(due.removed).map((d) => ({ name: str(obj(d).name) ?? 'a device', removedAt: str(obj(d).removedAt) ?? '' })) } : null,
      holders: list(a.holders).flatMap((h) => (str(h) ? [h as string] : [])),
    };
  }

  /** A keyring without a device that holds no copy (step 8b); the new version. */
  async withdraw(body: { generation: number; keyringVersion: number; keyring: string; deviceId: string }): Promise<number> {
    return num(obj(await this.call('POST', '/keys/withdraw', body)).keyringVersion) ?? body.keyringVersion + 1;
  }

  /** Deletes this device's own copy of the key (it discarded a key it was offered). */
  async deleteCopy(): Promise<void> {
    await this.call('DELETE', '/keys/copy');
  }

  async createKeys(body: { keyring: string; recovery: string; wrapped: string }): Promise<void> {
    await this.call('POST', '/keys', body);
  }

  async grant(body: { generation: number; keyringVersion: number; keyring: string; deviceId: string; wrapped: string }): Promise<number> {
    return num(obj(await this.call('POST', '/keys/grant', body)).keyringVersion) ?? body.keyringVersion + 1;
  }

  async rotate(body: { from: number; keyring: string; recovery: string; previous: string; copies: { deviceId: string; wrapped: string }[] }): Promise<void> {
    await this.call('POST', '/keys/rotate', body);
  }

  async dropPrevious(): Promise<void> {
    await this.call('DELETE', '/keys/previous');
  }

  async devices(): Promise<AccountDevice[]> {
    return list(obj(await this.call('GET', '/devices')).devices).flatMap((d) => {
      const r = obj(d);
      return str(r.id) && str(r.name) ? [{ id: r.id as string, name: r.name as string, kind: r.kind === 'phone' ? 'phone' : 'desktop' } as AccountDevice] : [];
    });
  }

  async putRecord(id: string, body: { generation: number; session: string | null; project: string | null; body: string }): Promise<HeldUsage | null> {
    const usage = obj(obj(await this.call('PUT', `/held/records/${q(id)}`, body)).usage);
    return num(usage.bytes) !== null && num(usage.limit) !== null ? { bytes: usage.bytes as number, limit: usage.limit as number } : null;
  }

  async recordsBelow(generation: number, limit = 50): Promise<HeldRecord[]> {
    return list(obj(await this.call('GET', `/held/records?below=${generation}&limit=${limit}`)).records).flatMap((r) => asRecord(r) ?? []);
  }

  /** Records by id, with their bodies (at most 100 at a time); an id the service does not hold is left out. */
  async readRecords(ids: readonly string[]): Promise<HeldRecord[]> {
    const out: HeldRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const answer = obj(await this.call('POST', '/held/records/read', { ids: ids.slice(i, i + 100) }));
      out.push(...list(answer.records).flatMap((r) => asRecord(r) ?? []));
    }
    return out;
  }

  async deleteRecord(id: string): Promise<void> {
    await this.call('DELETE', `/held/records/${q(id)}`);
  }

  async deleteRecords(by: { session: string } | { project: string }): Promise<void> {
    await this.call('DELETE', 'session' in by ? `/held/records?session=${q(by.session)}` : `/held/records?project=${q(by.project)}`);
  }

  async usage(): Promise<HeldUsage> {
    const a = obj(await this.call('GET', '/held/usage'));
    return { bytes: num(a.bytes) ?? 0, limit: num(a.limit) ?? 0 };
  }

  /** Messages waiting for this computer, oldest first; `more` when the service holds back the rest for the next call. */
  async inbox(): Promise<{ messages: WaitingMessage[]; more: boolean }> {
    const answer = obj(await this.call('GET', '/held/messages/inbox'));
    const messages = list(answer.messages).flatMap((m) => {
      const r = obj(m);
      const generation = num(r.generation);
      return str(r.id) && str(r.body) && generation !== null ? [{ id: r.id as string, from: str(r.from), to: str(r.to) ?? '', generation, body: r.body as string }] : [];
    });
    return { messages, more: answer.more === true };
  }

  async deleteMessage(id: string): Promise<void> {
    await this.call('DELETE', `/held/messages/${q(id)}`);
  }
}
