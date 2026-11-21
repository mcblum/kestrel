// Short-lived OpenCode servers: the probe (is OpenCode installed, can it run a model, which models),
// the slash commands of a folder, and Fork. Each starts `opencode serve` with every MCP server of
// the user's switched off (so it starts fast) and no Kestrel tools, asks, and always ends the
// process. No turn runs and nothing is written but what Fork itself copies.
import type { ModelOption } from '../types.ts';
import type { SlashCommand } from '../../shared/slash-commands.ts';
import { call, clientFor, type OpencodeClient } from './client.ts';
import { configuredModel, connectedProviders, toOptions } from './models.ts';
import { slashCommands } from './input.ts';
import { NOT_SIGNED_IN, OpencodeUnavailable, type Launch, type OpencodeServer } from './process.ts';
import { configuredServers } from './user-config.ts';

type Env = Record<string, string | undefined>;

export interface ProbeResult {
  models: ModelOption[];
  /** `provider.list` as OpenCode answered: kept for the models' context windows. */
  providers: unknown;
}

/** The configuration of a server that only answers questions: the user's MCP servers off. */
const quietConfig = (directory: string, env: Env): Record<string, unknown> => ({
  autoupdate: false,
  share: 'disabled',
  mcp: Object.fromEntries(configuredServers(directory, env).map((name) => [name, { enabled: false }])),
});

async function withServer<T>(launch: Launch, env: Env, directory: string, work: (client: OpencodeClient) => Promise<T>): Promise<T> {
  let server: OpencodeServer | null = null;
  try {
    server = await launch({ env, config: quietConfig(directory, env), pure: false, onExit: () => undefined });
    return await work(clientFor(server, directory));
  } finally {
    server?.kill();
  }
}

/** Starts a throwaway server: checks OpenCode is installed and has a provider it can use, and lists its models. */
export async function probeOpencode(launch: Launch, env: Env, directory: string): Promise<ProbeResult> {
  return withServer(launch, env, directory, async (client) => {
    const providers = await call('list its providers', client.provider.list());
    if (connectedProviders(providers).length === 0) throw new OpencodeUnavailable(NOT_SIGNED_IN, 'auth');
    const config = await call('read its configuration', client.config.get()).catch(() => null);
    return { models: toOptions(providers, configuredModel(config)), providers };
  });
}

/** The slash commands OpenCode offers a session in `directory`. */
export async function probeCommands(launch: Launch, env: Env, directory: string): Promise<SlashCommand[]> {
  return withServer(launch, env, directory, async (client) => slashCommands(await call('list its commands', client.command.list())));
}

/**
 * Forks a stored conversation with OpenCode's own `session.fork`: the whole conversation is copied
 * into a new session, and no turn runs. Returns the new session's id, which `resume` takes.
 */
export async function forkSession(launch: Launch, env: Env, sessionID: string, directory: string): Promise<string> {
  return withServer(launch, env, directory, async (client) => {
    const forked = await call<{ id?: unknown }>('fork the conversation', client.session.fork({ sessionID }));
    if (typeof forked?.id !== 'string' || !forked.id) throw new Error('OpenCode answered the fork with no session.');
    return forked.id;
  });
}
