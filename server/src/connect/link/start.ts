// Builds Kestrel Connect for the running server: the public service (KESTREL_CONNECT_URL for a
// self-hosted one), its realm, and the protected store: sealed under the app's keystore key when
// the app handed one over (app/vault-key.mjs), else a file only the user can read.
import type { TicketsApi } from '../../tickets/api.ts';
import { connectLists } from '../lists.ts';
import { connectCryptoProblem } from '../crypto-check.ts';
import { homedir, hostname } from 'node:os';
import { basename, delimiter, isAbsolute } from 'node:path';
import { findIn, installDirs } from '../../agents/find-program.ts';
import { readSetupRecordAndFiles } from '../../setup-inventory/index.ts';
import { nodeFs } from '../../setup-inventory/io.ts';
import { knownMcpServers } from '../../setup-inventory/mcp.ts';
import type { SetupChecks } from '../../shared/setup-list.ts';
import type { WhoDoesWhat } from '../../shared/who-does-what.ts';
import { executor } from '../../setup-actions/execute.ts';
import { installHostOf } from '../../setup-actions/host.ts';
import { nodeRunner, nodeSetupFs } from '../../setup-actions/io.ts';
import { projectAdder } from '../../setup-actions/projects.ts';
import { previewSetupList, sampleSetupList } from '../../seed-setup.ts';
import { ConnectDispatcher, type DeskOps } from '../dispatcher.ts';
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
import { seenSource } from './seen-sync.ts';
import { offersSource, offersWatch } from '../../remote-starts/offers.ts';
import { heldSource } from './held.ts';
import { fileQueueStore } from './held-queue.ts';
import { pushSource } from './push.ts';
import type { PullRequestStore } from '../../pull-requests/store.ts';
import type { ReviewRequestStore } from '../../review-requests/store.ts';
import type { TicketStore } from '../../tickets/store.ts';
import type { McpServerStore } from '../../mcp-servers/store.ts';
import { listNameOf, type McpServerView } from '../../shared/mcp-servers.ts'; import { sshHostsOf } from '../../shared/setup-record.ts';
import type { SetupFileRecord } from '../../shared/setup-files.ts';
import { mcpMissingOf, mcpStateOf, mcpTarget } from '../../setup-actions/mcp.ts';
import { homePathHere, type KnowledgeTarget } from '../../setup-actions/execute.ts';

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
function setupDepsBase(workspace: Workspace, runtime: SessionRuntime, fake: boolean, dataDir: string, mcpServers: McpServerStore | null): NonNullable<ConstructorParameters<typeof KestrelConnect>[0]['setup']> {
  const platform = hostPlatform();
  const home = homedir();
  const dirs = () => [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...installDirs(home, platform, process.env)];
  const find = (name: string) => findIn(dirs(), name, platform, nodeFs.exists);
  // Hosts a set-up step reached over SSH with this computer's own key, while Kestrel runs.
  const reached = new Set<string>();
  // Kestrel's own MCP servers as last read, by name: the checks are answered from it, read before each list.
  let mcpViews = new Map<string, McpServerView>();
  // The knowledge base in use here, by repository key and name, as last read (18.15).
  const knowledge = runtime.knowledge;
  const projectsHere = async () => (await workspace.state()).projects;
  const inUse = async (): Promise<{ projectId: string; name: string; repo: string | null } | null> => {
    const { projectId } = await knowledge.settings();
    const project = projectId ? (await projectsHere()).find((p) => p.id === projectId) : undefined;
    return project ? { projectId: project.id, name: project.name, repo: (await knowledge.repositoryKeys(project))[0] ?? null } : null;
  };
  let knowledgeHere: { repo: string; name: string } | null = null;
  // The model presets and Who does what here, as last read (onboarding.md 19).
  let whoHere: WhoDoesWhat | null = null;
  const knowledgeTarget: KnowledgeTarget = {
    current: async () => {
      const found = await inUse();
      return found && { projectId: found.projectId, name: found.name };
    },
    projectOf: async (repo) => {
      for (const p of await projectsHere()) if ((await knowledge.repositoryKeys(p)).includes(repo)) return { projectId: p.id, name: p.name };
      return null;
    },
    use: async (projectId) => void (await knowledge.setSettings({ projectId })),
  };
  // The file records of the last read of this machine, written beside its set-up record (18.3).
  let fileRecords: readonly SetupFileRecord[] = [];
  const checks: SetupChecks = {
    tool: (name) => (name === 'Xcode' ? platform === 'mac' && nodeFs.exists('/Applications/Xcode.app') : name === 'Homebrew' ? find('brew') !== null : find(name === 'bundler' ? 'bundle' : name) !== null),
    get host() {
      return installHostOf(platform, find, process.env);
    },
    sshReaches: (host) => reached.has(host),
    // A clone's origin, read from its own git config: no program is run and nothing secret is opened.
    originAt: (path) => {
      const full = path.startsWith('~') ? homePathHere(path, home) : null;
      const config = full ? nodeFs.text(join(full, '.git', 'config')) : null;
      return config ? (/\[remote "origin"\][^\[]*?^\s*url\s*=\s*(\S+)\s*$/m.exec(config)?.[1] ?? null) : null;
    },
    sshHosts: () => {
      const config = nodeFs.text(join(home, '.ssh', 'config'));
      return config ? sshHostsOf(config).map((h) => h.host) : [];
    },
    exists: (path) => {
      const full = path.startsWith('~') ? homePathHere(path, home) : isAbsolute(path) ? path : null;
      return full !== null && nodeFs.exists(full);
    },
    ...(mcpServers ? { mcp: (name: string) => mcpStateOf(mcpViews.get(listNameOf(name))), mcpMissing: (name: string) => mcpMissingOf(mcpViews.get(listNameOf(name))) } : {}),
    get knowledge() {
      return knowledgeHere;
    },
    get whoDoesWhat() {
      return whoHere;
    },
  };
  const execute = executor({ home, platform, run: nodeRunner(platform), fs: nodeSetupFs, host: () => installHostOf(platform, find, process.env), dataDir, addProject: projectAdder(workspace), knowledge: knowledgeTarget, models: runtime.whoDoesWhat, ...(mcpServers ? { mcp: mcpTarget(mcpServers) } : {}) });
  return {
    checks,
    refresh: async () => {
      if (mcpServers) mcpViews = new Map((await mcpServers.list()).servers.map((v) => [v.name, v]));
      const found = await inUse().catch(() => null);
      knowledgeHere = found?.repo ? { repo: found.repo, name: found.name } : null;
      whoHere = await runtime.whoDoesWhat.current().catch(() => null);
    },
    execute: async (action, ctx) => {
      const result = await execute(action, ctx);
      if (action.kind === 'ssh-key' && result.state === 'done') reached.add(action.host);
      return result;
    },
    ...(fake ? { sample: () => sampleSetupList(Date.now()) } : {}),
    fileRecords: () => fileRecords,
    // Read only on the person's Allow for another computer (setup-values/read.ts): the same discovery the record is built from.
    values: {
      home,
      mcpServers: async (keptOff) => {
        const paths = (await workspace.state()).projects.filter((p) => !keptOff.includes(p.id)).flatMap((p) => p.folders.map((f) => f.path));
        return knownMcpServers(paths, home);
      },
      ...(mcpServers ? { kestrelServer: (name: string) => mcpServers.configOf(listNameOf(name)).catch(() => null) } : {}),
    },
    ...(mcpServers ? { mcp: { has: async (name: string) => (await mcpServers.list()).servers.some((v) => v.name === name), fill: (name: string, values: Readonly<Record<string, string>>) => mcpServers.fillValues(name, values), clear: (name: string, keys: readonly string[]) => mcpServers.clearValues(name, keys) } } : {}),
    inventory: async (desk, keptOff) => {
      const read = await readSetupRecordAndFiles({
        machine: desk,
        platform,
        home,
        now: Date.now(),
        path: process.env.PATH ?? '',
        env: process.env,
        agents: () => runtime.agentAvailability(),
        projects: async () => (await workspace.state()).projects.filter((p) => !keptOff.includes(p.id)).map((p) => ({ name: p.name, folders: p.folders.map((f) => ({ name: basename(f.path), path: f.path })) })),
        mcpServers: (paths) => knownMcpServers(paths, home),
        knowledge: async () => {
          const found = await inUse();
          return found && !keptOff.includes(found.projectId) ? { repo: found.repo, name: found.name } : null;
        },
        whoDoesWhat: () => runtime.whoDoesWhat.current(),
      });
      fileRecords = read.files;
      return read.record;
    },
  };
}

/** `vaultKey`: the key the app handed over, read once by the caller (it is readable only once); absent, it is read here. */
/** `setupDepsBase`, and in a checkout started with `KESTREL_SETUP_PREVIEW=1`, the page's list as a new Mac would be shown this computer's record. */
function setupDeps(...args: Parameters<typeof setupDepsBase>): ReturnType<typeof setupDepsBase> {
  const deps = setupDepsBase(...args);
  if (process.env.KESTREL_SETUP_PREVIEW !== '1' || process.env.KESTREL_PACKAGED === '1') return deps;
  return { ...deps, preview: async (name) => previewSetupList(await deps.inventory({ id: 'preview-source', name }, []), Date.now()) };
}

export async function startConnect(opts: { dataDir: string; settings: SettingStore; fake: boolean; workspace: Workspace; runtime: SessionRuntime; reviewRequests?: ReviewRequestStore; tickets?: TicketStore; ticketsApi?: TicketsApi; pullRequests?: PullRequestStore; mcpServers?: McpServerStore; vaultKey?: Buffer | null }): Promise<KestrelConnect> {
  const service = new HttpConnectService(serviceUrl());
  const identity = new OidcProvider(async () => (await service.config()).issuer, CONNECT_DESKTOP_CLIENT);
  const key = opts.vaultKey !== undefined ? opts.vaultKey : readVaultKey();
  const vault = key ? keyedFileVault(join(opts.dataDir, PROTECTED_FILES.connectSealed), key) : plainFileVault(join(opts.dataDir, PROTECTED_FILES.connectPlain));
  // How a refusal names this computer to the phone.
  const here = hostPlatform() === 'mac' ? 'your Mac' : 'your computer';
  // A paired phone's decrypted requests are carried out in process (connect/dispatcher.ts).
  const pulls = opts.pullRequests ? { store: opts.pullRequests, prefs: opts.runtime.gitPrefs, workspace: opts.workspace } : null;
  const lists = connectLists(opts.runtime.reviewPrefs, opts.reviewRequests ?? null, opts.tickets ?? null, pulls);
  const dispatch = (deviceId: string, send: (frame: Envelope) => void, desk: DeskOps): ConnectDispatcher => new ConnectDispatcher({ workspace: opts.workspace, runtime: opts.runtime, deviceId, here, send, lists, reviewRequests: opts.reviewRequests ?? null, tickets: opts.ticketsApi ?? null, desk, keptOff: (): readonly string[] => connect.keptOff() });
  const connect: KestrelConnect = new KestrelConnect({ vault, identity, service, settings: opts.settings, computerName: computerName(), unavailable: opts.fake ? SAMPLE_DATA_REASON : connectCryptoProblem(), dispatch, here, held: { source: heldSource(opts.workspace, opts.runtime, lists), queue: fileQueueStore(join(opts.dataDir, HELD_QUEUE_FILE)) }, push: { source: pushSource(opts.workspace, opts.runtime, opts.reviewRequests ?? null, opts.tickets ?? null, opts.pullRequests ?? null) }, setup: setupDeps(opts.workspace, opts.runtime, opts.fake, opts.dataDir, opts.mcpServers ?? null), replica: opts.workspace.account, projects: opts.workspace.accountProjects, seen: seenSource(opts.workspace), offers: { source: offersSource(opts.runtime, opts.workspace, here), store: opts.workspace.accountOffers, watch: offersWatch(opts.runtime, opts.workspace) } });
  await connect.start();
  return connect;
}
