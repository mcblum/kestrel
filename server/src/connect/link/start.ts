// Builds Kestrel Connect for the running server: the public service (KESTREL_CONNECT_URL for a
// self-hosted one), its realm, and the protected store: sealed under the app's keystore key when
// the app handed one over (app/vault-key.mjs), else a file only the user can read.
import type { TicketsApi } from '../../tickets/api.ts';
import { connectLists } from '../lists.ts';
import { connectCryptoProblem } from '../crypto-check.ts';
import { homedir, hostname } from 'node:os';
import { basename, delimiter } from 'node:path';
import { findIn, installDirs } from '../../agents/find-program.ts';
import { readSetupRecord } from '../../setup-inventory/index.ts';
import { nodeFs } from '../../setup-inventory/io.ts';
import { knownMcpServers } from '../../setup-inventory/mcp.ts';
import type { SetupChecks } from '../../shared/setup-list.ts';
import { sampleSetupList } from '../../seed-setup.ts';
import { ConnectDispatcher } from '../dispatcher.ts';
import { hostPlatform } from '../../host.ts';
import type { SessionRuntime } from '../../runtime.ts';
import type { Envelope } from '../../shared/connect-ops.ts';
import type { Workspace } from '../../workspace.ts';
import { join } from 'node:path';
import { CONNECT_DESKTOP_CLIENT, CONNECT_SERVICE_URL } from '../../shared/connect.ts';
import type { SettingStore } from '../../suggestions/prefs.ts';
import { KestrelConnect } from './connect.ts';
import { OidcProvider } from './identity.ts';
import { HttpConnectService } from './service.ts';
import { keyedFileVault, plainFileVault, readVaultKey } from './vault.ts';
import { heldSource } from './held.ts';
import { fileQueueStore } from './held-queue.ts';
import { pushSource } from './push.ts';
import type { PullRequestStore } from '../../pull-requests/store.ts';
import type { ReviewRequestStore } from '../../review-requests/store.ts';
import type { TicketStore } from '../../tickets/store.ts';

/** The held conversations' upload queue: ids and hashes, no text and no key, so not a protected file. */
export const HELD_QUEUE_FILE = 'connect-held-queue.json';
import { PROTECTED_FILES } from '../../shared/protected-files.ts';

export const SAMPLE_DATA_REASON = 'Kestrel Connect is off while Kestrel runs with sample data.';

/** The name other devices see: the host name without its local domain. */
export function computerName(name: string = hostname()): string {
  return name.replace(/\.(local|lan|home)$/i, '').trim() || 'This computer';
}

export function serviceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.KESTREL_CONNECT_URL?.trim() || CONNECT_SERVICE_URL;
  return url.replace(/\/+$/, '');
}

/**
 * How this machine is read for its set-up record (setup-inventory/): only ever called by Kestrel
 * Connect with an account, so a Kestrel with no account never reads it. Projects kept off Kestrel
 * Connect are left out whole.
 */
function setupDeps(workspace: Workspace, runtime: SessionRuntime, fake: boolean): NonNullable<ConstructorParameters<typeof KestrelConnect>[0]['setup']> {
  const platform = hostPlatform();
  const home = homedir();
  const dirs = () => [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...installDirs(home, platform, process.env)];
  const checks: SetupChecks = {
    tool: (name) => (name === 'Xcode' ? platform === 'mac' && nodeFs.exists('/Applications/Xcode.app') : findIn(dirs(), name === 'bundler' ? 'bundle' : name, platform, nodeFs.exists) !== null),
  };
  return {
    checks,
    ...(fake ? { sample: () => sampleSetupList(Date.now()) } : {}),
    inventory: (desk, keptOff) =>
      readSetupRecord({
        machine: desk,
        platform,
        home,
        now: Date.now(),
        path: process.env.PATH ?? '',
        env: process.env,
        agents: () => runtime.agentAvailability(),
        projects: async () => (await workspace.state()).projects.filter((p) => !keptOff.includes(p.id)).map((p) => ({ name: p.name, folders: p.folders.map((f) => ({ name: basename(f.path), path: f.path })) })),
        mcpServers: (paths) => knownMcpServers(paths, home),
      }),
  };
}

/** `vaultKey`: the key the app handed over, read once by the caller (it is readable only once); absent, it is read here. */
export async function startConnect(opts: { dataDir: string; settings: SettingStore; fake: boolean; workspace: Workspace; runtime: SessionRuntime; reviewRequests?: ReviewRequestStore; tickets?: TicketStore; ticketsApi?: TicketsApi; pullRequests?: PullRequestStore; vaultKey?: Buffer | null }): Promise<KestrelConnect> {
  const service = new HttpConnectService(serviceUrl());
  const identity = new OidcProvider(async () => (await service.config()).issuer, CONNECT_DESKTOP_CLIENT);
  const key = opts.vaultKey !== undefined ? opts.vaultKey : readVaultKey();
  const vault = key ? keyedFileVault(join(opts.dataDir, PROTECTED_FILES.connectSealed), key) : plainFileVault(join(opts.dataDir, PROTECTED_FILES.connectPlain));
  // How a refusal names this computer to the phone.
  const here = hostPlatform() === 'mac' ? 'your Mac' : 'your computer';
  // A paired phone's decrypted requests are carried out in process (connect/dispatcher.ts).
  const pulls = opts.pullRequests ? { store: opts.pullRequests, prefs: opts.runtime.gitPrefs, workspace: opts.workspace } : null;
  const lists = connectLists(opts.runtime.reviewPrefs, opts.reviewRequests ?? null, opts.tickets ?? null, pulls);
  const dispatch = (deviceId: string, send: (frame: Envelope) => void) => new ConnectDispatcher({ workspace: opts.workspace, runtime: opts.runtime, deviceId, here, send, lists, reviewRequests: opts.reviewRequests ?? null, tickets: opts.ticketsApi ?? null });
  const connect = new KestrelConnect({ vault, identity, service, settings: opts.settings, computerName: computerName(), unavailable: opts.fake ? SAMPLE_DATA_REASON : connectCryptoProblem(), dispatch, here, held: { source: heldSource(opts.workspace, opts.runtime, lists), queue: fileQueueStore(join(opts.dataDir, HELD_QUEUE_FILE)) }, push: { source: pushSource(opts.workspace, opts.runtime, opts.reviewRequests ?? null, opts.tickets ?? null, opts.pullRequests ?? null) }, setup: setupDeps(opts.workspace, opts.runtime, opts.fake) });
  await connect.start();
  return connect;
}
