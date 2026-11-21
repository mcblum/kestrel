// The OpenCode SDK's client (v2, @opencode-ai/sdk 1.14.25) for one running server, and a helper that
// turns its error answers into errors with words a person can read. Every request carries the
// server's password and the session's folder (OpenCode serves one folder per request).
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpencodeServer } from './process.ts';

export type { OpencodeClient };

export function clientFor(server: Pick<OpencodeServer, 'url' | 'authorization'>, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: server.url, headers: { Authorization: server.authorization }, directory });
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The words of an error answer (`{name, data: {message}}`, `{errors: […]}`, or anything else). */
export function answerError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!isObj(error)) return String(error);
  const data = isObj(error.data) ? error.data : {};
  if (typeof data.message === 'string' && data.message) return data.message;
  if (Array.isArray(error.errors) && error.errors.length) return JSON.stringify(error.errors[0]);
  return typeof error.name === 'string' ? error.name : JSON.stringify(error);
}

/** The data of a client call, or an error naming what was being done. */
export async function call<T>(what: string, result: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
  const answer = await result;
  if (answer.error !== undefined && answer.error !== null) throw new Error(`OpenCode could not ${what}: ${answerError(answer.error)}`);
  if (answer.response && !answer.response.ok) throw new Error(`OpenCode could not ${what} (HTTP ${answer.response.status}).`);
  return answer.data as T;
}
