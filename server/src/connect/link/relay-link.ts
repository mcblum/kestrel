// The desktop's one link to the Kestrel Connect relay. It dials out (no listener), heartbeats,
// reconnects with backoff, renews its token a minute before the socket's sign-in expires (the
// service closes it then with 4401; a new socket replaces the old with 4000), and says what state
// it is in. Close codes and refusals are the service's (kestrel/connect, ARCHITECTURE.md).
import type { ConnectLink } from '../../shared/connect.ts';
import { SignInEnded } from './identity.ts';
import { ServiceRefusal, type ConnectService, type RelaySocket } from './service.ts';

export const HEARTBEAT_MS = 30_000;
/** How long before the sign-in expires the token is renewed and a new socket opened. */
export const RENEW_AHEAD_MS = 60_000;
/** A socket is dialled with a token good for at least this long, so it is not renewed moments after it opens. */
export const DIAL_FRESH_FOR_MS = 3 * RENEW_AHEAD_MS;
const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** Another copy of Kestrel took this device's connection: wait longer before taking it back. */
const REPLACED_WAIT_MS = 5 * 60_000;

export const CLOSE = { replaced: 4000, removed: 4001, notReading: 4008, connections: 4029, signIn: 4401, full: 4503, restart: 1001 } as const;

export const REMOVED_REASON = 'This computer was removed from your Kestrel Connect account. Turn Connect off and on again to add it back.';

export interface LinkDeps {
  service: ConnectService;
  /** A current access token; `fresh` asks the provider for a new one. Throws `SignInEnded` when the sign-in is over. */
  token(fresh: boolean): Promise<string>;
  /** This computer's device id on the account, registering it first if it has none. */
  deviceId(): Promise<string>;
  state(link: ConnectLink): void;
  /** The sign-in is over: the module signs out with this reason. */
  signedOut(reason: string): void;
  /** The service no longer knows this device: forget its id. */
  deviceGone(): void;
  /** A frame from another device (part B decrypts it). */
  frame?(text: string): void;
  /** One of the service's own messages (`welcome`, `held-messages`), as parsed. Never a frame. */
  notice?(kind: string, message: Record<string, unknown>): void;
  now?(): number;
  random?(): number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class RelayLink {
  private socket: RelaySocket | null = null;
  /** The socket a renewal opened, until it is open and replaces `socket`. */
  private incoming: RelaySocket | null = null;
  /**
   * The socket a renewal replaced, until it has closed. The relay may have routed a frame to it just before
   * the new one took its place; that frame is still read (2026-11-24: a phone's hello was dropped there).
   */
  private previous: RelaySocket | null = null;
  private running = false;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private answered = true;
  private current: ConnectLink = { state: 'off' };

  constructor(private readonly deps: LinkDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get link(): ConnectLink {
    return this.current;
  }

  private set(link: ConnectLink): void {
    this.current = link;
    this.deps.state(link);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    void this.dial(false);
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const sockets = [this.socket, this.incoming, this.previous];
    this.socket = null;
    this.incoming = null;
    this.previous = null;
    for (const s of sockets) s?.close(1000, 'Connect turned off');
    this.set({ state: 'off' });
  }

  /** Sends a frame; false when not connected. */
  send(text: string): boolean {
    if (!this.socket || this.current.state !== 'connected') return false;
    this.socket.send(text);
    return true;
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.renewTimer, this.heartbeat]) if (t) clearTimeout(t);
    this.retryTimer = this.renewTimer = this.heartbeat = null;
  }

  /** Opens a socket. `renewal`: the current one stays until the new one is open. */
  private async dial(renewal: boolean): Promise<void> {
    if (!renewal) this.set({ state: 'connecting' });
    let token: string;
    let deviceId: string;
    try {
      token = await this.deps.token(renewal);
      deviceId = await this.deps.deviceId();
    } catch (error) {
      if (!this.running) return;
      if (error instanceof SignInEnded) return this.endSignIn(error.message);
      if (error instanceof ServiceRefusal && error.code === 'devices-limit') return this.giveUp(error.message);
      return this.retry(`could not reach Kestrel Connect (${message(error)})`);
    }
    if (!this.running) return;
    const socket: RelaySocket = this.deps.service.openRelay(token, deviceId, {
      open: () => this.opened(socket, renewal),
      message: (text) => this.received(socket, text),
      pong: () => {
        if (socket === this.socket) this.answered = true;
      },
      refused: (refusal) => this.refused(socket, refusal),
      closed: (code, reason) => this.closed(socket, code, reason),
      error: (error) => {
        if (socket === this.socket || socket === this.incoming) this.lastError = message(error);
      },
    });
    if (renewal) this.incoming = socket;
    else this.socket = socket;
  }

  private lastError: string | null = null;

  private opened(socket: RelaySocket, renewal: boolean): void {
    if (!this.running) return socket.close(1000);
    if (renewal) {
      if (socket !== this.incoming) return socket.close(1000);
      const old = this.socket;
      this.socket = socket;
      this.incoming = null;
      this.previous = old;
      old?.close(1000, 'renewed');
    } else if (socket !== this.socket) {
      return socket.close(1000);
    }
    // A retry that was waiting is not needed now: dialling again would replace this socket.
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempts = 0;
    this.lastError = null;
    if (this.current.state !== 'connected') this.set({ state: 'connected', since: this.now() });
    this.beat();
  }

  private beat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.answered = true;
    const tick = () => {
      if (!this.running || !this.socket) return;
      if (!this.answered) {
        // No pong since the last ping: the network went away without a close.
        const dead = this.socket;
        this.socket = null;
        dead.close(4000, 'no heartbeat');
        return this.retry('the connection stopped answering');
      }
      this.answered = false;
      this.socket.ping();
      this.heartbeat = setTimeout(tick, HEARTBEAT_MS);
    };
    this.heartbeat = setTimeout(tick, HEARTBEAT_MS);
  }

  private received(socket: RelaySocket, text: string): void {
    if (socket !== this.socket && socket !== this.incoming && socket !== this.previous) return;
    if (socket === this.socket) this.answered = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const service = (parsed as { service?: unknown }).service;
    if (service === 'welcome') this.welcomed((parsed as { signInExpiresAt?: unknown }).signInExpiresAt);
    // `refused` for a frame: part B's sender hears of it there; `welcome` and `held-messages` are for the held conversations.
    if (typeof service === 'string') return void this.deps.notice?.(service, parsed as Record<string, unknown>);
    this.deps.frame?.(text);
  }

  private welcomed(expiresAt: unknown): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(at)) return;
    const wait = Math.max(0, at - RENEW_AHEAD_MS - this.now());
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      if (this.running) void this.dial(true);
    }, wait);
  }

  private refused(socket: RelaySocket, refusal: ServiceRefusal): void {
    const wasIncoming = socket === this.incoming;
    if (socket !== this.socket && !wasIncoming) return;
    if (wasIncoming) this.incoming = null;
    else this.socket = null;
    if (!this.running) return;
    if (refusal.code === 'unknown-device') return this.removed();
    if (wasIncoming && this.socket) return; // the current socket carries on; it renews again on 4401
    if (wasIncoming) return this.retry(refusal.message, refusal.status === 401);
    if (refusal.status === 401) return this.retry(refusal.message, true);
    this.retry(refusal.message);
  }

  private closed(socket: RelaySocket, code: number, reason: string): void {
    if (socket === this.previous) {
      this.previous = null;
      return;
    }
    if (socket === this.incoming) {
      this.incoming = null;
      // The old socket was already replaced by the service: nothing carries on, so dial again now.
      if (!this.socket && this.running) this.retry(reason || this.lastError || `the connection closed (${code})`);
      return;
    }
    if (socket !== this.socket) return; // an old socket, replaced on purpose
    this.socket = null;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (!this.running) return;
    if (code === CLOSE.removed) return this.removed();
    if (code === CLOSE.signIn) return this.retry('the sign-in needed renewing', true, 0);
    // The service took the renewal's socket before it told us it was open: wait for that one, staying up.
    if (code === CLOSE.replaced && this.incoming) return;
    if (code === CLOSE.replaced) return this.retry('another copy of Kestrel connected as this computer', false, REPLACED_WAIT_MS);
    this.retry(reason || this.lastError || `the connection closed (${code})`);
  }

  private removed(): void {
    this.deps.deviceGone();
    this.giveUp(REMOVED_REASON);
  }

  private giveUp(reason: string): void {
    this.clearTimers();
    this.set({ state: 'offline', reason, retryAt: null });
  }

  private endSignIn(reason: string): void {
    this.running = false;
    this.clearTimers();
    this.set({ state: 'off' });
    this.deps.signedOut(reason);
  }

  /** Tries again after a backoff (or `wait`); `fresh` renews the token first. */
  private retry(reason: string, fresh = false, wait?: number): void {
    if (!this.running) return;
    this.clearTimers();
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** this.attempts);
    this.attempts += 1;
    const delay = wait ?? Math.round(backoff * (0.5 + (this.deps.random?.() ?? Math.random()) * 0.5));
    this.set({ state: 'offline', reason, retryAt: this.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.running) return;
      if (fresh) void this.dialFresh();
      else void this.dial(false);
    }, delay);
  }

  /** Dials after renewing the token (a 4401 or a 401 refusal). */
  private async dialFresh(): Promise<void> {
    try {
      await this.deps.token(true);
    } catch (error) {
      if (!this.running) return;
      if (error instanceof SignInEnded) return this.endSignIn(error.message);
      return this.retry(`could not renew the sign-in (${message(error)})`, true);
    }
    await this.dial(false);
  }
}
