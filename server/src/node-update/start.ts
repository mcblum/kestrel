// The worker node's updater as the server makes it (start-server.ts), with what it reads from the rest: the account's
// desktops from Kestrel Connect's device list (the keyring's kinds) and their versions from their offers records; the
// node's work from the quit check, the mirror and the pusher; whether systemd runs it; and the runner (runner.ts). Its
// triggers are wired here too: never a timer.
import { homedir } from 'node:os';
import type { KestrelConnect } from '../connect/link/connect.ts';
import { hostPlatform } from '../host.ts';
import { hostFacts, hostProbe } from '../node-control/host-facts.ts';
import { installedBundle } from '../node-control/upgrade.ts';
import type { ProjectMirror } from '../project-clone/mirror.ts';
import { quitCheckNow } from '../quit-check-now.ts';
import type { NodePusher } from '../runtime/node-push.ts';
import type { SessionRuntime } from '../runtime.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { nodeInstallPaths } from '../shared/node-service.ts';
import type { SettingStore } from '../suggestions/prefs.ts';
import type { Workspace } from '../workspace.ts';
import { prepareUpdate, systemdRunner, takeOutcome, updateFiles } from './runner.ts';
import { NodeUpdateStore } from './store.ts';
import { NodeUpdater } from './updater.ts';

export interface NodeUpdateWiring {
  kind: KestrelKind;
  version: string;
  dataDir: string;
  settings: SettingStore;
  workspace: Workspace;
  runtime: SessionRuntime;
  /** This node's name as other devices see it. */
  name(): string;
  /** Kestrel Connect, once it is made. */
  connect(): KestrelConnect | null;
  mirror: Pick<ProjectMirror, 'cloningNow' | 'onIdle'> | null;
  pusher: Pick<NodePusher, 'pushingNow' | 'onIdle'> | null;
}

/** The updater, or null on a desktop. Call `follow` once Kestrel Connect is made. */
/** `store`: the node's update settings, which its page changes ("Keep this node on my desktops' version"). */
export function nodeUpdater(w: NodeUpdateWiring): { updater: NodeUpdater; store: NodeUpdateStore; follow(connect: KestrelConnect): () => void } | null {
  if (w.kind !== 'node') return null;
  const home = homedir();
  const store = new NodeUpdateStore(w.settings);
  const updater = new NodeUpdater({
    kind: w.kind,
    version: w.version,
    name: w.name,
    store,
    // The account's desktops by the keyring's kind: never a phone, never another node.
    desktops: async () => {
      const view = w.connect()?.view();
      if (!view) return [];
      const offers = await w.workspace.accountOffers.view();
      return view.devices.filter((d) => d.kind === 'desktop' && d.inAccount && !d.here).map((d) => offers[d.id]?.offers.version ?? null);
    },
    busy: async () => {
      const held = await quitCheckNow(w.workspace, (id) => w.runtime.overlay(id));
      return { sessions: [...held.working, ...held.waiting].map((s) => s.title), clones: w.mirror?.cloningNow() ?? 0, pushes: w.pusher?.pushingNow() ?? 0 };
    },
    // Only an update that systemd restarts: the unit is there and this process is its main one.
    service: async () => {
      const { service } = await hostFacts(hostProbe(hostPlatform(), home, w.dataDir));
      return service.manager === 'systemd' && service.installed && service.mainPid === process.pid;
    },
    run: async (target) => {
      const prepared = prepareUpdate({ dataDir: w.dataDir, home, bundles: nodeInstallPaths(home).bundles, installed: installedBundle(home), target });
      return prepared.ok ? systemdRunner(prepared.runner, updateFiles(w.dataDir).outcome) : prepared;
    },
    takeOutcome: () => takeOutcome(w.dataDir),
  });
  const follow = (connect: KestrelConnect): (() => void) => {
    const look = () => void updater.check();
    const idle = () => updater.maybeIdle();
    const offs = [
      // A desktop's record changed in the change feed.
      w.workspace.accountOffers.onChange(look),
      // A desktop contacted the node (a channel opened), or the account's devices were read.
      connect.onChange(look),
      // While it waits: a session's state changed, a clone or a push ended.
      w.workspace.onChange(idle),
      w.mirror?.onIdle(idle) ?? (() => undefined),
      w.pusher?.onIdle(idle) ?? (() => undefined),
    ];
    look();
    return () => {
      offs.forEach((off) => off());
      updater.close();
    };
  };
  return { updater, store, follow };
}
