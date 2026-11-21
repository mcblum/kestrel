// Bringing an app-server up: the `initialize` handshake, the sign-in check (`account/read`, the
// user's own Codex sign-in, never touched), and a short-lived probe that also lists the models.
import type { ModelOption } from '../types.ts';
import { configuredModel, fastTiers, toOptions } from './models.ts';
import { CodexUnavailable, NOT_SIGNED_IN, type AppServer, type Launch } from './process.ts';
import type { RpcConnection } from './rpc.ts';
import { listSkills, type CodexSkill } from './skills.ts';

/** Starts a throwaway app-server and asks what skills Codex offers a session in `directory`. Always ends the process. No turn runs. */
export async function probeSkills(launch: Launch, env: Env, version: string, directory: string): Promise<CodexSkill[]> {
  let server: AppServer | null = null;
  try {
    server = launch({ env, handlers: { notification: () => undefined, request: (r) => server?.rpc.fail(r.id, { code: -32601, message: 'Kestrel is only checking Codex.' }) }, onExit: () => undefined });
    await initialize(server.rpc, version);
    return await listSkills(server.rpc, directory);
  } finally {
    server?.kill();
  }
}

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Notifications Kestrel has no use for; Codex is asked not to send them. */
const UNUSED_NOTIFICATIONS = ['turn/moderationMetadata', 'thread/readState/changed', 'account/rateLimits/updated', 'remoteControl/status/changed', 'turn/diff/updated'];

export async function initialize(rpc: RpcConnection, version: string): Promise<void> {
  // `experimentalApi` is what lets a turn run in Codex's plan mode (`collaborationMode`).
  await rpc.request('initialize', { clientInfo: { name: 'kestrel', title: 'Kestrel', version }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: UNUSED_NOTIFICATIONS } });
  rpc.notify('initialized');
}

/** Throws `CodexUnavailable('auth')` when Codex has no sign-in it can use. */
export async function requireSignIn(rpc: RpcConnection): Promise<void> {
  const answer = await rpc.request('account/read', { refreshToken: false });
  if (!isObj(answer)) throw new Error('Codex answered account/read with something Kestrel cannot read.');
  if (!isObj(answer.account) && answer.requiresOpenaiAuth !== false) throw new CodexUnavailable(NOT_SIGNED_IN, 'auth');
}

export interface ProbeResult {
  models: ModelOption[];
  /** Each model's fast service tier id ('' for the Default), for `serviceTierForTurn`. */
  fastTiers: Record<string, string>;
}

/** Starts a throwaway app-server: checks Codex is installed and signed in, and lists its models. Always ends the process. */
export async function probeCodex(launch: Launch, env: Env, version: string): Promise<ProbeResult> {
  let server: AppServer | null = null;
  let exited: string | null = null;
  try {
    server = launch({
      env,
      handlers: { notification: () => undefined, request: (r) => server?.rpc.fail(r.id, { code: -32601, message: 'Kestrel is only checking Codex.' }) },
      onExit: (info) => (exited = info.stderr || `exit code ${info.code}`),
    });
    await initialize(server.rpc, version);
    await requireSignIn(server.rpc);
    const listed = await server.rpc.request('model/list', { limit: 100 }).catch(() => null);
    // The model in the user's Codex config, which is what Default runs.
    const configured = configuredModel(await server.rpc.request('config/read', {}).catch(() => null));
    const data = isObj(listed) ? listed.data : null;
    return { models: toOptions(data, configured), fastTiers: fastTiers(data, configured) };
  } catch (error) {
    if (error instanceof CodexUnavailable) throw error;
    throw new Error(`Codex did not start: ${error instanceof Error ? error.message : String(error)}${exited ? ` (${exited})` : ''}`);
  } finally {
    server?.kill();
  }
}

/**
 * Forks a stored thread into a new one with `thread/fork` on a throwaway app-server: the
 * conversation is copied as Codex keeps it (through `lastTurnId` when given, inclusive), set to work
 * in `cwd`, and no turn runs. Returns the new
 * thread's id, which `thread/resume` takes. Always ends the process.
 */
export async function forkThread(launch: Launch, env: Env, version: string, threadId: string, cwd: string, lastTurnId?: string): Promise<string> {
  let server: AppServer | null = null;
  try {
    server = launch({ env, handlers: { notification: () => undefined, request: (r) => server?.rpc.fail(r.id, { code: -32601, message: 'Kestrel is only forking a thread.' }) }, onExit: () => undefined });
    await initialize(server.rpc, version);
    await requireSignIn(server.rpc);
    const forked = await server.rpc.request('thread/fork', { threadId, cwd, excludeTurns: true, ...(lastTurnId ? { lastTurnId } : {}) });
    const thread = isObj(forked) && isObj(forked.thread) ? forked.thread : null;
    if (!thread || typeof thread.id !== 'string' || !thread.id) throw new Error('Codex answered thread/fork with no thread.');
    return thread.id;
  } finally {
    server?.kill();
  }
}
