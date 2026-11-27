import { describe, expect, test } from 'vitest';
import type { NodeJoinEvent } from '../shared/node-commands.ts';
import type { SandboxHere } from '../shared/node-configure.ts';
import { statusFor } from '../shared/node-status-fixture.ts';
import type { NodeStatus } from '../shared/node-status.ts';
import { drawJoin } from './join-draw.ts';
import { PLAIN_JOIN_STYLE, STOPPED_EXIT } from './join-client.ts';
import { runSetup, type SetupDeps } from './setup-flow.ts';

type Status = Parameters<typeof statusFor>[0];

/**
 * A node whose facts change as the steps run: `effects` says what each step changes when it runs, and `admin` what
 * the administrator has done by the time Enter is pressed (one entry per press).
 */
function machine(start: Status | null, { effects = {}, admin = [], here = { missing: [], install: 'sudo apt-get install -y bubblewrap socat' }, codes = {} }: { effects?: Partial<Record<'join' | 'agents' | 'git' | 'restart', Status>>; admin?: (Status & { here?: SandboxHere })[]; here?: SandboxHere; codes?: Partial<Record<'join' | 'agents' | 'git', number>> } = {}) {
  let facts: Status | null = start;
  let sandbox = here;
  let presses = 0;
  const ran: string[] = [];
  const deps: SetupDeps = {
    status: async (): Promise<NodeStatus | null> => (facts ? statusFor(facts) : null),
    sandboxHere: () => sandbox,
    waitForNode: async () => facts !== null,
    notRunning: async () => 'Service: installed (kestrel-node.service), not running. Start it with "kestrel node start".',
    run: async (command) => {
      ran.push(command);
      if (effects[command]) facts = { ...facts, ...effects[command] };
      return codes[command] ?? 0;
    },
    restart: async () => {
      ran.push('restart');
      if (effects.restart) facts = { ...facts, ...effects.restart };
      return { ok: true, line: 'Restarted kestrel-node.service.' };
    },
  };
  /** Pressing Enter at an administrator's step: what they have done by now. */
  const checked = () => {
    const next = admin[presses++];
    if (next) {
      const { here: nowHere, ...rest } = next;
      facts = { ...facts, ...rest };
      if (nowHere) sandbox = nowHere;
    }
  };
  return { deps, ran, checked };
}

/** Runs the setup with typed answers; returns the code and the drawing, each answer after its prompt. */
async function play(m: ReturnType<typeof machine>, answers: (string | null)[], interactive = true) {
  const events: NodeJoinEvent[] = [];
  const typed: string[] = [];
  let at = 0;
  const code = await runSetup(m.deps, {
    say: (event) => events.push(event),
    ask: async (step, prompt) => {
      events.push({ event: 'ask', step, prompt });
      const answer = at < answers.length ? answers[at++]! : null;
      typed.push(answer ?? '');
      if (prompt.includes('check again')) m.checked();
      return answer;
    },
  }, { interactive });
  return { code, lines: drawJoin(events, PLAIN_JOIN_STYLE, typed), text: drawJoin(events, PLAIN_JOIN_STYLE, typed).join('\n') };
}

const FRESH: Status = { inAccount: false, canRun: [], keyIsThere: false, lingering: 'off', sandbox: false };

describe('kestrel node configure', () => {
  test('a fresh node: each step in order, the admin steps shown to paste and checked again, then set up', async () => {
    const m = machine(FRESH, {
      here: { missing: ['bubblewrap', 'socat'], install: 'sudo apt-get install -y bubblewrap socat' },
      effects: { join: { inAccount: true }, agents: { canRun: ['claude', 'codex', 'opencode'] }, git: { keyIsThere: true }, restart: { sandbox: true } },
      // First Enter at lingering: not yet; the second: done. At the sandbox: installed, then a restart.
      admin: [{}, { lingering: 'on' }, { here: { missing: [], install: 'sudo apt-get install -y bubblewrap socat' } }],
    });
    const { code, lines, text } = await play(m, ['', '', '', '', '', '', '']);
    expect(code).toBe(0);
    expect(m.ran).toEqual(['join', 'agents', 'git', 'restart']);
    expect(lines.slice(0, 5)).toEqual([
      'Kestrel worker node: set up Worker node 1',
      '',
      '- Join your account: Not in your account yet: sign in and ask to join it.',
      '- Agents: 0 of 3 agents can run. Claude Code, Codex and OpenCode cannot yet.',
      '- Git: This node has no git key of its own yet.',
    ]);
    expect(text).toMatch(/^- Keep running with nobody logged in: Lingering is off\./m);
    expect(text).toMatch(/^- Command sandbox: bubblewrap and socat are not installed\./m);
    expect(text).toContain('1  Join your account');
    expect(text).toContain('   Press Enter to start (kestrel node join), or s to skip: ');
    // The administrator's command stands on a line of its own, to paste; Kestrel never runs it.
    expect(text).toContain('       sudo loginctl enable-linger nodeuser');
    expect(text).toContain('       sudo apt-get install -y bubblewrap socat');
    expect(text).toContain('   Not yet: Lingering is off.');
    expect(text).toContain('   ok: Lingering is on.');
    expect(text).toContain('   Restart the node now? Its sessions’ turns are ended cleanly first. [Y/n] '.replace('’', "'"));
    expect(lines.at(-1)).toBe('Next: kestrel node status');
    expect(text).toContain('ok: Worker node 1 is set up.');
  });

  test('a step can be skipped; the others still run, and the end names what is left and the command', async () => {
    const m = machine({ ...FRESH, lingering: 'on', sandbox: true }, { effects: { join: { inAccount: true }, git: { keyIsThere: true } } });
    const { code, text, lines } = await play(m, ['', 's', '']);
    expect(code).toBe(1);
    expect(m.ran).toEqual(['join', 'git']);
    expect(text).toContain('   Skipped. "kestrel node agents" does it later.');
    expect(text).toContain('Left: Agents (kestrel node agents).');
    expect(text).toContain('1 step left. Run "kestrel node configure" again to pick up where you left off.');
    expect(lines.at(-1)).toBe('Next: kestrel node configure');
  });

  test('run again, it offers only what the node says is left: a node in the account starts at the agents', async () => {
    const m = machine({ ...FRESH, inAccount: true, lingering: 'on', sandbox: true }, { effects: { agents: { canRun: ['claude', 'codex', 'opencode'] }, git: { keyIsThere: true } } });
    const { code, text } = await play(m, ['', '']);
    expect(code).toBe(0);
    expect(m.ran).toEqual(['agents', 'git']);
    expect(text).toContain('ok: Join your account');
    expect(text).not.toContain('1  Join your account');
    expect(text).toContain('2  Agents');
  });

  test('a node all set up asks nothing', async () => {
    const m = machine({});
    const { code, lines } = await play(m, []);
    expect(code).toBe(0);
    expect(m.ran).toEqual([]);
    expect(lines).toContain('ok: Worker node 1 is set up.');
  });

  test('a step that does not finish is not offered again in the same run, and is listed as left', async () => {
    const m = machine({ ...FRESH, lingering: 'on', sandbox: true, canRun: ['claude', 'codex', 'opencode'], keyIsThere: true });
    const { code, text } = await play(m, ['', '']);
    expect(code).toBe(1);
    expect(m.ran).toEqual(['join']);
    expect(text).toContain('   Not finished. "kestrel node join" picks it up again.');
    expect(text).toContain('Left: Join your account (kestrel node join).');
  });

  test('Ctrl-C in a step, or the keyboard closing, ends the setup there', async () => {
    const stopped = machine({ ...FRESH }, { codes: { join: STOPPED_EXIT } });
    const first = await play(stopped, ['', '']);
    expect(first.code).toBe(STOPPED_EXIT);
    expect(stopped.ran).toEqual(['join']);
    const closed = machine({ ...FRESH });
    const second = await play(closed, [null]);
    expect(second.code).toBe(STOPPED_EXIT);
    expect(closed.ran).toEqual([]);
  });

  test('with no terminal it asks nothing: what is left, each with its command, and kestrel node configure next', async () => {
    const m = machine(FRESH, { here: { missing: ['socat'], install: 'sudo dnf install -y bubblewrap socat' } });
    const { code, lines, text } = await play(m, [], false);
    expect(code).toBe(1);
    expect(m.ran).toEqual([]);
    expect(text).not.toContain('Press Enter');
    expect(text).toContain('       kestrel node join');
    expect(text).toContain('       sudo loginctl enable-linger nodeuser');
    expect(text).toContain('       sudo dnf install -y bubblewrap socat');
    expect(text.replace(/\s*\n\s*/g, ' ')).toContain('Run "kestrel node configure" in a terminal on this node to do them one at a time.');
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
