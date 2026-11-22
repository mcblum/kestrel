// Codex adapter: the user's own `codex app-server`, one long-lived child per session, JSON-RPC over
// stdio (handle.ts). Kestrel's tools reach it as an MCP server Kestrel serves over HTTP for that
// session (kestrel-mcp/); approvals arrive as requests and become the same cards as Claude's.
import { READ_ONLY_OMITTED } from '../../kestrel-mcp.ts';
import type { ContextUsage } from '../../shared/context-usage.ts';
import type { AgentAdapter } from '../types.ts';
import { forkThread, probeCodex, probeSkills, type ProbeResult } from './connect.ts';
import { skillCommands } from './skills.ts';
import { CodexHandle, type HandleDeps } from './handle.ts';
import { FALLBACK_MODELS } from './models.ts';
import { CODEX_LEVELS } from './policy.ts';
import { hostPlatform } from '../../host.ts';
import { spawnTarget } from '../find-program.ts';
import { cliSignIn } from '../sign-in.ts';
import { codexEnv } from './binary.ts';
import { codexBinary, CodexUnavailable, launchCommand, launchCodex, NOT_INSTALLED, type Launch } from './process.ts';
import { mcpServerNames, readCodexConfig } from './quiet.ts';

type Env = Record<string, string | undefined>;

export interface CodexAdapterOptions {
  launch?: Launch;
  env?: Env;
  /** For how long an availability answer is reused. */
  availabilityTtlMs?: number;
  now?: () => number;
  version?: string;
  log?: (message: string) => void;
}

const DEFAULT_TTL_MS = 60_000;
/** Threads whose last context measurement is kept (the most recently measured win). */
const MAX_REMEMBERED = 200;

export function codexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const env = options.env ?? process.env;
  const launch = options.launch ?? launchCodex;
  const now = options.now ?? Date.now;
  const version = options.version ?? '0.0.0';
  const log = options.log ?? ((message: string) => console.warn(`[kestrel] codex: ${message}`));
  // Each thread's latest context measurement, taken as its turns end. Codex has no call that
  // measures an idle thread, so a session that has not run a turn since the server started has none.
  const contexts = new Map<string, ContextUsage>();
  let fast: Record<string, string> | null = null;
  const deps: HandleDeps = {
    launch,
    env,
    version,
    log,
    configuredServers: () => mcpServerNames(readCodexConfig(env) ?? ''),
    omittedTools: (level) => (level === 'readonly' ? READ_ONLY_OMITTED : []),
    // From the last probe; a server that has not probed yet asks once.
    fastTier: async (model) => (fast ?? (await probed().then((r) => r.fastTiers, () => ({}) as Record<string, string>)))[model] ?? null,
    noteContext: (threadId, usage) => {
      contexts.delete(threadId);
      contexts.set(threadId, usage);
      if (contexts.size > MAX_REMEMBERED) contexts.delete(contexts.keys().next().value!);
    },
  };
  let probe: { at: number; result: Promise<ProbeResult> } | null = null;
  const probed = () => {
    if (!probe || now() - probe.at > (options.availabilityTtlMs ?? DEFAULT_TTL_MS)) {
      const result = probeCodex(launch, env, version);
      void result.then((r) => (fast = r.fastTiers), () => undefined);
      probe = { at: now(), result };
    }
    return probe.result;
  };
  // Codex signs itself in (`codex login` opens the page); what was known about it is asked again after.
  const signIn = cliSignIn({
    command: () => {
      const binary = codexBinary(env);
      if (!binary) return null;
      const target = spawnTarget(binary, hostPlatform());
      return { file: target.command, args: ['login'], env: codexEnv(env, binary), shell: target.shell };
    },
    missing: NOT_INSTALLED,
    onDone: () => (probe = null),
  });
  return {
    agent: 'codex',
    signIn,
    permissions: CODEX_LEVELS,
    contextUsage: async (threadId) => contexts.get(threadId) ?? null,
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
        const signedOut = error instanceof CodexUnavailable && error.kind === 'auth';
        return { available: false, reason: error instanceof Error ? error.message : String(error), ...(signedOut ? { signIn: true } : {}) };
      }
    },
    // Codex lists no slash commands, only skills: those are what "/" offers (skills.ts).
    slashCommands: async (startOptions) => skillCommands(await probeSkills(launch, env, version, startOptions.directory)),
    start(startOptions, prompt, emit, attachments) {
      const handle = new CodexHandle(null, startOptions, emit, deps);
      handle.send(prompt, attachments);
      return handle;
    },
    resume: (threadId, startOptions, emit) => new CodexHandle(threadId, startOptions, emit, deps),
    // The thread is copied by Codex itself; the fork's handle resumes the copy on its first message.
    fork: (threadId, where) => forkThread(launch, env, version, threadId, where.to, where.at),
  };
}

/** A launcher for a program that speaks the protocol, run with Node: the fake app-server in tests. */
export function nodeLauncher(script: string, args: string[] = []): Launch {
  return ({ env, handlers, onExit }) => launchCommand(process.execPath, [script, ...args], env, handlers, onExit);
}
