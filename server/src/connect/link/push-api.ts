// The service's push routes, typed (design doc kestrel-connect.md, "Phase 6 as built"). The sealed
// strings are opaque to the service; nothing is opened in this file.
import type { ServiceCall } from './held-api.ts';

/** A phone that put a push token or its choices on the account. */
export interface PushDevice {
  deviceId: string;
  name: string;
  hasToken: boolean;
  /** The generation its sealed choices are under, and the choices; null when it made none (every kind is on). */
  generation: number | null;
  prefs: string | null;
}

export interface PushSent {
  sent: string[];
  skipped: { deviceId: string; code: string }[];
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class PushApi {
  constructor(private readonly call: ServiceCall) {}

  async devices(): Promise<PushDevice[]> {
    return list(obj(await this.call('GET', '/push/devices')).devices).flatMap((raw) => {
      const d = obj(raw);
      const deviceId = str(d.deviceId);
      if (!deviceId) return [];
      return [{ deviceId, name: str(d.name) ?? 'a phone', hasToken: d.hasToken === true, generation: num(d.generation), prefs: str(d.prefs) }];
    });
  }

  async send(body: { id: string; generation: number; to: string[]; body: string }): Promise<PushSent> {
    const answer = obj(await this.call('POST', '/push', body));
    return {
      sent: list(answer.sent).flatMap((d) => str(d) ?? []),
      skipped: list(answer.skipped).flatMap((s) => {
        const deviceId = str(obj(s).deviceId);
        return deviceId ? [{ deviceId, code: str(obj(s).code) ?? 'apns-failed' }] : [];
      }),
    };
  }
}
