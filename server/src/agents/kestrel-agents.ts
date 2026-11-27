// Kestrel's own agents folder on a worker node (docs/designs/worker-nodes.md, section 6): `kestrel node agents`
// installs Codex and OpenCode there with the bundle's npm, never globally, and the node looks there first. One place
// says where it is and how a program in it is run, so "installed for the terminal" and "found by the node" are the
// same thing. The desktop app never looks there: the lookup asks `hostKind`.
import { delimiter, dirname, join } from 'node:path';
import { dataDir as resolveDataDir } from '../data-dir.ts';
import { hostKind } from '../host.ts';
import type { KestrelKind } from '../shared/host-kind.ts';

type Env = Record<string, string | undefined>;

/** The folder npm installs the agents into (`npm install --prefix`). Programs only; an agent's sign-in lives in the user's home, never here. */
export const agentsFolder = (dataDir: string): string => join(dataDir, 'agents');

/** Where npm puts the agents' programs inside it. */
export const agentsBin = (dataDir: string): string => join(agentsFolder(dataDir), 'node_modules', '.bin');

/** Kestrel's tools folder on a node: gh and glab, as `kestrel node git` installs them (shared/node-git-tools.ts). Programs only. */
export const toolsFolder = (dataDir: string): string => join(dataDir, 'tools');

/** Where the tools' programs are, first on the node's PATH after the agents' so the pull-request code finds them. */
export const toolsBin = (dataDir: string): string => join(toolsFolder(dataDir), 'bin');

/** The folders a node looks in for an agent's program before PATH: Kestrel's own agents folder. None in the app. */
export function kestrelAgentDirs(kind: KestrelKind = hostKind(), dataDir: string = resolveDataDir()): string[] {
  return kind === 'node' ? [agentsBin(dataDir)] : [];
}

/**
 * The environment an agent's program runs in on a node, in the terminal and in the service alike: Kestrel's agents
 * folder first, then its tools folder (gh and glab: the pull-request, review-request and Autopilot code run them by
 * name), then the folder of the Node running Kestrel (the bundle's own; npm's `codex` and `opencode`
 * launchers start with `#!/usr/bin/env node`, and a server often has no Node of its own), then PATH as it was.
 */
export function nodeAgentsEnv(env: Env, dataDir: string, nodeBinary: string = process.execPath): Env {
  const first = [agentsBin(dataDir), toolsBin(dataDir), dirname(nodeBinary)];
  const rest = (env.PATH ?? '').split(delimiter).filter((dir) => dir && !first.includes(dir));
  return { ...env, PATH: [...first, ...rest].join(delimiter) };
}
