// The service's routes for letting a device into the account and for a device's public keys
// (kestrel-connect.md, "Account stage 1 as built"). Typed, and nothing else: the service is trusted with
// none of it, and the flow that decides what to believe is join.ts.
import type { PublicIdentity } from '../keys.ts';
import type { ServiceCall } from './held-api.ts';
import { ServiceRefusal } from './service.ts';

/** A request to be let in, as the service carries it. */
export interface JoinRequest {
  id: string;
  device: { id: string; name: string; kind: 'desktop' | 'phone' };
  commitment: string;
  createdAt: number;
  expiresAt: number;
}

/** A device of the account with the public keys it put (untrusted: only shown). */
export interface ServiceDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'phone';
  keys: PublicIdentity | null;
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const kindOf = (value: unknown): 'desktop' | 'phone' => (value === 'phone' ? 'phone' : 'desktop');
const time = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);

function keysOf(raw: unknown): PublicIdentity | null {
  const k = obj(raw);
  const signing = str(k.signing);
  const agreement = str(k.agreement);
  return signing && agreement ? { signing, agreement } : null;
}

/** A join request from the service's words, or null when it is not one. */
export function asJoinRequest(raw: unknown): JoinRequest | null {
  const j = obj(raw);
  const device = obj(j.device);
  const id = str(j.id);
  const deviceId = str(device.id);
  const commitment = str(j.commitment);
  const expiresAt = time(j.expiresAt);
  if (!id || !deviceId || !commitment || !Number.isFinite(expiresAt)) return null;
  const createdAt = time(j.createdAt);
  return { id, device: { id: deviceId, name: str(device.name) ?? 'A device', kind: kindOf(device.kind) }, commitment, createdAt: Number.isFinite(createdAt) ? createdAt : 0, expiresAt };
}

export class JoinApi {
  constructor(private readonly call: ServiceCall) {}

  /** Puts this device's public keys; already set to the same keys is fine. */
  async putKeys(keys: PublicIdentity): Promise<void> {
    await this.call('PUT', '/devices/keys', keys);
  }

  /** Renames a device of the account (`PATCH /devices/:id`): a label only. */
  async rename(deviceId: string, name: string): Promise<void> {
    await this.call('PATCH', `/devices/${encodeURIComponent(deviceId)}`, { name });
  }

  async devices(): Promise<ServiceDevice[]> {
    const answer = obj(await this.call('GET', '/devices'));
    const list = Array.isArray(answer.devices) ? answer.devices : [];
    return list.flatMap((raw) => {
      const d = obj(raw);
      const id = str(d.id);
      return id ? [{ id, name: str(d.name) ?? 'A device', kind: kindOf(d.kind), keys: keysOf(d.keys) }] : [];
    });
  }

  async ask(commitment: string): Promise<JoinRequest> {
    const join = asJoinRequest(obj(await this.call('POST', '/join', { commitment })).join);
    if (!join) throw new Error('The service did not say which request it made.');
    return join;
  }

  async list(): Promise<JoinRequest[]> {
    const answer = obj(await this.call('GET', '/join'));
    return (Array.isArray(answer.joins) ? answer.joins : []).flatMap((raw) => asJoinRequest(raw) ?? []);
  }

  /** Ends a request; one that is already gone is what was asked for. */
  async end(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/join/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof ServiceRefusal && error.status === 404)) throw error;
    }
  }
}
