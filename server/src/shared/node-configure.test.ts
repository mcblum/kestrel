import { describe, expect, test } from 'vitest';
import { EMPTY_GIT_SETTINGS } from './node-git.ts';
import { adminPlanOf, NO_SUDO, nextSetupStep, SETUP_STEPS, setupActionText, setupStepsOf, setupSummary, UNKNOWN_PACKAGE_MANAGER, type SandboxHere } from './node-configure.ts';
import { READY_GIT, statusFor } from './node-status-fixture.ts';
import type { NodeStatus } from './node-status.ts';

const HERE_OK: SandboxHere = { missing: [], install: 'sudo apt-get install -y bubblewrap socat' };
const HERE_MISSING: SandboxHere = { missing: ['bubblewrap', 'socat'], install: 'sudo apt-get install -y bubblewrap socat' };

const todo = (status: NodeStatus, here: SandboxHere = HERE_OK) => setupStepsOf(status, here).filter((s) => !s.done).map((s) => s.id);

describe('setupStepsOf: what is left, from what the node reports', () => {
  test('a node that is all set up has nothing left, in the fixed order', () => {
    const steps = setupStepsOf(statusFor(), HERE_OK);
    expect(steps.map((s) => s.id)).toEqual([...SETUP_STEPS]);
    // Lingering and the sandbox share the System section, drawn first.
    expect(steps.map((s) => s.number)).toEqual([1, 1, 2, 3, 4]);
    expect(steps.every((s) => s.done && s.action === null)).toBe(true);
  });

  test('a fresh node: what needs an administrator first, then join, agents and git', () => {
    const status = statusFor({ inAccount: false, canRun: [], git: EMPTY_GIT_SETTINGS, keyIsThere: false, lingering: 'off', sandbox: false });
    expect(todo(status, HERE_MISSING)).toEqual(['lingering', 'sandbox', 'join', 'agents', 'git']);
    const steps = setupStepsOf(status, HERE_MISSING);
    expect(steps.map((s) => s.action)).toEqual([
      { kind: 'admin', command: 'sudo loginctl enable-linger nodeuser' },
      { kind: 'admin', command: 'sudo apt-get install -y bubblewrap socat' },
      { kind: 'run', command: 'join' },
      { kind: 'run', command: 'agents' },
      { kind: 'run', command: 'git' },
    ]);
    expect(steps.map((s) => setupActionText(s.action!))).toEqual(['sudo loginctl enable-linger nodeuser', 'sudo apt-get install -y bubblewrap socat', 'kestrel node join', 'kestrel node agents', 'kestrel node git']);
  });

  test('a node removed from the account is not in it, and says so', () => {
    const join = setupStepsOf(statusFor({ removed: true }), HERE_OK).find((s) => s.id === 'join');
    expect(join).toMatchObject({ id: 'join', done: false });
    expect(join!.left).toContain('removed from your account');
  });

  test('agents: one that can run is enough; the others are named as optional', () => {
    const agents = (status: NodeStatus) => setupStepsOf(status, HERE_OK).find((s) => s.id === 'agents')!;
    const one = agents(statusFor({ canRun: ['claude'] }));
    expect(one.done).toBe(true);
    expect(one.left).toBe('Claude Code can run. Codex and OpenCode are optional ("kestrel node agents" adds them).');
    expect(agents(statusFor()).left).toBe('Claude Code, Codex and OpenCode can run.');
    const none = agents(statusFor({ canRun: [] }));
    expect(none).toMatchObject({ done: false, action: { kind: 'run', command: 'agents' } });
    expect(none.left).toBe('No agent can run yet. One is enough to start sessions here.');
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
    const missing = setupStepsOf(statusFor({ sandbox: false }), HERE_MISSING)[1]!;
    expect(missing.action).toEqual({ kind: 'admin', command: 'sudo apt-get install -y bubblewrap socat' });
    expect(missing.left).toContain('bubblewrap and socat are not installed');
    const restart = setupStepsOf(statusFor({ sandbox: false }), HERE_OK)[1]!;
    expect(restart.action).toEqual({ kind: 'restart' });
    expect(setupActionText(restart.action!)).toBe('kestrel node stop && kestrel node start');
    // No package manager known: the generic words, never a made-up command.
    const unknown = setupStepsOf(statusFor({ sandbox: false }), { missing: ['socat'], install: null })[1]!;
    expect(unknown.action).toEqual({ kind: 'admin', command: null });
    expect(unknown.left).toContain('socat is not installed');
  });
});

describe('nextSetupStep', () => {
  test('the first step left that this run has not already offered', () => {
    const steps = setupStepsOf(statusFor({ inAccount: false, canRun: [], lingering: 'off' }), HERE_OK);
    expect(nextSetupStep(steps, new Set())?.id).toBe('lingering');
    expect(nextSetupStep(steps, new Set(['lingering']))?.id).toBe('join');
    expect(nextSetupStep(steps, new Set(['lingering', 'join']))?.id).toBe('agents');
    expect(nextSetupStep(steps, new Set(['lingering', 'join', 'agents']))).toBeNull();
  });
});

describe('adminPlanOf: the System section, offered once before the slow steps', () => {
  const fresh = (here: SandboxHere = HERE_MISSING) => setupStepsOf(statusFor({ lingering: 'off', sandbox: false }), here);

  test('nothing needs an administrator: no plan', () => {
    expect(adminPlanOf(setupStepsOf(statusFor(), HERE_OK), 'sudo')).toBeNull();
  });

  test('with sudo: both commands, run through sudo, then a restart for the sandbox; each need says what happens without it', () => {
    const plan = adminPlanOf(fresh(), 'sudo')!;
    expect(plan.commands).toEqual([
      { id: 'lingering', text: 'sudo loginctl enable-linger nodeuser', argv: ['sudo', 'loginctl', 'enable-linger', 'nodeuser'] },
      { id: 'sandbox', text: 'sudo apt-get install -y bubblewrap socat', argv: ['sudo', 'apt-get', 'install', '-y', 'bubblewrap', 'socat'] },
    ]);
    expect(plan.restart).toBe(true);
    expect(plan.canRun).toBe(true);
    expect(plan.needs.map((n) => n.text)).toEqual([expect.stringContaining('Without it the node stops'), expect.stringContaining('Without them every command')]);
  });

  test('as root: the same commands without sudo', () => {
    const plan = adminPlanOf(fresh(), 'root')!;
    expect(plan.commands.map((c) => c.text)).toEqual(['loginctl enable-linger nodeuser', 'apt-get install -y bubblewrap socat']);
    expect(plan.commands[0]!.argv).toEqual(['loginctl', 'enable-linger', 'nodeuser']);
  });

  test('no sudo: shown for an administrator to run as root, never run here', () => {
    const plan = adminPlanOf(fresh(), 'none')!;
    expect(plan.canRun).toBe(false);
    expect(plan.commands.map((c) => c.text)).toEqual(['loginctl enable-linger nodeuser', 'apt-get install -y bubblewrap socat']);
    expect(NO_SUDO).toContain('sudo is not installed');
  });

  test('a package manager Kestrel does not know: lingering is still offered, the packages are named, no restart', () => {
    const plan = adminPlanOf(fresh({ missing: ['bubblewrap', 'socat'], install: null }), 'sudo')!;
    expect(plan.commands.map((c) => c.id)).toEqual(['lingering']);
    expect(plan.cannot).toEqual([UNKNOWN_PACKAGE_MANAGER]);
    expect(plan.restart).toBe(false);
  });

  test('installed after the node started: only a restart, which needs no administrator', () => {
    const plan = adminPlanOf(setupStepsOf(statusFor({ sandbox: false }), HERE_OK), 'none')!;
    expect(plan).toMatchObject({ commands: [], restart: true, canRun: true, cannot: [] });
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
