// JSON-RPC over a line stream, as `codex app-server` speaks it on stdio: one JSON object per line,
// no "jsonrpc" field. Three kinds of message come in: responses to our requests (id, result or
// error), requests from the server (id and method: approvals) and notifications (method only).
// Everything that comes off the wire is checked before it is used; anything malformed is reported
// through `onProblem` and otherwise ignored, never thrown into the caller.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RequestId = number | string;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A request the server sent us. Answer it exactly once with `respond` or `fail`. */
export interface IncomingRequest {
  id: RequestId;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  request(request: IncomingRequest): void;
  /** A line that was not usable (bad JSON, unknown shape, a response to an id never sent). */
  problem?(message: string): void;
}

/** The request failed on the server's side: its JSON-RPC error. */
export class RpcFailure extends Error {
  constructor(
    readonly method: string,
    readonly error: RpcError,
  ) {
    super(`${method} failed: ${error.message}`);
  }
}

/** The connection closed (the process exited) before the answer came. */
export class RpcClosed extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is RequestId => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string';

function rpcError(v: unknown): RpcError {
  if (!isObject(v)) return { code: -32603, message: 'The server sent an error with no detail.' };
  return { code: typeof v.code === 'number' ? v.code : -32603, message: typeof v.message === 'string' ? v.message : 'The server sent an error with no message.', data: v.data };
}

/** Classifies one parsed message. Pure, so it is tested on its own. */
export type Parsed =
  | { kind: 'response'; id: RequestId; result: unknown }
  | { kind: 'error'; id: RequestId; error: RpcError }
  | { kind: 'request'; id: RequestId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'invalid'; reason: string };

export function parseLine(line: string): Parsed | null {
  if (!line.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: `not JSON: ${line.slice(0, 120)}` };
  }
  if (!isObject(value)) return { kind: 'invalid', reason: 'not a JSON object' };
  const params = isObject(value.params) ? value.params : {};
  const hasId = 'id' in value && value.id !== null && value.id !== undefined;
  if (typeof value.method === 'string') {
    if (!hasId) return { kind: 'notification', method: value.method, params };
    if (!isId(value.id)) return { kind: 'invalid', reason: `request ${value.method} has an unusable id` };
    return { kind: 'request', id: value.id, method: value.method, params };
  }
  if (!hasId || !isId(value.id)) return { kind: 'invalid', reason: 'a message with neither a method nor an id' };
  if ('error' in value && value.error !== undefined && value.error !== null) return { kind: 'error', id: value.id, error: rpcError(value.error) };
  if (!('result' in value)) return { kind: 'invalid', reason: `response ${String(value.id)} has neither result nor error` };
  return { kind: 'response', id: value.id, result: value.result };
}

interface Waiting {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export class RpcConnection {
  private nextId = 1;
  private readonly waiting = new Map<RequestId, Waiting>();
  private closedReason: string | null = null;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: RpcHandlers,
  ) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    // A write after the process died must not crash the server.
    output.on('error', (error) => this.close(`could not write to it: ${error.message}`));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new RpcClosed(`Codex is not running (${this.closedReason}).`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { method, resolve: resolve as (r: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  fail(id: RequestId, error: RpcError): void {
    this.write({ id, error });
  }

  /** Everything still waiting is rejected; later requests are refused at once. */
  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      w.reject(new RpcClosed(`Codex stopped before answering ${w.method} (${reason}).`));
    }
  }

  private write(message: unknown): void {
    if (this.closedReason !== null || this.output.destroyed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    const parsed = parseLine(line);
    if (!parsed) return;
    switch (parsed.kind) {
      case 'invalid':
        return this.handlers.problem?.(parsed.reason);
      case 'notification':
        return this.handlers.notification(parsed.method, parsed.params);
      case 'request':
        return this.handlers.request({ id: parsed.id, method: parsed.method, params: parsed.params });
      case 'response':
      case 'error': {
        const w = this.waiting.get(parsed.id);
        if (!w) return this.handlers.problem?.(`an answer to request ${String(parsed.id)}, which was never sent or was already answered`);
        this.waiting.delete(parsed.id);
        if (parsed.kind === 'error') w.reject(new RpcFailure(w.method, parsed.error));
        else w.resolve(parsed.result);
      }
    }
  }
}
