// The Kestrel Connect service as the desktop uses it: its public config, the device API, and the
// relay socket. Behind interfaces so tests never reach the network (connect-fakes.ts). The wire
// contract is the service's (kestrel/connect, ARCHITECTURE.md): `GET /api/v1/config`, `POST
// /api/v1/devices`, and the relay at `/api/v1/relay` with `Authorization` and `Kestrel-Device`.
import WebSocket from 'ws';
import type { PublicIdentity } from '../keys.ts';

export interface ServiceConfig {
  issuer: string;
  relayPath: string;
}

export interface RegisteredDevice {
  id: string;
  name: string;
}

/** A refusal from the service, as it worded it. */
export class ServiceRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}

export interface ConnectService {
  config(): Promise<ServiceConfig>;
  /** Registers a device with its public keys (shown to whoever lets it in; trusted by nobody for being there). */
  registerDevice(accessToken: string, name: string, kind?: 'desktop' | 'phone', keys?: PublicIdentity): Promise<RegisteredDevice>;
  /**
   * One call to the service's API for a device (`/api/v1` + `path`): the account data key, held
   * records and waiting messages. The JSON answer, null for 204, or throws `ServiceRefusal`.
   */
  call(accessToken: string, deviceId: string, method: ServiceMethod, path: string, body?: unknown): Promise<unknown>;
  /** Removes a device from the account (`DELETE /api/v1/devices/:id`). */
  removeDevice(accessToken: string, deviceId: string): Promise<void>;
  /** Opens the relay socket; the caller watches it through `RelayEvents`. */
  openRelay(accessToken: string, deviceId: string, events: RelayEvents): RelaySocket;
}

export interface RelaySocket {
  send(text: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export interface RelayEvents {
  open(): void;
  message(text: string): void;
  pong(): void;
  /** The upgrade was refused: HTTP status and the service's code and reason. */
  refused(refusal: ServiceRefusal): void;
  closed(code: number, reason: string): void;
  error(error: Error): void;
}

export type ServiceMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const TIMEOUT_MS = 15_000;
/** A held record can be tens of megabytes. */
const CALL_TIMEOUT_MS = 120_000;

async function refusalOf(res: Response): Promise<ServiceRefusal> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; reason?: unknown };
  return new ServiceRefusal(res.status, typeof body.code === 'string' ? body.code : 'http', typeof body.reason === 'string' ? body.reason : `The service answered ${res.status}.`);
}

export class HttpConnectService implements ConnectService {
  private found: Promise<ServiceConfig> | null = null;
  private relayPath = '/api/v1/relay';

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  config(): Promise<ServiceConfig> {
    this.found ??= (async () => {
      const res = await this.fetcher(`${this.baseUrl}/api/v1/config`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw await refusalOf(res);
      const body = (await res.json()) as { relay?: { path?: unknown }; oidc?: { issuer?: unknown } };
      if (typeof body.oidc?.issuer !== 'string' || typeof body.relay?.path !== 'string' || !body.relay.path.startsWith('/')) throw new Error('The Kestrel Connect service did not say how to sign in.');
      this.relayPath = body.relay.path;
      return { issuer: body.oidc.issuer, relayPath: body.relay.path };
    })();
    this.found.catch(() => (this.found = null));
    return this.found;
  }

  async registerDevice(accessToken: string, name: string, kind: 'desktop' | 'phone' = 'desktop', keys?: PublicIdentity): Promise<RegisteredDevice> {
    const res = await this.fetcher(`${this.baseUrl}/api/v1/devices`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind, ...(keys ? { keys } : {}) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 201 && res.status !== 200) throw await refusalOf(res);
    const body = (await res.json()) as { device?: { id?: unknown; name?: unknown } };
    if (typeof body.device?.id !== 'string') throw new Error('The Kestrel Connect service did not give this computer an id.');
    return { id: body.device.id, name: typeof body.device.name === 'string' ? body.device.name : name };
  }

  async call(accessToken: string, deviceId: string, method: ServiceMethod, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, 'Kestrel-Device': deviceId };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetcher(`${this.baseUrl}/api/v1${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!res.ok) throw await refusalOf(res);
    return res.status === 204 ? null : res.json();
  }

  async removeDevice(accessToken: string, deviceId: string): Promise<void> {
    const res = await this.fetcher(`${this.baseUrl}/api/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Already gone is what was asked for.
    if (!res.ok && res.status !== 404) throw await refusalOf(res);
  }

  openRelay(accessToken: string, deviceId: string, events: RelayEvents): RelaySocket {
    // The relay path comes from config, which is read before any link is opened.
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${this.relayPath}`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Kestrel-Device': deviceId }, handshakeTimeout: TIMEOUT_MS, maxPayload: 40 * 1024 * 1024 });
    let refused = false;
    socket.on('open', () => events.open());
    socket.on('message', (data, isBinary) => {
      if (!isBinary) events.message(data.toString());
    });
    socket.on('pong', () => events.pong());
    socket.on('unexpected-response', (_req, res) => {
      refused = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let body: { code?: unknown; reason?: unknown } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // not JSON: the status says enough
        }
        events.refused(new ServiceRefusal(res.statusCode ?? 0, typeof body.code === 'string' ? body.code : 'http', typeof body.reason === 'string' ? body.reason : `The service answered ${res.statusCode}.`));
        socket.terminate();
      });
    });
    socket.on('close', (code, reason) => {
      if (!refused) events.closed(code, reason.toString());
    });
    socket.on('error', (error) => {
      if (!refused) events.error(error);
    });
    return {
      send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
      ping: () => socket.readyState === WebSocket.OPEN && socket.ping(),
      close: (code, reason) => (socket.readyState === WebSocket.CONNECTING ? socket.terminate() : socket.close(code, reason)),
    };
  }
}
