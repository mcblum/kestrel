// Runs a worker node as the process: starts it, and stops it on SIGTERM and SIGINT or the `stop` command, by the
// same timed shutdown as quitting the app (shared/shutdown.ts, process-exit.ts). Started by systemd, it logs to the
// journal; started by hand, what it prints also goes to Kestrel's own log file (log-file.ts), for `kestrel-node logs`.
import { homedir } from 'node:os';
import { hostPlatform } from '../host.ts';
import { stopOnSignals } from '../process-exit.ts';
import type { ServiceState } from '../shared/node-service.ts';
import { hostProbe, serviceState } from './host-facts.ts';
import { nodeLogFile, openNodeLog, teeOutputTo } from './log-file.ts';
import { startNode, type NodeOptions } from './start-node.ts';
import { applyNodeGitEnv } from './node-git-env.ts';

/** Whether systemd started this very process (its unit's main process). */
export const startedBySystemd = (service: ServiceState, pid: number): boolean => service.manager === 'systemd' && service.installed && service.mainPid === pid;

export async function runNode(options: Omit<NodeOptions, 'onStop'>): Promise<void> {
  const probe = hostProbe(hostPlatform(), homedir(), options.dataDir);
  if (!startedBySystemd(await serviceState(probe), process.pid)) {
    const append = openNodeLog(nodeLogFile(options.dataDir));
    if (append) teeOutputTo(append);
  }
  // What Kestrel's git runs with on this node: its own key, commit name and email (`kestrel-node git`).
  if (options.env) applyNodeGitEnv(options.env, options.dataDir, 'node');
  let shutdown: (() => Promise<void>) | null = null;
  const node = await startNode({ ...options, probe, onStop: () => void shutdown?.() });
  shutdown = stopOnSignals({ close: node.close });
}
