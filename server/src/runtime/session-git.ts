// The git environment a session's agent runs in on a worker node: the node's, with the commit identity of the host of
// the repository the session works in (shared/node-git.ts `kestrelGitEnv`; node-control/node-git-env.ts). The app: none.
import { originRemote } from '../git.ts';
import { remoteHost } from '../pull-requests/choose.ts';
import { canonicalHost } from '../shared/host-terms.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { sessionGitEnv } from '../node-control/node-git-env.ts';

/** The host of the repository in `directory` (its `origin`), or null for a folder with none. */
export async function repositoryHostOf(directory: string): Promise<string | null> {
  const origin = await originRemote(directory).catch(() => null);
  const host = origin ? remoteHost(origin) : null;
  return host ? canonicalHost(host) : null;
}

export async function sessionGitEnvFor(kind: KestrelKind, dataDir: string, directory: string): Promise<Record<string, string>> {
  if (kind !== 'node') return {};
  return sessionGitEnv(dataDir, kind, await repositoryHostOf(directory));
}
