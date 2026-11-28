// A worker node's settings service as the server makes it (start-server.ts), with what it reads from the rest: each
// setting's own store, the status facts from what `kestrel node status` prints, the running turns from the quit check,
// and whether systemd runs the node. Only a node has one.
import { homedir } from 'node:os';
import type { KestrelConnect } from '../connect/link/connect.ts';
import { hostPlatform } from '../host.ts';
import { hostFacts, hostProbe } from '../node-control/host-facts.ts';
import { systemctl } from '../node-control/service.ts';
import { nodeStatusInputs } from '../node-control/status-inputs.ts';
import type { NodeUpdateStore } from '../node-update/store.ts';
import type { NodeUpdater } from '../node-update/updater.ts';
import type { ProjectMirror } from '../project-clone/mirror.ts';
import type { NodeProjectPrefsStore } from '../project-clone/prefs.ts';
import { quitCheckNow } from '../quit-check-now.ts';
import type { SessionRuntime } from '../runtime.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { nodeFactsOf } from '../shared/node-facts.ts';
import { NODE_UNIT_NAME } from '../shared/node-service.ts';
import { nodeStatusOf } from '../shared/node-status.ts';
import type { Workspace } from '../workspace.ts';
import { NodeSettings } from './service.ts';

export interface NodeSettingsWiring {
  kind: KestrelKind;
  version: string;
  dataDir: string;
  workspace: Workspace;
  runtime: SessionRuntime;
  /** This node's name as other devices see it. */
  name(): string;
  /** Kestrel Connect, once it is made. */
  connect(): KestrelConnect | null;
  projects: NodeProjectPrefsStore;
  update: { store: NodeUpdateStore; updater: Pick<NodeUpdater, 'check'> } | null;
  mirror: Pick<ProjectMirror, 'onIdle'> | null;
}

const STARTING = 'Kestrel Connect is still starting on this node. Try again in a moment.';

/** The service, or null on a desktop. */
export function nodeSettings(w: NodeSettingsWiring): NodeSettings | null {
  if (w.kind !== 'node') return null;
  const probe = hostProbe(hostPlatform(), homedir(), w.dataDir);
  const connectNow = (): KestrelConnect => {
    const connect = w.connect();
    if (!connect) throw new Error(STARTING);
    return connect;
  };
  return new NodeSettings({
    kind: w.kind,
    name: w.name,
    rename: (name) => connectNow().setComputerName(name),
    remoteStarts: w.runtime.remoteStarts,
    uiState: { get: () => w.workspace.getUiState(), set: (raw) => w.workspace.setUiState(raw) },
    reviews: w.runtime.reviewPrefs,
    projects: w.projects,
    follow: {
      current: async () => (await (w.update?.store.current() ?? Promise.resolve({ follow: true }))).follow,
      set: async (on) => {
        await w.update?.store.set({ follow: on });
        void w.update?.updater.check();
      },
    },
    agents: () => w.runtime.availableAgents(),
    models: async (agent) => (await w.runtime.models(agent).catch(() => ({ models: [] }))).models,
    facts: async () => nodeFactsOf(nodeStatusOf(await nodeStatusInputs({ version: w.version, kind: w.kind, dataDir: w.dataDir, runtime: w.runtime, connect: connectNow() }, probe))),
    running: async () => (await quitCheckNow(w.workspace, (id) => w.runtime.overlay(id))).working.map((s) => s.title),
    // As the updater asks it: the unit is there and this process is its main one.
    service: async () => {
      const { service } = await hostFacts(probe);
      return service.manager === 'systemd' && service.installed && service.mainPid === process.pid;
    },
    // `--no-block`: systemd takes the restart and this process is stopped by it, as `kestrel node stop` would.
    restartUnit: () => void systemctl(['restart', '--no-block', NODE_UNIT_NAME]),
    // A clone ending changes the projects line.
    watch: [(listener) => w.mirror?.onIdle(listener) ?? (() => undefined)],
  });
}
