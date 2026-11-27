// The inventory (docs/designs/onboarding.md, section 4): what this machine has that another would
// need, found by reading, never by changing anything. It runs only for a set-up record or a set-up
// list, so a Kestrel with no account never runs it (connect/link/setup-records.ts). Each reader takes
// names and places; values pass through `setupRecordOf` (shared/setup-record.ts), which leaves every
// secret out before anything leaves this module's caller.
import { delimiter, join } from 'node:path';
import { findIn, installDirs } from '../agents/find-program.ts';
import type { AgentAvailability } from '../runtime/agent-info.ts';
import { SELECTABLE_AGENTS } from '../model.ts';
import type { Platform } from '../shared/platform.ts';
import type { DiscoveredServer } from '../shared/setup.ts';
import { setupRecordOf, type MachineInventory, type SetupAgent, type SetupRecord } from '../shared/setup-record.ts';
import type { WhoDoesWhat } from '../shared/who-does-what.ts';
import { readAgentFiles } from './files.ts';
import { fileRecordsOf, type SetupFileRecord } from '../shared/setup-files.ts';
import { readGit, readSsh } from './git.ts';
import { readHosts } from './hosts.ts';
import { nodeFs, nodeRun, type FsRead, type Run } from './io.ts';
import { commandTool, hookCommands, projectNeeds, toolsOf, type ToolNeed } from './tools.ts';

export interface InventoryProject {
  name: string;
  folders: { name: string; path: string }[];
}

export interface InventoryDeps {
  machine: { id: string; name: string };
  platform: Platform;
  home: string;
  now: number;
  /** PATH as Kestrel's server has it. */
  path: string;
  env?: Record<string, string | undefined>;
  /** Kestrel's own answer on which agents can start (runtime `agentAvailability`). */
  agents(): Promise<AgentAvailability>;
  /** The registered projects, less any kept off Kestrel Connect. */
  projects(): Promise<InventoryProject[]>;
  /** The MCP servers Kestrel knows of, for no project and for each project folder given. */
  mcpServers(projectPaths: readonly string[]): DiscoveredServer[];
  fs?: FsRead;
  run?: Run;
  /** The knowledge base in use: its repository key and name; null when none is (onboarding.md 18.15). */
  knowledge?(): Promise<{ repo: string | null; name: string } | null>;
  /** The model presets and Who does what as stored here (onboarding.md 19). */
  whoDoesWhat?(): Promise<WhoDoesWhat>;
}

/** Each agent as ready, signed out (Kestrel can say so), or missing, from Kestrel's existing check. Pure. */
export function agentStates(availability: AgentAvailability): SetupAgent[] {
  return SELECTABLE_AGENTS.map((agent) => {
    if (availability.available.includes(agent)) return { agent, state: 'ready' as const };
    const note = availability.notes[agent] ?? '';
    const signedOut = availability.signIn.includes(agent) || /sign(ed)? ?in|log(ged)? ?in|not authenticated/i.test(note);
    return { agent, state: signedOut ? ('signed-out' as const) : ('missing' as const) };
  });
}

async function origin(run: Run, dir: string): Promise<string | null> {
  const answer = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], dir);
  return answer && answer.code === 0 ? answer.stdout.trim() || null : null;
}

/** Everything the readers find; values included, so only `setupRecordOf` may see it. */
export async function readInventory(deps: InventoryDeps): Promise<MachineInventory> {
  const fs = deps.fs ?? nodeFs;
  const run = deps.run ?? nodeRun;
  const dirs = [...deps.path.split(delimiter).filter(Boolean), ...installDirs(deps.home, deps.platform, deps.env ?? {})];
  const program = (name: string) => findIn(dirs, name, deps.platform, fs.exists);
  const problems: MachineInventory['problems'] = [];

  const [availability, projects, knowledge, whoDoesWhat] = await Promise.all([deps.agents().catch(() => null), deps.projects(), deps.knowledge?.().catch(() => null) ?? null, deps.whoDoesWhat?.().catch(() => null) ?? null]);
  if (!availability) problems.push({ part: 'agents', reason: 'Kestrel could not ask which agents are ready.' });
  const folders = projects.flatMap((p) => p.folders.map((f) => ({ project: p.name, ...f })));
  const [hosts, git, origins] = await Promise.all([readHosts(run, program('gh'), program('glab')), readGit(run, deps.home), Promise.all(folders.map((f) => origin(run, f.path)))]);
  problems.push(...hosts.problems);

  const mcp = deps.mcpServers(folders.map((f) => f.path));
  const files = readAgentFiles(fs, deps.home);
  const needs: ToolNeed[] = [
    ...folders.flatMap((f) => projectNeeds(fs, f.project, f.path)),
    ...mcp.flatMap((s) => {
      const tool = typeof s.config.command === 'string' ? commandTool(s.config.command) : null;
      return tool ? [{ name: tool, why: `the MCP server ${s.name}` }] : [];
    }),
    ...hookCommands(fs.text(join(deps.home, '.claude', 'settings.json'))).flatMap((command) => {
      const tool = commandTool(command);
      return tool ? [{ name: tool, why: "a hook in Claude's settings" }] : [];
    }),
  ];
  let i = 0;
  return {
    machine: { ...deps.machine, platform: deps.platform },
    home: deps.home,
    readAt: deps.now,
    agents: availability ? agentStates(availability) : [],
    hosts: hosts.hosts,
    git,
    ssh: readSsh(fs, deps.home),
    mcp: mcp.map((s) => ({ name: s.name, scope: s.scope, config: s.config })),
    files,
    tools: toolsOf(needs, deps.platform, (name) => program(name) !== null, fs),
    projects: projects.map((p) => ({ name: p.name, folders: p.folders.map((f) => ({ name: f.name, path: f.path, origin: origins[i++] ?? null })) })),
    knowledge,
    whoDoesWhat,
    problems,
  };
}

/** This machine's set-up record: the inventory, split. */
export async function readSetupRecord(deps: InventoryDeps): Promise<SetupRecord> {
  return setupRecordOf(await readInventory(deps));
}

/** The record and the file records (18.3) from one read of the machine. */
export async function readSetupRecordAndFiles(deps: InventoryDeps): Promise<{ record: SetupRecord; files: SetupFileRecord[] }> {
  const found = await readInventory(deps);
  return { record: setupRecordOf(found), files: fileRecordsOf(found) };
}
