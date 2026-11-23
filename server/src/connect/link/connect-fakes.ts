// Stand-ins for the identity provider and the Connect service, so tests never reach the network.
import type { CallbackResult, LoopbackCallback } from './loopback.ts';
import { SignInEnded, type AuthorizationRequest, type IdentityProvider } from './identity.ts';
import type { ConnectService, RegisteredDevice, RelayEvents, RelaySocket, ServiceConfig } from './service.ts';
import type { StoredTokens } from './vault.ts';

export function tokensFor(n: number, now: number, subject = 'sub-1', email = 'person@example.com'): StoredTokens {
  return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, accessExpiresAt: now + 300_000, idToken: null, subject, email };
}

export class FakeIdentity implements IdentityProvider {
  issued = 0;
  refreshes = 0;
  revoked: string[] = [];
  /** Set to make the next refresh fail: 'ended' (invalid_grant) or 'network'. */
  failRefresh: 'ended' | 'network' | null = null;
  failExchange: string | null = null;
  subject = 'sub-1';
  email = 'person@example.com';

  constructor(private readonly now: () => number = Date.now) {}

  async authorize(redirectUri: string): Promise<AuthorizationRequest> {
    return { url: `https://id.example.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=s1`, state: 's1', verifier: 'v1', redirectUri };
  }

  async exchange(code: string): Promise<StoredTokens> {
    if (this.failExchange) throw new Error(this.failExchange);
    if (code !== 'good-code') throw new Error('Sign-in was refused: Code not valid.');
    this.issued += 1;
    return tokensFor(this.issued, this.now(), this.subject, this.email);
  }

  async refresh(tokens: StoredTokens): Promise<StoredTokens> {
    this.refreshes += 1;
    if (this.failRefresh === 'ended') throw new SignInEnded('Token is not active');
    if (this.failRefresh === 'network') throw new Error('fetch failed');
    this.issued += 1;
    return { ...tokensFor(this.issued, this.now(), tokens.subject, tokens.email) };
  }

  async revoke(tokens: StoredTokens): Promise<void> {
    this.revoked.push(tokens.refreshToken);
  }
}

/** A loopback listener the test completes by hand. */
export function fakeListener(): { listen: () => Promise<LoopbackCallback>; complete(result: CallbackResult): void; closed(): boolean } {
  let settle: (result: CallbackResult) => void = () => undefined;
  let isClosed = false;
  return {
    listen: async () => {
      const result = new Promise<CallbackResult>((resolve) => (settle = resolve));
      return {
        redirectUri: 'http://127.0.0.1:50000/callback',
        result,
        close: () => {
          isClosed = true;
          settle({ error: 'Sign-in was cancelled.' });
        },
      };
    },
    complete: (result) => settle(result),
    closed: () => isClosed,
  };
}

export interface FakeSocket extends RelaySocket {
  token: string;
  deviceId: string;
  events: RelayEvents;
  sent: string[];
  pings: number;
  closedWith: number | null;
  /** The service answers pings (a pong) unless this is turned off. */
  answersPings: boolean;
}

export class FakeService implements ConnectService {
  sockets: FakeSocket[] = [];
  registered: RegisteredDevice[] = [];
  registerFails: Error | null = null;

  async config(): Promise<ServiceConfig> {
    return { issuer: 'https://id.example.test/realms/kestrel', relayPath: '/api/v1/relay' };
  }

  async registerDevice(_accessToken: string, name: string): Promise<RegisteredDevice> {
    if (this.registerFails) throw this.registerFails;
    const device = { id: `device-${this.registered.length + 1}`, name };
    this.registered.push(device);
    return device;
  }

  openRelay(token: string, deviceId: string, events: RelayEvents): RelaySocket {
    const socket: FakeSocket = {
      token,
      deviceId,
      events,
      sent: [],
      pings: 0,
      closedWith: null,
      answersPings: true,
      send: (text) => void socket.sent.push(text),
      ping: () => {
        socket.pings += 1;
        if (socket.answersPings) queueMicrotask(() => events.pong());
      },
      close: (code) => {
        socket.closedWith = code ?? 1000;
      },
    };
    this.sockets.push(socket);
    return socket;
  }

  last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }

  /** The service accepts the socket and welcomes it. */
  welcome(socket: FakeSocket, expiresAt: number): void {
    socket.events.open();
    socket.events.message(JSON.stringify({ service: 'welcome', deviceId: socket.deviceId, limits: {}, signInExpiresAt: new Date(expiresAt).toISOString() }));
  }
}
