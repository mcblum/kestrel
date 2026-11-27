import { describe, expect, test } from 'vitest';
import { EMPTY_GIT_SETTINGS } from './node-git.ts';
import { nextSetupStep, SETUP_STEPS, setupActionText, setupStepsOf, setupSummary, type SandboxHere } from './node-configure.ts';
import { READY_GIT, statusFor } from './node-status-fixture.ts';
import type { NodeStatus } from './node-status.ts';

const HERE_OK: SandboxHere = { missing: [], install: 'sudo apt-get install -y bubblewrap socat' };
const HERE_MISSING: SandboxHere = { missing: ['bubblewrap', 'socat'], install: 'sudo apt-get install -y bubblewrap socat' };

const todo = (status: NodeStatus, here: SandboxHere = HERE_OK) => setupStepsOf(status, here).filter((s) => !s.done).map((s) => s.id);

describe('setupStepsOf: what is left, from what the node reports', () => {
  test('a node that is all set up has nothing left, in the fixed order', () => {
    const steps = setupStepsOf(statusFor(), HERE_OK);
    expect(steps.map((s) => s.id)).toEqual([...SETUP_STEPS]);
    expect(steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.every((s) => s.done && s.action === null)).toBe(true);
  });

  test('a fresh node: join, agents, git, lingering and the sandbox are all left', () => {
    const status = statusFor({ inAccount: false, canRun: [], git: EMPTY_GIT_SETTINGS, keyIsThere: false, lingering: 'off', sandbox: false });
    expect(todo(status, HERE_MISSING)).toEqual(['join', 'agents', 'git', 'lingering', 'sandbox']);
    const steps = setupStepsOf(status, HERE_MISSING);
    expect(steps.map((s) => s.action)).toEqual([
      { kind: 'run', command: 'join' },
      { kind: 'run', command: 'agents' },
      { kind: 'run', command: 'git' },
      { kind: 'admin', command: 'sudo loginctl enable-linger nodeuser' },
      { kind: 'admin', command: 'sudo apt-get install -y bubblewrap socat' },
    ]);
    expect(steps.map((s) => setupActionText(s.action!))).toEqual(['kestrel node join', 'kestrel node agents', 'kestrel node git', 'sudo loginctl enable-linger nodeuser', 'sudo apt-get install -y bubblewrap socat']);
  });

  test('a node removed from the account is not in it, and says so', () => {
    const [join] = setupStepsOf(statusFor({ removed: true }), HERE_OK);
    expect(join).toMatchObject({ id: 'join', done: false });
    expect(join!.left).toContain('removed from your account');
  });

  test('agents: done only when every agent can run, naming the ones that cannot', () => {
    const agents = setupStepsOf(statusFor({ canRun: ['claude'] }), HERE_OK)[1]!;
    expect(agents.done).toBe(false);
    expect(agents.left).toBe('1 of 3 agents can run. Codex and OpenCode cannot yet.');
  });

  test('git: done once the key is made and nothing is left at the hosts checked', () => {
    expect(todo(statusFor({ keyIsThere: false }))).toEqual(['git']);
    expect(todo(statusFor({ git: { ...READY_GIT, name: null } }))).toEqual(['git']);
    expect(todo(statusFor({ git: { ...READY_GIT, hosts: { 'github.com': { answer: 'not-added', at: 1 } } } }))).toEqual(['git']);
    // A node older than `setup` sends no count: its key made is enough.
    const old = statusFor();
    const { left: _left, ...git } = old.git;
    expect(todo({ ...old, git })).toEqual([]);
  });

  test('lingering: off is left for an administrator; unknown (no systemd) is not a step to do', () => {
    expect(todo(statusFor({ lingering: 'off' }))).toEqual(['lingering']);
    expect(todo(statusFor({ lingering: 'unknown' }))).toEqual([]);
  });

  test('the sandbox: missing programs are an administrator’s; present but not in use is a restart', () => {
    const missing = setupStepsOf(statusFor({ sandbox: false }), HERE_MISSING)[4]!;
    expect(missing.action).toEqual({ kind: 'admin', command: 'sudo apt-get install -y bubblewrap socat' });
    expect(missing.left).toContain('bubblewrap and socat are not installed');
    const restart = setupStepsOf(statusFor({ sandbox: false }), HERE_OK)[4]!;
    expect(restart.action).toEqual({ kind: 'restart' });
    expect(setupActionText(restart.action!)).toBe('kestrel node stop && kestrel node start');
    // No package manager known: the generic words, never a made-up command.
    const unknown = setupStepsOf(statusFor({ sandbox: false }), { missing: ['socat'], install: null })[4]!;
    expect(unknown.action).toEqual({ kind: 'admin', command: null });
    expect(unknown.left).toContain('socat is not installed');
  });
});

describe('nextSetupStep', () => {
  test('the first step left that this run has not already offered', () => {
    const steps = setupStepsOf(statusFor({ inAccount: false, canRun: [], lingering: 'off' }), HERE_OK);
    expect(nextSetupStep(steps, new Set())?.id).toBe('join');
    expect(nextSetupStep(steps, new Set(['join']))?.id).toBe('agents');
    expect(nextSetupStep(steps, new Set(['join', 'agents']))?.id).toBe('lingering');
    expect(nextSetupStep(steps, new Set(['join', 'agents', 'lingering']))).toBeNull();
  });
});

describe('setupSummary: the overview’s one line', () => {
  test('a node all set up', () => {
    expect(setupSummary(statusFor(), HERE_OK)).toBe('Worker node 1 (Kestrel 0.0.35): in your account and connected; 3 of 3 agents can run; set up.');
  });

  test('a fresh node names the step count and the command', () => {
    expect(setupSummary(statusFor({ inAccount: false, canRun: [], lingering: 'off' }), HERE_OK)).toBe('Worker node 1 (Kestrel 0.0.35): not in your account; 0 of 3 agents can run; 3 setup steps left: run "kestrel node configure".');
  });

  test('no node answering', () => {
    expect(setupSummary(null, HERE_OK)).toBe('No node answers here. "kestrel node status" says why, and "kestrel node start" starts it.');
  });
});
