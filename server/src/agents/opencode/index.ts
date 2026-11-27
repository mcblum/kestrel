// OpenCode adapter: the user's own `opencode serve`, one long-lived child per session, spoken to
// with OpenCode's SDK (v2 client) over loopback HTTP and its event stream (handle.ts). Kestrel's
// tools reach it as a remote MCP server Kestrel serves for that session (kestrel-mcp/), named in
// the child's own configuration; the user's files are never written. Every ask OpenCode raises is
// decided by Kestrel (asks.ts, decide.ts) and becomes the same cards as Claude's and Codex's.
import { homedir } from 'node:os';
import type { ContextUsage } from '../../shared/context-usage.ts';
import type { AgentAdapter } from '../types.ts';
import { forkSession, probeCommands, probeOpencode, type ProbeResult } from './connect.ts';
import { OpencodeHandle, type HandleDeps } from './handle.ts';
import { contextWindow, FALLBACK_MODELS } from './models.ts';
import { OPENCODE_LEVELS } from './policy.ts';
import { opencodeLocks, startGate } from './one-at-a-time.ts';
import { launchCommand, launchOpencode, opencodeLauncher, OpencodeUnavailable, serveArgs, type Launch } from './process.ts';
import { configuredServers } from './user-config.ts';

type Env = Record<string, string | undefined>;

export interface OpencodeAdapterOptions {
  launch?: Launch;
  /** Kestrel's folder: OpenCode programs start one at a time across Kestrel's processes, by a lock there (one-at-a-time.ts). */
  dataDir?: string;
  env?: Env;
  /** For how long an availability answer is reused. */
  availabilityTtlMs?: number;
  now?: () => number;
  /** The folder the probe's throwaway server runs in (it reads no project there). */
  probeDirectory?: string;
  log?: (message: string) => void;
}

const DEFAULT_TTL_MS = 60_000;
/** Sessions whose last context measurement is kept (the most recently measured win). */
const MAX_REMEMBERED = 200;

export function opencodeAdapter(options: OpencodeAdapterOptions = {}): AgentAdapter {
  const env = options.env ?? process.env;
  const launch = options.launch ?? (options.dataDir ? opencodeLauncher(startGate(opencodeLocks(options.dataDir))) : launchOpencode);
  const now = options.now ?? Date.now;
  const probeDirectory = options.probeDirectory ?? homedir();
  const log = options.log ?? ((message: string) => console.warn(`[kestrel] opencode: ${message}`));
  // Each session's latest context measurement, taken as its turns end.
  const contexts = new Map<string, ContextUsage>();
  let probe: { at: number; result: Promise<ProbeResult> } | null = null;
  const probed = (): Promise<ProbeResult> => {
    if (!probe || now() - probe.at > (options.availabilityTtlMs ?? DEFAULT_TTL_MS)) {
      const result = probeOpencode(launch, env, probeDirectory);
      result.catch(() => undefined);
      probe = { at: now(), result };
    }
    return probe.result;
  };
  const deps: HandleDeps = {
    launch,
    env,
    log,
    configuredServers: (directory) => configuredServers(directory, env),
    contextWindow: async (model) => contextWindow((await probed()).providers, model),
    noteContext: (sessionId, usage) => {
      contexts.delete(sessionId);
      contexts.set(sessionId, usage);
      if (contexts.size > MAX_REMEMBERED) contexts.delete(contexts.keys().next().value!);
    },
  };
  return {
    agent: 'opencode',
    permissions: OPENCODE_LEVELS,
    contextUsage: async (sessionId) => contexts.get(sessionId) ?? null,
    async models() {
      try {
        return { models: (await probed()).models, fromSdk: true };
      } catch {
        return { models: FALLBACK_MODELS, fromSdk: false };
      }
    },
    async availability() {
      try {
        await probed();
        return { available: true };
      } catch (error) {
        if (error instanceof OpencodeUnavailable) return { available: false, reason: error.message, problem: error.kind };
        return { available: false, reason: `OpenCode could not start: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    recheck: () => void (probe = null),
    slashCommands: (startOptions) => probeCommands(launch, env, startOptions.directory),
    start(startOptions, prompt, emit, attachments) {
      const handle = new OpencodeHandle(null, startOptions, emit, deps);
      handle.send(prompt, attachments);
      return handle;
    },
    resume: (sessionId, startOptions, emit) => new OpencodeHandle(sessionId, startOptions, emit, deps),
    // OpenCode copies the conversation itself (`session.fork`); the copy is resumed in `to` on its first message.
    fork: (sessionId, where) => forkSession(launch, env, sessionId, where.from),
  };
}

/** A launcher for a program that behaves like `opencode serve`, run with Node: the fake server in tests. */
export function nodeLauncher(script: string, args: string[] = []): Launch {
  return (options) => launchCommand(process.execPath, [script, ...args, ...serveArgs(options.pure)], options);
}
