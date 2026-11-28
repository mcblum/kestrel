import { describe, expect, test } from 'vitest';
import type { Agent } from '../model.ts';
import { nodeAgentReason, type NodeAgentProblem } from '../shared/node-agents.ts';
import type { JoinStep, NodeAgentState, NodeJoinEvent } from '../shared/node-commands.ts';
import { agentsPicked, runAgentsChecklist, saidYes, type AgentsOptions, type ChecklistDeps, type SandboxFacts } from './agents-checklist.ts';
import type { AgentFacts } from './agents-programs.ts';
import { drawJoinEvent, JOIN_DRAW_START, type JoinStyle } from './join-draw.ts';

const HOME = '/home/me';
const FOLDER = '/home/me/.kestrel/agents';
const NAME = 'Worker node 1';
const PRETTY: JoinStyle = { plain: false, width: 100 };
const PLAIN: JoinStyle = { plain: true, width: 100 };

/** A machine: what each agent is, what installing and signing in do, what the node says. */
interface Machine {
  facts: Record<Agent, Omit<AgentFacts, 'agent'>>;
  /** Installing works and gives this version. */
  installs?: Partial<Record<Agent, string>>;
  /** What npm says is the newest of each. */
  newest?: Partial<Record<Agent, string>>;
  /** Signing in works. */
  signsIn?: Agent[];
  checks?: Partial<Record<Agent, string | true>>;
  node: ((recheck: readonly Agent[], machine: Machine) => NodeAgentState[]) | null;
  sandbox: SandboxFacts;
  /** OpenCode's database files on disk, while it is one another OpenCode version made. */
  oldDatabase?: string[];
}

const done = (version: string, program = `${FOLDER}/node_modules/.bin/x`): Omit<AgentFacts, 'agent'> => ({ program, version, signedIn: true });

/** The node's answer from what the machine now is: installed and signed in can run, unless `refused`. */
const nodeFrom = (refused: Partial<Record<Agent, NodeAgentProblem>> = {}) => (_: readonly Agent[], m: Machine): NodeAgentState[] =>
  (['claude', 'codex', 'opencode'] as const).map((agent) => {
    const f = m.facts[agent];
    if (refused[agent]) return { agent, canRun: false, why: nodeAgentReason(agent, refused[agent]!, { elsewhere: NAME }), problem: refused[agent]! };
    if (!f.program) return { agent, canRun: false, why: nodeAgentReason(agent, { trouble: 'missing' }, { elsewhere: NAME }), problem: { trouble: 'missing' } };
    if (f.signedIn === false) return { agent, canRun: false, why: nodeAgentReason(agent, { trouble: 'signed-out' }, { elsewhere: NAME }), problem: { trouble: 'signed-out' } };
    return { agent, canRun: true, why: null, problem: null };
  });

function play(machine: Machine, options: AgentsOptions, answers: string[], style: JoinStyle) {
  const lines: string[] = [];
  const calls: string[] = [];
  const rechecks: Agent[][] = [];
  let state = JOIN_DRAW_START;
  const draw = (event: NodeJoinEvent) => {
    const drawn = drawJoinEvent(event, state, style);
    lines.push(...drawn.lines.map((l) => (drawn.toErr ? `! ${l}` : l)));
    state = drawn.state;
    return drawn.prompt;
  };
  const deps: ChecklistDeps = {
    programs: {
      folder: FOLDER,
      facts: async (agent) => ({ agent, ...machine.facts[agent] }),
      install: async (agent, pinned) => {
        calls.push(`install ${agent} ${pinned}`);
        const version = machine.installs?.[agent];
        if (!version) return { ok: false, reason: `npm could not install ${agent === 'codex' ? 'Codex' : 'OpenCode'} ${pinned} (it ended with exit code 1).`, output: ['npm error code ETIMEDOUT', 'npm error network request to the registry failed'] };
        machine.facts[agent] = { program: `${FOLDER}/node_modules/.bin/${agent}`, version: version === 'does not run' ? null : version, signedIn: false };
        return { ok: true };
      },
      newest: async (agent) => machine.newest?.[agent] ?? null,
      signIn: async (agent) => {
        calls.push(`sign in ${agent}`);
        if (machine.signsIn?.includes(agent)) machine.facts[agent] = { ...machine.facts[agent], signedIn: true };
      },
      moveAsidePlan: () => ({ moves: (machine.oldDatabase ?? []).map((from) => ({ from, to: `${from}.old` })) }),
      moveAside: (plan) => {
        calls.push(`move ${plan.moves.map((m) => m.from.split('/').pop()).join(' ')}`);
        machine.oldDatabase = [];
        const { dataVersion: _gone, ...rest } = machine.facts.opencode;
        machine.facts.opencode = { ...rest, signedIn: true };
        return { ok: true };
      },
      check: async (agent) => {
        calls.push(`check ${agent}`);
        const said = machine.checks?.[agent];
        return said === true ? { ok: true } : { ok: false, reason: said ?? 'it ended with exit code 1' };
      },
    },
    pins: { codex: '0.172.0', opencode: '1.14.25' },
    node: async (recheck) => (rechecks.push([...recheck]), machine.node ? machine.node(recheck, machine) : null),
    sandbox: async () => machine.sandbox,
    name: NAME,
    home: HOME,
  };
  const io = {
    say: (event: NodeJoinEvent) => void draw(event),
    ask: async (step: JoinStep, prompt: string) => {
      const shown = draw({ event: 'ask', step, prompt });
      const answer = answers.shift() ?? null;
      lines.push(`${shown}${answer ?? ''}`);
      state = { printed: true, blank: false };
      return answer;
    },
    ran: () => {
      lines.push('<the program’s own output>');
      state = { printed: true, blank: false };
    },
  };
  return { done: runAgentsChecklist(deps, io, options), lines, calls, rechecks };
}

const FRESH = (): Machine => ({
  facts: {
    claude: { program: '/home/me/.kestrel/node/current/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', version: '2.1.322', signedIn: false },
    codex: { program: null, version: null, signedIn: null },
    opencode: { program: null, version: null, signedIn: null },
  },
  installs: { codex: '0.172.0', opencode: '1.14.25' },
  signsIn: ['claude', 'codex'],
  node: nodeFrom(),
  sandbox: { missing: ['bubblewrap', 'socat'], install: 'sudo apt-get install -y bubblewrap socat', nodeHasIt: false },
});

const ALL: AgentsOptions = { only: null, unattended: false, check: false };

describe('kestrel node agents, at a terminal', () => {
  test('a fresh node: which are not ready, one choice of which to set up, then each chosen one done without asking again', async () => {
    const r = play(FRESH(), ALL, ['claude codex'], PRETTY);
    // The chosen two can run: that is ready. OpenCode was left out, and the sandbox is optional: neither fails it.
    expect(await r.done).toBe(0);
    expect(r.lines).toEqual([
      'Kestrel worker node: agents on Worker node 1',
      '',
      'Claude Code, Codex and OpenCode are not set up yet. Each agent is optional: one is enough to start',
      'sessions here.',
      'Setting one up installs it into ~/.kestrel/agents with npm when it is missing, then runs its own',
      'sign-in in this terminal.',
      'Set up which? Enter for all of them, or type names (claude, codex, opencode), or none: claude codex',
      '',
      '1  Claude Code',
      '   ✓ Installed: Claude Code 2.1.322 (comes with Kestrel)',
      '',
      '   Signing in with `claude auth login`. Claude Code prints an address: open it on any device, sign',
      '   in, and paste the code the page gives back here. Kestrel sees none of it.',
      '<the program’s own output>',
      '   ✓ Signed in',
      '',
      '2  Codex',
      '',
      '   Installing Codex 0.172.0 (npm install --prefix ~/.kestrel/agents @openai/codex@0.172.0)…',
      '   ✓ Installed: Codex 0.172.0 (in ~/.kestrel/agents)',
      '',
      "   Signing in with `codex login --device-auth`. Codex prints a code: type it on the provider's",
      '   device page, on any device. Nothing is pasted back here. Kestrel sees none of it.',
      '<the program’s own output>',
      '   ✓ Signed in',
      '',
      '3  Command sandbox (optional)',
      '   bubblewrap and socat are not installed. Without them every command of a confined Claude session',
      '   asks first.',
      '   "kestrel node configure" installs them with sudo and restarts the node. Or an administrator runs',
      '   this, and then you restart the node (kestrel node stop && kestrel node start):',
      '',
      '       sudo apt-get install -y bubblewrap socat',
      '',
      'What Worker node 1 tells your other devices',
      '',
      '✓ Claude Code can run',
      '✓ Codex can run',
      'OpenCode: left out, not set up here.',
      '',
      '✓ Agents on Worker node 1: 2 of 3 can run.',
      '',
      'Next: kestrel node status',
    ]);
    expect(r.calls).toEqual(['sign in claude', 'install codex 0.172.0', 'sign in codex']);
    // The node is told which agents changed here, so it forgets what it knew of them and asks again.
    expect(r.rechecks).toEqual([['claude', 'codex']]);
  });

  test('an agent left out that fails for a real reason still says why, with what to do', async () => {
    const machine: Machine = { ...FRESH(), facts: { ...FRESH().facts, opencode: done('1.14.25') }, node: nodeFrom({ opencode: { trouble: 'out-of-usage', detail: 'Free usage exceeded' } }) };
    const r = play(machine, ALL, ['claude codex'], PRETTY);
    expect(await r.done).toBe(0);
    expect(r.lines.join('\n')).toMatch(/OpenCode's provider refused the last turn.*Run `kestrel node agents`/s);
    expect(r.lines).not.toContain('OpenCode: left out, not set up here.');
  });

  test('a chosen agent that cannot run is a failure, whatever the sandbox', async () => {
    const machine: Machine = { ...FRESH(), signsIn: ['claude'], sandbox: { missing: [], install: null, nodeHasIt: true } };
    const r = play(machine, ALL, ['claude codex'], PRETTY);
    expect(await r.done).toBe(1);
    expect(r.lines).toContain('Codex is not signed in. Run `kestrel node agents`.');
    expect(r.lines).toContain('! Agents on Worker node 1: 1 of 3 can run.');
  });

  test('the same in plain ASCII, as a log or a script reads it', async () => {
    const r = play(FRESH(), ALL, ['claude codex'], PLAIN);
    await r.done;
    const text = r.lines.join('\n');
    expect(text).not.toMatch(/[^\x20-\x7e\n’]/);
    expect(r.lines).toContain('   ok: Installed: Codex 0.172.0 (in ~/.kestrel/agents)');
    expect(r.lines).toContain('   Installing Codex 0.172.0 (npm install --prefix ~/.kestrel/agents @openai/codex@0.172.0)...');
    expect(r.lines).toContain('ok: Claude Code can run');
  });

  test('everything ready: nothing asked and no section per agent, a tick each, exit 0', async () => {
    const machine: Machine = {
      facts: { claude: done('2.1.322', '/b/claude'), codex: done('0.172.0', `${FOLDER}/node_modules/.bin/codex`), opencode: done('1.14.25', `${FOLDER}/node_modules/.bin/opencode`) },
      node: nodeFrom(),
      sandbox: { missing: [], install: 'sudo apt-get install -y bubblewrap socat', nodeHasIt: true },
    };
    const r = play(machine, ALL, [], PRETTY);
    expect(await r.done).toBe(0);
    expect(r.lines).toEqual([
      'Kestrel worker node: agents on Worker node 1',
      '',
      '1  Command sandbox (optional)',
      '   ✓ bubblewrap and socat are installed',
      '',
      'What Worker node 1 tells your other devices',
      '',
      '✓ Claude Code can run',
      '✓ Codex can run',
      '✓ OpenCode can run',
      '',
      '✓ Agents on Worker node 1: 3 of 3 can run.',
      '',
      'Next: kestrel node status',
    ]);
    expect(r.calls).toEqual([]);
    expect(r.rechecks).toEqual([[]]);
  });

  test('signed in is not the same as can run: the node’s answer is shown, and --check spends one turn only when asked', async () => {
    const refusal: NodeAgentProblem = { trouble: 'out-of-usage', detail: 'Free usage exceeded' };
    const machine: Machine = {
      facts: { claude: done('2.1.322'), codex: done('0.172.0'), opencode: done('1.14.25') },
      checks: { opencode: 'Error: Free usage exceeded' },
      node: nodeFrom({ opencode: refusal }),
      sandbox: { missing: [], install: null, nodeHasIt: true },
    };
    const r = play(machine, { only: 'opencode', unattended: false, check: true }, [], PRETTY);
    expect(await r.done).toBe(1);
    expect(r.lines).toEqual([
      'Kestrel worker node: OpenCode on Worker node 1',
      '',
      '1  OpenCode',
      '   ✓ Installed: OpenCode 1.14.25 (in ~/.kestrel/agents)',
      '   ✓ Signed in',
      '',
      '   Checking that OpenCode can run: one short turn, a little of your usage…',
      '',
      '   A turn did not run: Error: Free usage exceeded.',
      '',
      'What Worker node 1 tells your other devices',
      '',
      "OpenCode's provider refused the last turn (Free usage exceeded). Run `kestrel node agents`.",
      '! ',
      '! OpenCode on Worker node 1: not ready yet.',
      '! ',
      '! Next: kestrel node status',
    ]);
    expect(r.calls).toEqual(['check opencode']);
    expect(r.rechecks).toEqual([[]]);
  });

  test('a turn that ran tells the node to forget the refusal it remembered', async () => {
    const machine: Machine = { facts: { claude: done('2.1.322'), codex: done('0.172.0'), opencode: done('1.14.25') }, checks: { codex: true }, node: nodeFrom(), sandbox: { missing: [], install: null, nodeHasIt: true } };
    const r = play(machine, { only: 'codex', unattended: false, check: true }, [], PRETTY);
    expect(await r.done).toBe(0);
    expect(r.lines).toContain('   ✓ A turn ran');
    expect(r.rechecks).toEqual([['codex']]);
  });

  test('no node running: it says so, and how to start it', async () => {
    const machine = { ...FRESH(), node: null };
    const r = play({ ...machine, signsIn: [] }, { only: 'claude', unattended: false, check: false }, [], PRETTY);
    expect(await r.done).toBe(1);
    expect(r.lines.join(' ')).toContain('The node is not running, so it has not said which agents can run. Start it with kestrel node start; then kestrel node status says.');
    expect(r.lines).toContain('   Claude Code still says it is not signed in. Run kestrel node agents claude to try again.');
  });

  test('the sandbox programs installed after the node started: restart it', async () => {
    const machine = { ...FRESH(), sandbox: { missing: [], install: null, nodeHasIt: false } };
    const r = play(machine, ALL, ['none'], PRETTY);
    await r.done;
    expect(r.lines.join('\n')).toContain(['1  Command sandbox (optional)', '   ✓ bubblewrap and socat are installed', '   The node started before they were installed. Restart it to use them:', '', '       kestrel node stop && kestrel node start'].join('\n'));
  });

  test('a package manager Kestrel does not know: the packages are named', async () => {
    const machine = { ...FRESH(), sandbox: { missing: ['bubblewrap'], install: null, nodeHasIt: false } };
    const r = play(machine, ALL, ['none'], PRETTY);
    await r.done;
    expect(r.lines.join(' ')).toContain("bubblewrap is not installed. Without them every command of a confined Claude session asks first.");
    expect(r.lines.join(' ').replace(/\s+/g, ' ')).toContain("Install them with your distribution's package manager (the packages are bubblewrap and socat), then restart the node: kestrel node stop && kestrel node start");
  });

  test('an install npm could not finish: its reason, and the sign-in is not offered', async () => {
    const machine = { ...FRESH(), installs: {} };
    const r = play(machine, { only: 'codex', unattended: false, check: false }, [], PRETTY);
    expect(await r.done).toBe(1);
    const at = r.lines.findIndex((l) => l.includes('Installing Codex'));
    expect(r.lines.slice(at, at + 7)).toEqual([
      '   Installing Codex 0.172.0 (npm install --prefix ~/.kestrel/agents @openai/codex@0.172.0)…',
      '',
      '   npm could not install Codex 0.172.0 (it ended with exit code 1). The last lines it printed:',
      '',
      '       npm error code ETIMEDOUT',
      '       npm error network request to the registry failed',
      '   To try again: kestrel node agents codex',
    ]);
    // Nothing of npm's but its last lines, and those only because it failed.
    expect(r.lines.filter((l) => l.includes('npm error'))).toHaveLength(2);
    expect(r.calls).toEqual(['install codex 0.172.0']);
  });
});

describe('kestrel node agents and the pinned versions', () => {
  test('an agent at another version than the pin is offered the pin; the newest is named when it differs', async () => {
    const machine: Machine = {
      facts: { claude: done('2.1.322'), codex: done('0.180.0', `${FOLDER}/node_modules/.bin/codex`), opencode: { program: null, version: null, signedIn: null } },
      installs: { codex: '0.172.0', opencode: '1.14.25' },
      newest: { codex: '0.180.0', opencode: '1.19.6' },
      node: nodeFrom(),
      sandbox: { missing: [], install: null, nodeHasIt: true },
    };
    const codex = play(machine, { only: 'codex', unattended: false, check: false }, ['y'], PRETTY);
    // Moved to the pin, on its own yes; named on the command line, the new program's sign-in then runs without asking again.
    expect(await codex.done).toBe(1);
    expect(codex.lines.slice(2, 12)).toEqual([
      '1  Codex',
      '   Installed: Codex 0.180.0 (in ~/.kestrel/agents). This Kestrel runs Codex 0.172.0.',
      // Moving down is said before the yes: what the newer one wrote may not open in the older.
      "   0.172.0 is older than the 0.180.0 installed: Codex's own data, written by 0.180.0, may not open",
      '   in 0.172.0.',
      '   Install Codex 0.172.0 into ~/.kestrel/agents with npm? The node uses that one from then on. [y/N]',
      '   > y',
      '   It installs 0.172.0, the version Kestrel was tried with; the newest is 0.180.0. Upgrading the',
      '   node (kestrel upgrade) brings newer pins.',
      '',
      '   Installing Codex 0.172.0 (npm install --prefix ~/.kestrel/agents @openai/codex@0.172.0)…',
    ]);
    expect(codex.calls).toEqual(['install codex 0.172.0', 'sign in codex']);
    const opencode = play(machine, { only: 'opencode', unattended: true, check: false }, [], PLAIN);
    await opencode.done;
    expect(opencode.lines).toContain('   It installs 1.14.25, the version of the OpenCode SDK this Kestrel is built with; the newest is');
    expect(opencode.calls).toEqual(['install opencode 1.14.25']);
  });

  test('declining the move leaves it as it is and says how to move it later', async () => {
    const machine: Machine = { facts: { claude: done('2.1.322'), codex: done('0.160.0'), opencode: done('1.14.25') }, node: nodeFrom(), sandbox: { missing: [], install: null, nodeHasIt: true } };
    const r = play(machine, { only: 'codex', unattended: false, check: false }, ['n'], PRETTY);
    await r.done;
    expect(r.lines).toContain('   Left at 0.160.0. To move it later: kestrel node agents codex');
    expect(r.calls).toEqual([]);
  });

  test('an install whose program then does not run (a pin that needed its install script) says so', async () => {
    const machine: Machine = { facts: { claude: done('2.1.322'), codex: done('0.172.0'), opencode: { program: null, version: null, signedIn: null } }, installs: { opencode: 'does not run' }, node: nodeFrom(), sandbox: { missing: [], install: null, nodeHasIt: true } };
    const r = play(machine, { only: 'opencode', unattended: true, check: false }, [], PRETTY);
    expect(await r.done).toBe(1);
    expect(r.lines).toContain(`   OpenCode 1.14.25 was installed, but its program does not run (it did not say its version). Run`);
    expect(r.lines).not.toContain('   Not signed in.');
  });
});

describe('kestrel node agents with --yes, or with no terminal', () => {
  test('installs what is missing, asks nothing, and prints the sign-in commands instead of running them', async () => {
    const r = play(FRESH(), { only: null, unattended: true, check: false }, [], PLAIN);
    expect(await r.done).toBe(1);
    expect(r.calls).toEqual(['install codex 0.172.0', 'install opencode 1.14.25']);
    expect(r.lines).toEqual([
      'Kestrel worker node: agents on Worker node 1',
      '',
      '1  Claude Code',
      '   ok: Installed: Claude Code 2.1.322 (comes with Kestrel)',
      '   Not signed in.',
      '   To sign in, run kestrel node agents claude in a terminal (it runs `claude auth login` there).',
      '',
      '2  Codex',
      '   Not installed.',
      '',
      '   Installing Codex 0.172.0 (npm install --prefix ~/.kestrel/agents @openai/codex@0.172.0)...',
      '   ok: Installed: Codex 0.172.0 (in ~/.kestrel/agents)',
      '   Not signed in.',
      '   To sign in, run kestrel node agents codex in a terminal (it runs `codex login --device-auth`',
      '   there).',
      '',
      '3  OpenCode',
      '   Not installed.',
      '',
      '   Installing OpenCode 1.14.25 (npm install --prefix ~/.kestrel/agents opencode-ai@1.14.25)...',
      '   ok: Installed: OpenCode 1.14.25 (in ~/.kestrel/agents)',
      '   Not signed in.',
      '   To sign in, run kestrel node agents opencode in a terminal (it runs `opencode auth login` there).',
      '',
      '4  Command sandbox (optional)',
      '   bubblewrap and socat are not installed. Without them every command of a confined Claude session',
      '   asks first.',
      '   "kestrel node configure" installs them with sudo and restarts the node. Or an administrator runs',
      '   this, and then you restart the node (kestrel node stop && kestrel node start):',
      '',
      '       sudo apt-get install -y bubblewrap socat',
      '',
      'What Worker node 1 tells your other devices',
      '',
      'Claude Code is not signed in. Run `kestrel node agents`.',
      'Codex is not signed in. Run `kestrel node agents`.',
      'OpenCode is not signed in. Run `kestrel node agents`.',
      '! ',
      '! Agents on Worker node 1: 0 of 3 can run.',
      '! ',
      '! Next: kestrel node status',
    ]);
    expect(r.rechecks).toEqual([['codex', 'opencode']]);
  });
});

describe('which agents: one choice, every agent optional', () => {
  test('Enter or all is every one offered; none or n is none; names pick those; anything else is asked again', () => {
    const offered = ['codex', 'opencode'] as const;
    for (const all of ['', 'all', ' ALL ']) expect(agentsPicked(all, offered)).toEqual(['codex', 'opencode']);
    for (const none of ['none', 'n', 'no']) expect(agentsPicked(none, offered)).toEqual([]);
    expect(agentsPicked('opencode', offered)).toEqual(['opencode']);
    expect(agentsPicked('opencode, codex', offered)).toEqual(['codex', 'opencode']);
    expect(agentsPicked('claude', offered)).toBeNull();
    expect(agentsPicked('maybe', offered)).toBeNull();
    // With one offered, the question is a yes or no.
    expect(agentsPicked('y', ['codex'])).toEqual(['codex']);
  });

  test('none: nothing is installed or signed in, and how to add one later is said', async () => {
    const r = play(FRESH(), ALL, ['none'], PLAIN);
    expect(await r.done).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.lines).toContain('None set up. To add one later: kestrel node agents');
  });

  test('a wrong answer is said, with what to type, and asked again', async () => {
    const r = play(FRESH(), ALL, ['gemini', 'claude'], PLAIN);
    await r.done;
    expect(r.lines).toContain('Type agent names (claude, codex, opencode), all, or none.');
    expect(r.calls).toEqual(['sign in claude']);
  });

  test('inside kestrel node configure the sandbox is left out: configure dealt with it already', async () => {
    const r = play(FRESH(), { ...ALL, sandbox: false }, ['claude'], PLAIN);
    await r.done;
    expect(r.lines.join('\n')).not.toContain('Command sandbox');
  });

  test('one that can run is enough: the chosen ones ready ends ok, the others optional', async () => {
    const machine = { ...FRESH(), sandbox: { missing: [], install: null, nodeHasIt: true } };
    const r = play(machine, ALL, ['claude'], PLAIN);
    expect(await r.done).toBe(0);
    expect(r.lines).toContain('ok: Agents on Worker node 1: 1 of 3 can run.');
  });
});

describe('saidYes', () => {
  test('y or yes, any case, nothing else', () => {
    for (const yes of ['y', 'Y', 'yes', ' YES ']) expect(saidYes(yes)).toBe(true);
    for (const no of ['', 'n', 'no', 'yep', null]) expect(saidYes(no)).toBe(false);
  });
});

describe('OpenCode’s own database, made by another OpenCode version', () => {
  const DB = '/home/me/.local/share/opencode/opencode.db';
  const machine = (): Machine => ({
    facts: { claude: done('2.1.322'), codex: done('0.172.0'), opencode: { program: `${FOLDER}/node_modules/.bin/opencode`, version: '1.14.25', signedIn: null, dataVersion: true } },
    node: nodeFrom(),
    sandbox: { missing: [], install: null, nodeHasIt: true },
    oldDatabase: [DB, `${DB}-wal`],
  });

  test('says so in plain words, shows the exact move, and moves it only on a yes', async () => {
    const r = play(machine(), { only: 'opencode', unattended: false, check: false }, ['y'], PLAIN);
    expect(await r.done).toBe(0);
    const text = r.lines.join('\n');
    expect(text).toContain("OpenCode's own database was made by a different OpenCode version, and this one cannot open it.");
    expect(text).toContain('mv ~/.local/share/opencode/opencode.db ~/.local/share/opencode/opencode.db.old && mv ~/.local/share/opencode/opencode.db-wal ~/.local/share/opencode/opencode.db-wal.old');
    expect(text).toContain('Move it aside now with that command? [y/N] y');
    expect(text).not.toMatch(/DrizzleError|CREATE TABLE/);
    expect(r.calls).toEqual(['move opencode.db opencode.db-wal']);
  });

  test('a no, or --yes, leaves it where it is: Kestrel does not move OpenCode’s data on its own', async () => {
    const no = play(machine(), { only: 'opencode', unattended: false, check: false }, ['n'], PLAIN);
    expect(await no.done).toBe(1);
    expect(no.calls).toEqual([]);
    const unattended = play(machine(), { only: 'opencode', unattended: true, check: false }, [], PLAIN);
    expect(await unattended.done).toBe(1);
    expect(unattended.calls).toEqual([]);
    expect(unattended.lines.join('\n')).toContain('Run `kestrel node agents opencode`: it offers to move ~/.local/share/opencode/opencode.db aside');
  });

  test('when the node is the one that cannot open it, the move is offered there and the node asked again', async () => {
    const m: Machine = { ...machine(), facts: { ...machine().facts, opencode: done('1.14.25', `${FOLDER}/node_modules/.bin/opencode`) } };
    let refusing = true;
    m.node = (recheck, mm) => {
      if (recheck.includes('opencode') && mm.oldDatabase?.length === 0) refusing = false;
      return nodeFrom(refusing ? { opencode: { trouble: 'data-version', database: '~/.local/share/opencode/opencode.db' } } : {})(recheck, mm);
    };
    const r = play(m, { only: 'opencode', unattended: false, check: false }, ['y'], PLAIN);
    expect(await r.done).toBe(0);
    expect(r.calls).toEqual(['move opencode.db opencode.db-wal']);
    expect(r.rechecks).toEqual([[], ['opencode']]);
    expect(r.lines.join('\n')).toContain('OpenCode can run');
  });
});
