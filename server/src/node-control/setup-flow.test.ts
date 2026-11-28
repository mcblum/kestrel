import { describe, expect, test } from 'vitest';
import type { NodeJoinEvent } from '../shared/node-commands.ts';
import type { AdminRunner, SandboxHere } from '../shared/node-configure.ts';
import { statusFor } from '../shared/node-status-fixture.ts';
import type { NodeStatus } from '../shared/node-status.ts';
import { drawJoin } from './join-draw.ts';
import { PLAIN_JOIN_STYLE, STOPPED_EXIT } from './join-client.ts';
import { answerOf, runSetup, type AdminRun, type SetupDeps } from './setup-flow.ts';

type Status = Parameters<typeof statusFor>[0];

const APT = 'sudo apt-get install -y bubblewrap socat';
const MISSING: SandboxHere = { missing: ['bubblewrap', 'socat'], install: APT };
const PRESENT: SandboxHere = { missing: [], install: APT };

interface MachineOptions {
  /** What each step changes when it runs. */
  effects?: Partial<Record<'join' | 'agents' | 'git' | 'restart', Status>>;
  /** What an administrator has done by the time Enter is pressed at "check again", one entry per press. */
  admin?: (Status & { here?: SandboxHere })[];
  here?: SandboxHere;
  codes?: Partial<Record<'join' | 'agents' | 'git', number>>;
  runner?: AdminRunner;
  /** Whether sudo accepts the password. */
  sudoAccepts?: boolean;
  /** Administrator's commands that fail, by their first word after sudo. */
  fails?: string[];
}

/** A node whose facts change as the steps run, and a log of everything run on it, in order. */
function machine(start: Status | null, { effects = {}, admin = [], here = PRESENT, codes = {}, runner = 'sudo', sudoAccepts = true, fails = [] }: MachineOptions = {}) {
  let facts: Status | null = start;
  let sandbox = here;
  let presses = 0;
  const ran: string[] = [];
  const deps: SetupDeps = {
    status: async (): Promise<NodeStatus | null> => (facts ? statusFor(facts) : null),
    sandboxHere: () => sandbox,
    waitForNode: async () => facts !== null,
    notRunning: async () => 'Service: installed (kestrel-node.service), not running. Start it with "kestrel node start".',
    run: async (command, section) => {
      ran.push(`${command} in ${section}`);
      if (effects[command]) facts = { ...facts, ...effects[command] };
      return codes[command] ?? 0;
    },
    restart: async () => {
      ran.push('restart');
      if (effects.restart) facts = { ...facts, ...effects.restart };
      return { ok: true, line: 'Restarted kestrel-node.service.' };
    },
    adminRunner: () => runner,
    sudoValidate: async () => (ran.push('sudo -v'), sudoAccepts),
    runAdmin: async (argv): Promise<AdminRun> => {
      ran.push(argv.join(' '));
      const program = argv[0] === 'sudo' ? argv[1]! : argv[0]!;
      if (fails.includes(program)) return { ok: false, reason: 'it ended with exit code 100.', output: ['E: Unable to locate package bubblewrap'] };
      if (program === 'loginctl') facts = { ...facts, lingering: 'on' };
      else sandbox = PRESENT;
      return { ok: true, reason: '', output: [] };
    },
  };
  const checked = () => {
    const next = admin[presses++];
    if (!next) return;
    const { here: nowHere, ...rest } = next;
    facts = { ...facts, ...rest };
    if (nowHere) sandbox = nowHere;
  };
  return { deps, ran, checked };
}

/** Runs the setup with typed answers; returns the code and the drawing, each answer after its prompt. */
async function play(m: ReturnType<typeof machine>, answers: (string | null)[], interactive = true) {
  const events: NodeJoinEvent[] = [];
  const typed: string[] = [];
  const prompts: string[] = [];
  let at = 0;
  const code = await runSetup(m.deps, {
    say: (event) => events.push(event),
    ask: async (step, prompt) => {
      events.push({ event: 'ask', step, prompt });
      prompts.push(prompt);
      const answer = at < answers.length ? answers[at++]! : null;
      typed.push(answer ?? '');
      if (prompt.includes('check again')) m.checked();
      return answer;
    },
  }, { interactive });
  const lines = drawJoin(events, PLAIN_JOIN_STYLE, typed);
  return { code, lines, text: lines.join('\n'), flat: lines.join(' ').replace(/\s+/g, ' '), prompts };
}

const FRESH: Status = { inAccount: false, canRun: [], keyIsThere: false, lingering: 'off', sandbox: false };
const SET_UP: Partial<Record<'join' | 'agents' | 'git' | 'restart', Status>> = { join: { inAccount: true }, agents: { canRun: ['claude'] }, git: { keyIsThere: true }, restart: { sandbox: true } };

describe('kestrel node configure: what needs an administrator comes first, offered once', () => {
  test('a fresh node: found and explained, one yes, sudo checks the password, both run and the node restarts before the account', async () => {
    const m = machine(FRESH, { here: MISSING, effects: SET_UP });
    const { code, lines, text, flat, prompts } = await play(m, ['', '', '']);
    expect(code).toBe(0);
    // Everything an administrator does happens before the slow steps, in one go after the one yes.
    expect(m.ran).toEqual(['sudo -v', 'sudo loginctl enable-linger nodeuser', 'sudo apt-get install -y bubblewrap socat', 'restart', 'join in 2', 'agents in 3', 'git in 4']);
    expect(prompts[0]).toBe('Run them now? sudo asks for your password if it needs it. [Y/n] ');
    expect(lines.slice(0, 4)).toEqual(['Kestrel worker node: set up Worker node 1', '', '1  System', '   Lingering is off. Without it the node stops when your last login session ends']);
    expect(flat).toContain('Without them every command of a confined Claude session asks first.');
    expect(text).toContain('   Kestrel can run these now:\n\n       sudo loginctl enable-linger nodeuser\n       sudo apt-get install -y bubblewrap socat\n');
    expect(flat).toContain('Then it restarts the node so it uses the sandbox.');
    expect(text).toContain('   ok: Lingering is on.\n   ok: bubblewrap and socat are in use.');
    expect(text).toContain('2  Account\n   Not in your account yet: sign in and ask to join it.\n   Sign in and join now? [Y/n] ');
    expect(text).toContain('3  Agents');
    expect(text).toContain('4  Git');
    expect(lines.at(-1)).toBe('Next: kestrel node status');
    expect(text).toContain('ok: Worker node 1 is set up.');
    // One summary at most: no list of every step before the work starts.
    expect(text).not.toMatch(/^- /m);
  });

  test('as root: the commands run without sudo, and no password is asked for', async () => {
    const m = machine({ ...FRESH, inAccount: true, canRun: ['claude'], keyIsThere: true }, { here: MISSING, runner: 'root', effects: SET_UP });
    const { text, prompts } = await play(m, ['']);
    expect(m.ran).toEqual(['loginctl enable-linger nodeuser', 'apt-get install -y bubblewrap socat', 'restart']);
    expect(prompts[0]).toBe('Run them now? [Y/n] ');
    expect(text).toContain('       loginctl enable-linger nodeuser\n');
  });

  test('sudo refusing the password changes nothing, says so, and the account steps still run', async () => {
    const m = machine(FRESH, { here: MISSING, sudoAccepts: false, effects: SET_UP });
    const { code, text, flat } = await play(m, ['', '', '']);
    expect(code).toBe(1);
    expect(m.ran).toEqual(['sudo -v', 'join in 2', 'agents in 3', 'git in 4']);
    expect(flat).toContain('sudo did not accept, so nothing was changed. "kestrel node configure" offers this again.');
    expect(text).toContain('Left to do\n\n   Lingering        sudo loginctl enable-linger nodeuser\n   Command sandbox  sudo apt-get install -y bubblewrap socat');
  });

  test('a command that fails: its reason and last lines; the others still run, and no restart without the programs', async () => {
    const m = machine({ ...FRESH, inAccount: true, canRun: ['claude'], keyIsThere: true }, { here: MISSING, fails: ['apt-get'], effects: SET_UP });
    const { code, text, flat } = await play(m, ['']);
    expect(code).toBe(1);
    expect(m.ran).toEqual(['sudo -v', 'sudo loginctl enable-linger nodeuser', 'sudo apt-get install -y bubblewrap socat']);
    expect(flat).toContain('sudo apt-get install -y bubblewrap socat did not finish: it ended with exit code 100. The last lines it printed:');
    expect(text).toContain('E: Unable to locate package bubblewrap');
    expect(text).toContain('ok: Lingering is on.');
    expect(text).toContain('   Command sandbox  sudo apt-get install -y bubblewrap socat');
  });

  test('no sudo: the commands are shown for an administrator, checked again on Enter, then the restart is offered', async () => {
    const m = machine({ ...FRESH, inAccount: true, canRun: ['claude'], keyIsThere: true }, { here: MISSING, runner: 'none', effects: SET_UP, admin: [{}, { lingering: 'on', here: PRESENT }] });
    const { code, text, flat } = await play(m, ['', '', '']);
    expect(code).toBe(0);
    expect(m.ran).toEqual(['restart']);
    expect(flat).toContain('sudo is not installed here, so Kestrel cannot run these. Ask an administrator to run them as root:');
    expect(text).toContain('   Not yet.');
    expect(flat).toContain('Restart the node now so it uses them?');
  });

  test('no sudo, skipped: what is left is listed as root types it, with no sudo in front', async () => {
    const m = machine({ ...FRESH, inAccount: true, canRun: ['claude'], keyIsThere: true }, { here: MISSING, runner: 'none' });
    const { code, text } = await play(m, ['n']);
    expect(code).toBe(1);
    expect(m.ran).toEqual([]);
    expect(text).toContain('Left to do\n\n   Lingering        loginctl enable-linger nodeuser\n   Command sandbox  apt-get install -y bubblewrap socat');
  });

  test('a package manager Kestrel does not know: the packages are named, lingering is still offered', async () => {
    const m = machine({ ...FRESH, inAccount: true, canRun: ['claude'], keyIsThere: true }, { here: { missing: ['socat'], install: null } });
    const { flat, prompts } = await play(m, ['']);
    expect(m.ran).toEqual(['sudo -v', 'sudo loginctl enable-linger nodeuser']);
    expect(flat).toContain("Kestrel does not know this system's package manager. Install bubblewrap and socat with it");
    expect(prompts[0]).toBe('Run it now? sudo asks for your password if it needs it. [Y/n] ');
    expect(flat).not.toContain('restarts the node');
  });

  test('only a restart left (installed after the node started): offered without sudo', async () => {
    const m = machine({ inAccount: true, canRun: ['claude'], sandbox: false }, { effects: SET_UP });
    const { code, text, prompts } = await play(m, ['']);
    expect(code).toBe(0);
    expect(m.ran).toEqual(['restart']);
    expect(prompts).toEqual(['Restart the node now? [Y/n] ']);
    expect(text).toContain('bubblewrap and socat are installed, but the node started before they were.');
  });

  test('skipped: nothing runs, the account steps go on, and the end lists the commands', async () => {
    const m = machine(FRESH, { here: MISSING, effects: SET_UP });
    const { code, text } = await play(m, ['n', '', '']);
    expect(code).toBe(1);
    expect(m.ran).toEqual(['join in 2', 'agents in 3', 'git in 4']);
    expect(text).toContain('Skipped. "kestrel node configure" offers this again.');
    expect(text).toContain('2 steps left. Run "kestrel node configure" again to finish.');
  });
});

describe('kestrel node configure: the account, agents and git', () => {
  test('run again, it offers only what is left: done already is one line, and a node in the account starts at the agents', async () => {
    const m = machine({ ...FRESH, inAccount: true, lingering: 'on', sandbox: true }, { effects: SET_UP });
    const { code, text } = await play(m, []);
    expect(code).toBe(0);
    expect(m.ran).toEqual(['agents in 3', 'git in 4']);
    expect(text).toContain('ok: Already done: System, Account.');
    expect(text).not.toContain('2  Account');
  });

  test('the account can be skipped; the others still run', async () => {
    const m = machine({ ...FRESH, lingering: 'on', sandbox: true }, { effects: SET_UP });
    const { code, text, lines } = await play(m, ['s']);
    expect(code).toBe(1);
    expect(m.ran).toEqual(['agents in 3', 'git in 4']);
    expect(text).toContain('   Skipped. "kestrel node join" does it later.');
    expect(text).toContain('Left to do\n\n   Account  kestrel node join');
    expect(lines.at(-1)).toBe('Next: kestrel node configure');
  });

  test('a node all set up asks nothing', async () => {
    const m = machine({});
    const { code, lines } = await play(m, []);
    expect(code).toBe(0);
    expect(m.ran).toEqual([]);
    expect(lines).toContain('ok: Worker node 1 is set up.');
  });

  test('Ctrl-C in a step, or the keyboard closing, ends the setup there', async () => {
    const stopped = machine({ ...FRESH, lingering: 'on', sandbox: true }, { codes: { join: STOPPED_EXIT } });
    expect((await play(stopped, [''])).code).toBe(STOPPED_EXIT);
    expect(stopped.ran).toEqual(['join in 2']);
    const closed = machine({ ...FRESH }, { here: MISSING });
    expect((await play(closed, [null])).code).toBe(STOPPED_EXIT);
    expect(closed.ran).toEqual([]);
  });

  test('an answer that is not one is asked again, saying what to type', async () => {
    const m = machine({ ...FRESH, lingering: 'on', sandbox: true }, { effects: SET_UP });
    const { text } = await play(m, ['maybe', 'y']);
    expect(text).toContain('Sign in and join now? [Y/n] maybe\n   Press Enter for yes, n to skip, or q to stop.');
    expect(m.ran[0]).toBe('join in 2');
  });
});

describe('kestrel node configure with no terminal', () => {
  test('asks nothing and runs nothing: what is left, each with its command, and kestrel node configure next', async () => {
    const m = machine(FRESH, { here: { missing: ['socat'], install: 'sudo dnf install -y bubblewrap socat' } });
    const { code, lines, text, prompts } = await play(m, [], false);
    expect(code).toBe(1);
    expect(m.ran).toEqual([]);
    expect(prompts).toEqual([]);
    expect(text).toContain('   Lingering        sudo loginctl enable-linger nodeuser');
    expect(text).toContain('   Command sandbox  sudo dnf install -y bubblewrap socat');
    expect(text).toContain('   Account          kestrel node join');
    expect(text.replace(/\s*\n\s*/g, ' ')).toContain('Run "kestrel node configure" in a terminal on this node to do them.');
    expect(lines.at(-1)).toBe('Next: kestrel node configure');
  });

  test('no node answering: it waits, then says why and what to run, and changes nothing', async () => {
    const m = machine(null);
    const { code, text } = await play(m, []);
    expect(code).toBe(1);
    expect(m.ran).toEqual([]);
    expect(text).toContain('Waiting for the node to answer...');
    expect(text.replace(/\s*\n\s*/g, ' ')).toContain('Start it with "kestrel node start".');
  });
});

describe('answerOf', () => {
  test('Enter or y is yes, n or s is no, q or a closed keyboard is stop, anything else is asked again', () => {
    for (const yes of ['', ' ', 'y', 'YES']) expect(answerOf(yes)).toBe('yes');
    for (const no of ['n', 'no', 's', 'skip']) expect(answerOf(no)).toBe('no');
    expect(answerOf('q')).toBe('stop');
    expect(answerOf(null)).toBe('stop');
    expect(answerOf('maybe')).toBeNull();
  });
});
