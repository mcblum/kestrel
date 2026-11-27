// The one place a worker node puts its git settings (shared/node-git.ts) into the environment its git and its
// sessions' agents run in: at start (run.ts) and whenever `kestrel node git` is done (the socket's `git`). The
// environment is the server's own (process.env in a running node), changed in place so every holder of it (git.ts,
// each agent's adapter) sees the change. Nothing is written into the user's git configuration.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KestrelKind } from '../shared/host-kind.ts';
import { identityIncludes, isKestrelGitEnvKey, kestrelGitEnv, nodeGitPaths, parseNodeGitSettings, withKestrelGitEnv, type NodeGitPaths, type NodeGitSettings } from '../shared/node-git.ts';

type Env = Record<string, string | undefined>;

/** What `kestrel node git` kept, read now. Never throws: a missing or broken file is no settings. */
export function readNodeGitSettings(dataDir: string): NodeGitSettings {
  try {
    return parseNodeGitSettings(readFileSync(nodeGitPaths(dataDir).settings, 'utf8'));
  } catch {
    return parseNodeGitSettings(null);
  }
}

/** Whether the node has its own key that its git uses: made by `kestrel node git` and kept in its settings (as `kestrelGitEnv` decides). */
export function nodeKeyReady(dataDir: string, keyIsThere: (path: string) => boolean = existsSync): boolean {
  return keyIsThere(nodeGitPaths(dataDir).key) && readNodeGitSettings(dataDir).key !== null;
}

/** Writes each host's identity file (`identityIncludes`), mode 600, and removes those of hosts that no longer have one. */
export function writeIdentityIncludes(settings: NodeGitSettings, paths: NodeGitPaths): void {
  const files = identityIncludes(settings, paths);
  if (files.length > 0) mkdirSync(paths.identity, { recursive: true, mode: 0o700 });
  const keep = new Set(files.map((f) => f.path));
  for (const file of files) {
    const was = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
    if (was !== file.text) writeFileSync(file.path, file.text, { mode: 0o600 });
  }
  if (!existsSync(paths.identity)) return;
  for (const name of readdirSync(paths.identity)) if (!keep.has(join(paths.identity, name))) rmSync(join(paths.identity, name), { force: true });
}

/** Puts the node's git settings into `env`, in place, taking away what it set before. Answers the names now set. */
export function applyNodeGitEnv(env: Env, dataDir: string, kind: KestrelKind, keyIsThere: (path: string) => boolean = existsSync): string[] {
  const paths = nodeGitPaths(dataDir);
  const settings = readNodeGitSettings(dataDir);
  if (kind === 'node') writeIdentityIncludes(settings, paths);
  const next = withKestrelGitEnv(env, kestrelGitEnv(kind, settings, paths, keyIsThere(paths.key)));
  for (const key of Object.keys(env)) if (isKestrelGitEnvKey(key)) delete env[key];
  Object.assign(env, next);
  return Object.keys(env).filter(isKestrelGitEnvKey).sort();
}

/**
 * The git environment of one session's agent: the node's, with the commit identity of the host of the session's own
 * repository (`kestrelGitEnv`). Read from the settings file each time a session starts or resumes, so a change made by
 * `kestrel node git` holds from the next turn. The app: nothing.
 */
export function sessionGitEnv(dataDir: string, kind: KestrelKind, repoHost: string | null, keyIsThere: (path: string) => boolean = existsSync): Record<string, string> {
  if (kind !== 'node') return {};
  const paths = nodeGitPaths(dataDir);
  return kestrelGitEnv(kind, readNodeGitSettings(dataDir), paths, keyIsThere(paths.key), repoHost);
}
