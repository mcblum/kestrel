import { describe, expect, test } from 'vitest';
import { findCodex } from './codex/binary.ts';
import { agentsBin, kestrelAgentDirs, nodeAgentsEnv, toolsBin } from './kestrel-agents.ts';
import { findOpencode } from './opencode/binary.ts';
import { hereOf } from '../connect/link/start.ts';
import { nodeSandbox } from '../node-control/start-node.ts';
import { codexSignedInFrom, lastLineOf, NODE_SIGN_IN_ARGS, nodeAgentReason, opencodeSignedInFrom, versionFrom } from '../shared/node-agents.ts';
import { missingSandboxPackages, sandboxInstallCommand } from '../shared/node-sandbox.ts';

describe('the agents’ own answers, read', () => {
  test('a version, whatever words are around it', () => {
    expect(versionFrom('codex-cli 0.172.0\n')).toBe('0.172.0');
    expect(versionFrom('2.1.322 (Claude Code)')).toBe('2.1.322');
    expect(versionFrom('\u001b[1m1.14.25\u001b[0m')).toBe('1.14.25');
    expect(versionFrom('unknown')).toBeNull();
  });

  test('codex login status', () => {
    expect(codexSignedInFrom('Logged in using ChatGPT\n')).toBe(true);
    expect(codexSignedInFrom('Not logged in\n')).toBe(false);
    expect(codexSignedInFrom('error: something else')).toBeNull();
  });

  test('opencode auth list: only its count of credentials is read', () => {
    expect(opencodeSignedInFrom('┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenCode Zen api\n│\n└  1 credentials\n')).toBe(true);
    expect(opencodeSignedInFrom('┌  Credentials\n│\n└  0 credentials\n')).toBe(false);
    expect(opencodeSignedInFrom('┌  Credentials\n└  0 credentials\n┌  Environment\n└  1 environment variable\n')).toBe(false);
    expect(opencodeSignedInFrom('nothing')).toBeNull();
  });

  test('the last line said, for a check that failed', () => {
    expect(lastLineOf('starting\n\nError: Free usage exceeded\n')).toBe('Error: Free usage exceeded');
    expect(lastLineOf('\n \n')).toBeNull();
  });

  test('each sign-in is the one that needs no browser or port on the node', () => {
    expect(NODE_SIGN_IN_ARGS).toEqual({ claude: ['auth', 'login'], codex: ['login', '--device-auth'], opencode: ['auth', 'login'] });
  });

  test('read on another device, the sentence names the agent, the node and the one command to run there', () => {
    const elsewhere = { elsewhere: 'Worker node 1' };
    expect(nodeAgentReason('opencode', { trouble: 'signed-out' }, elsewhere)).toBe('OpenCode is not signed in on Worker node 1. Run `kestrel node agents` there.');
    expect(nodeAgentReason('claude', { trouble: 'missing' }, elsewhere)).toBe('Claude Code is not installed on Worker node 1. Run `kestrel node agents` there.');
    expect(nodeAgentReason('codex', { trouble: 'out-of-usage', detail: `${'x'.repeat(300)}.` }, { elsewhere: 'build-01' })).toBe("Codex's provider refused the last turn on build-01. Run `kestrel node agents` there.");
    expect(nodeAgentReason('opencode', { trouble: 'other', detail: 'port in use.' }, elsewhere)).toBe('OpenCode cannot run on Worker node 1: port in use. Run `kestrel node agents` there.');
  });

  test('read in the node’s own terminal, the same sentence without where, and the same names as the checklist', () => {
    expect(nodeAgentReason('claude', { trouble: 'signed-out' }, 'here')).toBe('Claude Code is not signed in. Run `kestrel node agents`.');
    expect(nodeAgentReason('codex', { trouble: 'missing' }, 'here')).toBe('Codex is not installed. Run `kestrel node agents`.');
    expect(nodeAgentReason('opencode', { trouble: 'out-of-usage', detail: 'Free usage exceeded' }, 'here')).toBe("OpenCode's provider refused the last turn (Free usage exceeded). Run `kestrel node agents`.");
    expect(nodeAgentReason('opencode', { trouble: 'other', detail: '' }, 'here')).toBe('OpenCode cannot run: it did not say why. Run `kestrel node agents`.');
  });
});

describe('Kestrel’s agents folder', () => {
  const data = '/home/me/.kestrel';
  const bin = '/home/me/.kestrel/agents/node_modules/.bin';
  const lookup = (files: string[]) => ({ exists: (p: string) => files.includes(p), list: () => [], home: '/home/me' });

  test('is looked in on a worker node only', () => {
    expect(kestrelAgentDirs('node', data)).toEqual([bin]);
    expect(kestrelAgentDirs('app', data)).toEqual([]);
    expect(agentsBin(data)).toBe(bin);
  });

  test('comes first on a node, before a copy on PATH; the app’s lookup is as before', () => {
    const files = [`${bin}/codex`, '/usr/local/bin/codex', `${bin}/opencode`, '/usr/local/bin/opencode'];
    expect(findCodex({ PATH: '/usr/local/bin' }, lookup(files), 'linux', kestrelAgentDirs('node', data))).toBe(`${bin}/codex`);
    expect(findCodex({ PATH: '/usr/local/bin' }, lookup(files), 'linux', kestrelAgentDirs('app', data))).toBe('/usr/local/bin/codex');
    expect(findOpencode({ PATH: '/usr/local/bin' }, lookup(files), 'linux', kestrelAgentDirs('node', data))).toBe(`${bin}/opencode`);
    expect(findOpencode({ PATH: '/usr/local/bin' }, lookup(files), 'linux', kestrelAgentDirs('app', data))).toBe('/usr/local/bin/opencode');
  });

  test('the environment the agents run in: the agents folder, the tools folder, then the Node running Kestrel, then PATH, once each', () => {
    expect(nodeAgentsEnv({ PATH: `/usr/bin:${bin}:/bin`, HOME: '/home/me' }, data, '/home/me/.kestrel/node/current/node/bin/node')).toEqual({ PATH: `${bin}:${toolsBin(data)}:/home/me/.kestrel/node/current/node/bin:/usr/bin:/bin`, HOME: '/home/me' });
    expect(toolsBin(data)).toBe(`${data}/tools/bin`);
  });
});

describe('the sandbox line', () => {
  const has = (programs: string[]) => (p: string) => programs.includes(p);
  test('what is missing, and the command for the distribution, or none known', () => {
    expect(missingSandboxPackages(has(['socat']))).toEqual(['bubblewrap']);
    expect(missingSandboxPackages(has(['bwrap', 'socat']))).toEqual([]);
    expect(sandboxInstallCommand(has(['dnf', 'apt-get']))).toBe('sudo apt-get install -y bubblewrap socat');
    expect(sandboxInstallCommand(has(['apk']))).toBe('sudo apk add bubblewrap socat');
    expect(sandboxInstallCommand(has([]))).toBeNull();
  });

  test('status on a node says what happens without them, what to run there, and the restart; available stays available', () => {
    expect(nodeSandbox({ available: false, reason: 'the command sandbox on Linux needs bubblewrap installed (then restart Kestrel)' })).toEqual({
      available: false,
      reason: 'bubblewrap and socat were not both installed when the node started. Without them every command of a confined Claude session asks first. Run "kestrel node agents" for the command that installs them, then restart the node: kestrel node stop && kestrel node start',
    });
    expect(nodeSandbox({ available: true })).toEqual({ available: true });
  });
});

describe('how a computer names itself to other devices', () => {
  test('the app as before; a node by its name', () => {
    expect(hereOf('app', 'mac', 'Mac mini')).toBe('your Mac');
    expect(hereOf('app', 'linux', 'box')).toBe('your computer');
    expect(hereOf('node', 'linux', 'Worker node 1')).toBe('Worker node 1');
  });
});
