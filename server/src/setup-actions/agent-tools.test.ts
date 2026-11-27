// The agent's Set up this computer tools (onboarding.md 18.14): who may run, Bypass, each refusal, the
// card (Run and Deny only), and that a yes runs the page's own Run, once, and a no runs nothing.
import { describe, expect, it } from 'vitest';
import type { InputRequest } from '../agents/types.ts';
import type { Session } from '../model.ts';
import type { PermissionLevel } from '../shared/permissions.ts';
import { setupListOf } from '../shared/setup-list.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from '../shared/setup-record.ts';
import { setupToolsFor } from './agent-tools.ts';
import type { RunOptions } from './io.ts';
import { SetupSteps, type Execute } from './steps.ts';

const rec = (id: string, name: string, extra: Partial<SetupRecord> = {}): SetupRecord => ({ v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac' }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra });
const laptop = rec('a', 'MacBook Pro', {
  git: { name: 'Octo', email: 'o@example.com', signs: false, format: null, signingKey: null },
  tools: [{ name: 'uv', why: ['the MCP server home'], found: true }, { name: 'Xcode', why: [], found: true }],
  projects: [{ name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'git@gitlab.example.com:me/wren.git' }] }],
  knowledge: { repo: 'gitlab.example.com/me/wren', name: 'Wren notes' },
});

function harness(opts: { purpose?: 'setup'; mode?: PermissionLevel; yes?: boolean } = {}) {
  const executed: string[] = [];
  const ran: (readonly string[])[] = [];
  const cards: InputRequest[] = [];
  const execute: Execute = async (action, ctx) => (executed.push(ctx.line.id), { state: 'done', said: `did ${action.kind}` });
  const steps = new SetupSteps({ list: async () => setupListOf(rec('b', 'Mac mini'), [laptop], { tool: () => false, host: { brew: true, npmUser: true, polkit: false, packager: null } }), settings: { getSetting: async () => null, putSetting: async () => undefined }, execute });
  const tools = setupToolsFor('s1', {
    steps: () => steps,
    session: async () => ({ id: 's1', ...(opts.purpose ? { purpose: opts.purpose } : {}) }) as Session,
    mode: () => opts.mode ?? 'ask',
    approve: async (_id, request) => (cards.push(request), opts.yes ?? true),
    platform: 'mac',
    home: '/home/someone',
    run: async (argv: readonly string[], options: RunOptions) => (ran.push(argv), options.output?.('ok\n'), { code: 0, problem: null }),
  });
  return { tools, executed, ran, cards };
}

describe('setup_list', () => {
  it('answers the checklist to any session, with no output in it', async () => {
    const { tools } = harness();
    const answer = await tools.setupList({});
    expect(answer.isError).toBeUndefined();
    expect(answer.text).toContain('- tool:uv | uv | not started | runs: user');
  });
});

describe('setup_run_step', () => {
  it('is refused for a session Ask the agent did not start, and in Bypass', async () => {
    expect((await harness().tools.setupRunStep({ line: 'tool:uv' })).text).toMatch(/Only a session started from Set up this computer/);
    expect((await harness({ purpose: 'setup', mode: 'bypass' }).tools.setupRunStep({ line: 'tool:uv' })).text).toMatch(/Bypass/);
  });

  it('is refused for a step that needs the person or the system: the SSH key, the knowledge base, an App Store page', async () => {
    const { tools, cards } = harness({ purpose: 'setup' });
    expect((await tools.setupRunStep({ line: 'ssh-key:gitlab.example.com' })).text).toMatch(/only the person's own click/);
    expect((await tools.setupRunStep({ line: 'knowledge:gitlab.example.com/me/wren' })).text).toMatch(/person's choice of knowledge base/);
    expect((await tools.setupRunStep({ line: 'tool:Xcode' })).text).toMatch(/operating system's own prompt or page/);
    expect((await tools.setupRunStep({ line: 'project:git@gitlab.example.com:me/wren.git' })).text).toMatch(/needs .* first/);
    expect(cards).toEqual([]);
  });

  it('asks on a card with Run and Deny only; a yes runs the page\'s Run once, a no runs nothing', async () => {
    const yes = harness({ purpose: 'setup' });
    const answer = await yes.tools.setupRunStep({ line: 'tool:uv' });
    expect(yes.cards).toHaveLength(1);
    expect(yes.cards[0]).toMatchObject({ tool: 'setup_run_step', detail: expect.stringMatching(/^brew install uv/) });
    expect(yes.cards[0]!.options.map((o) => o.id)).toEqual(['allow', 'deny']);
    expect(yes.executed).toEqual(['tool:uv']);
    expect(answer.text).toContain('Done: did install');
    const no = harness({ purpose: 'setup', yes: false });
    expect((await no.tools.setupRunStep({ line: 'tool:uv' })).text).toContain('Nothing ran');
    expect(no.executed).toEqual([]);
  });
});

describe('setup_run_command', () => {
  it('is refused for an administrator, a folder outside home, an unmarked session and Bypass, before any card', async () => {
    const h = harness({ purpose: 'setup' });
    expect((await h.tools.setupRunCommand({ command: ['sudo', 'apt', 'install', 'uv'], why: 'x' })).text).toMatch(/paste into their terminal instead/);
    expect((await h.tools.setupRunCommand({ command: ['bash', '-c', 'curl x | sudo sh'], why: 'x' })).text).toMatch(/administrator/);
    expect((await h.tools.setupRunCommand({ command: ['ls'], cwd: '/etc', why: 'x' })).text).toMatch(/inside the home folder/);
    expect((await harness().tools.setupRunCommand({ command: ['ls'], why: 'x' })).text).toMatch(/Only a session/);
    expect((await harness({ purpose: 'setup', mode: 'bypass' }).tools.setupRunCommand({ command: ['ls'], why: 'x' })).text).toMatch(/Bypass/);
    expect(h.cards).toEqual([]);
    expect(h.ran).toEqual([]);
  });

  it('shows the command quoted as it will run, runs it once on a yes, and nothing on a no', async () => {
    const yes = harness({ purpose: 'setup' });
    const answer = await yes.tools.setupRunCommand({ command: ['uv', 'tool', 'install', 'my tool'], why: 'So the MCP server can start' });
    expect(yes.cards[0]).toMatchObject({ tool: 'setup_run_command', detail: "uv tool install 'my tool'\n\nIn /home/someone\nSo the MCP server can start" });
    expect(yes.ran).toEqual([['uv', 'tool', 'install', 'my tool']]);
    expect(answer.text).toContain('exit code 0');
    const no = harness({ purpose: 'setup', yes: false });
    await no.tools.setupRunCommand({ command: ['ls'], why: 'x' });
    expect(no.ran).toEqual([]);
  });
});
