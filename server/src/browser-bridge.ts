// Carries an agent's browser call to a Kestrel window, and the answer back. The server cannot
// touch the page (it lives in a <webview> in the window); the window can.
//
// Browsers belong to scopes (shared/scope.ts): a session, a project page, a group page. Each
// socket says which scopes' browsers it has (`browser-serve` with a scope key, and whether it
// really has the pane: a plain browser tab does not), and a desktop window also says it can make a
// session's browser in the background (`browser-serve-any`). A request goes to exactly one
// window: the one that most recently said it has that session's browser, else the newest that
// serves any. When none does, the request waits a few seconds for one (the window may be loading)
// and then answers with a plain reason. Every request ends: with the window's answer, a timeout,
// or the window going away. Never a hang.
//
// Agents reach only their own session's browser, by construction: the tools (browser-tools.ts)
// pass the calling session's id, and `request` refuses any key that is not a session's, so a
// project's or group's browser is never addressable from an agent tool.
//
// Messages are listed in shared/browser.ts.
import { randomUUID } from 'node:crypto';
import { NEEDS_DESKTOP, NO_WINDOW, type BrowserOp } from './shared/browser.ts';
import { normalizeScopeKey, parseScope } from './shared/scope.ts';

/** Said to an agent whose call names something other than its own session. */
export const ONLY_OWN_SESSION = 'Kestrel’s browser tools only reach the calling session’s own browser.';

/** How long a request waits for a window to have the session open. */
const CLAIM_MS = 3_000;
const MAX_ERROR_CHARS = 2_000;

/** Timers, injected so tests run without waiting. */
export interface BridgeTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: BridgeTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type BridgeOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** One socket's side of the bridge. */
export interface BridgeConnection {
  /** A message whose type starts with `browser-`. */
  message(m: Record<string, unknown>): void;
  /** The socket closed: its sessions are no longer served, and its requests in flight fail. */
  close(): void;
}

interface Client {
  send(payload: object): void;
  /** Scope key -> whether this window has the pane (the desktop app) or not. */
  serving: Map<string, boolean>;
  /** When it last said it serves each scope; the newest serves. */
  since: Map<string, number>;
  /** It makes any session's browser on demand (with whether it has the pane), and since when. */
  any: { capable: boolean; since: number } | null;
}

interface Pending {
  sessionId: string;
  client: Client;
  settle(outcome: BridgeOutcome): void;
}

interface Waiting {
  sessionId: string;
  ready(client: Client): void;
}

export class BrowserBridge {
  private readonly clients = new Set<Client>();
  private readonly pending = new Map<string, Pending>();
  private readonly waiting = new Set<Waiting>();
  private order = 0;
  private readonly timers: BridgeTimers;
  private readonly claimMs: number;

  constructor(options: { timers?: BridgeTimers; claimMs?: number } = {}) {
    this.timers = options.timers ?? realTimers;
    this.claimMs = options.claimMs ?? CLAIM_MS;
  }

  connect(send: (payload: object) => void): BridgeConnection {
    const client: Client = { send, serving: new Map(), since: new Map(), any: null };
    this.clients.add(client);
    return {
      message: (m) => this.receive(client, m),
      close: () => this.drop(client),
    };
  }

  /** Run one op in the browser of a session (`<id>` or `session:<id>`). Resolves with the window's answer or a reason; never rejects. */
  request(sessionId: string, op: BrowserOp, args: Record<string, unknown>, timeoutMs: number): Promise<BridgeOutcome> {
    const scope = parseScope(sessionId);
    if (scope?.kind !== 'session') return Promise.resolve({ ok: false, error: ONLY_OWN_SESSION });
    const key = scope.id;
    const client = this.serverFor(key);
    if (client) return this.send(client, key, op, args, timeoutMs);
    return new Promise((resolve) => {
      const waiting: Waiting = {
        sessionId: key,
        ready: (found) => {
          this.timers.clear(timer);
          this.waiting.delete(waiting);
          void this.send(found, key, op, args, timeoutMs).then(resolve);
        },
      };
      const timer = this.timers.set(() => {
        this.waiting.delete(waiting);
        resolve({ ok: false, error: this.anyServes(key) ? NEEDS_DESKTOP : NO_WINDOW });
      }, this.claimMs);
      this.waiting.add(waiting);
    });
  }

  /** Requests still waiting for an answer. For tests. */
  inFlight(): number {
    return this.pending.size + this.waiting.size;
  }

  private send(client: Client, sessionId: string, op: BrowserOp, args: Record<string, unknown>, timeoutMs: number): Promise<BridgeOutcome> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = this.timers.set(() => settle({ ok: false, error: `The browser pane did not answer within ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
      const settle = (outcome: BridgeOutcome) => {
        if (!this.pending.delete(requestId)) return;
        this.timers.clear(timer);
        resolve(outcome);
      };
      this.pending.set(requestId, { sessionId, client, settle });
      try {
        client.send({ type: 'browser-request', requestId, sessionId, op, args });
      } catch {
        settle({ ok: false, error: 'The Kestrel window could not be reached.' });
      }
    });
  }

  /** The window that most recently said it has the session's browser, else the newest that makes any. */
  private serverFor(key: string): Client | null {
    let best: Client | null = null;
    for (const c of this.clients) if (c.serving.get(key) === true && (!best || c.since.get(key)! > best.since.get(key)!)) best = c;
    if (best) return best;
    for (const c of this.clients) if (c.any?.capable && (!best || c.any.since > best.any!.since)) best = c;
    return best;
  }

  private anyServes(key: string): boolean {
    for (const c of this.clients) if (c.serving.has(key) || c.any) return true;
    return false;
  }

  private receive(client: Client, m: Record<string, unknown>): void {
    if (m.type === 'browser-response') return this.respond(client, m);
    if (m.type === 'browser-serve-any') {
      client.any = { capable: m.capable === true, since: ++this.order };
      if (m.capable === true) for (const w of [...this.waiting]) w.ready(client);
      return;
    }
    if (m.type === 'browser-unserve-any') {
      client.any = null;
      return;
    }
    const key = normalizeScopeKey(m.sessionId);
    if (!key) return;
    if (m.type === 'browser-unserve') {
      client.serving.delete(key);
      client.since.delete(key);
      return;
    }
    if (m.type !== 'browser-serve') return;
    client.serving.set(key, m.capable === true);
    client.since.set(key, ++this.order);
    if (m.capable !== true) return;
    for (const w of [...this.waiting]) if (w.sessionId === key) w.ready(client);
  }

  private respond(client: Client, m: Record<string, unknown>): void {
    const requestId = typeof m.requestId === 'string' ? m.requestId : '';
    const entry = this.pending.get(requestId);
    // Only the window that was asked may answer.
    if (!entry || entry.client !== client) return;
    if (m.ok === true) return entry.settle({ ok: true, result: m.result });
    const error = typeof m.error === 'string' && m.error.trim() ? m.error.slice(0, MAX_ERROR_CHARS) : 'The browser pane could not do that.';
    entry.settle({ ok: false, error });
  }

  private drop(client: Client): void {
    this.clients.delete(client);
    for (const entry of [...this.pending.values()]) if (entry.client === client) entry.settle({ ok: false, error: 'The Kestrel window with this session’s browser closed before the browser answered.' });
  }
}

/** Whether a socket message belongs to the bridge. */
export const isBrowserMessage = (type: unknown): boolean => typeof type === 'string' && type.startsWith('browser-');
