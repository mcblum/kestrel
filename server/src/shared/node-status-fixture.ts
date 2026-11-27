// A worker node's status as the server builds it, for the tests of `kestrel node configure` (node-configure.ts, setup-flow.ts).
import type { Agent } from '../model.ts';
import { EMPTY_GIT_SETTINGS, type NodeGitSettings } from './node-git.ts';
import { gitStatusOf } from './node-git-status.ts';
import type { Lingering } from './node-service.ts';
import { nodeStatusOf, type NodeStatus } from './node-status.ts';

export const READY_GIT: NodeGitSettings = {
  ...EMPTY_GIT_SETTINGS,
  key: { fingerprint: 'SHA256:abc', madeAt: 1 },
  name: 'Dana',
  email: 'dana@example.com',
  signing: 'off',
  hosts: { 'github.com': { answer: 'works', at: 1 } },
  tools: { gh: { installed: true, by: 'kestrel', version: '2.96.0', signedIn: ['github.com'], notSignedIn: [] }, glab: null },
};

/** A node's status as the server builds it, with the facts a test changes. */
export function statusFor({ inAccount = true, removed = false, canRun = ['claude', 'codex', 'opencode'] as Agent[], git = READY_GIT, keyIsThere = true, lingering = 'on' as Lingering, sandbox = true } = {}): NodeStatus {
  return nodeStatusOf({
    version: '0.0.35',
    kind: 'node',
    platform: 'linux',
    name: 'Worker node 1',
    connect: {
      enabled: true,
      unavailable: null,
      account: inAccount ? { state: 'signed-in', email: 'dana@example.com' } : { state: 'signed-out', reason: null },
      link: inAccount ? { state: 'connected', since: 1 } : { state: 'off' },
      inAccount,
      removed,
      storage: 'file',
    },
    agents: ['claude', 'codex', 'opencode'],
    availability: { available: canRun, notes: {} },
    sandbox: sandbox ? { available: true } : { available: false, reason: 'bubblewrap and socat were not both installed when the node started.' },
    git: gitStatusOf(git, keyIsThere),
    host: { user: 'nodeuser', lingering, service: { manager: 'systemd', installed: true, active: true, mainPid: 1 }, disk: { path: '/home/node/.kestrel', freeBytes: 1e10 }, bundle: null },
    pid: 1,
  });
}

