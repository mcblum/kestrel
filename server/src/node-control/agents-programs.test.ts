// The checklist's programs for real, against stub programs in a temporary HOME: a fake npm beside a fake Node, and
// fake claude, codex and opencode that record how they were called and answer their status commands. No network.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { agentPrograms, runProgram, type ProgramOutput, type RunProgram } from './agents-programs.ts';
import { agentsBin, nodeAgentsEnv, toolsBin } from '../agents/kestrel-agents.ts';
import { hermeticPath, realProgramsOn } from './test-path.ts';

/** A credential each stub keeps in the home folder: Kestrel must never read or print it. */
const SECRET = 'sk-not-a-real-key-0123456789';

let root: string;
let home: string;
let dataDir: string;
let calls: string;
let nodeBin: string;
/** Only the plain tools the stubs use: never a real npm, agent or package manager of the computer running the test. */
let plain: string;

/** A shell script that logs `<name> <args>` and its PATH's first entry, then does `body`. */
function stub(path: string, name: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${calls}"\necho "PATH0 \${PATH%%:*}" >> "${calls}"\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The agents' stubs, each with its sign-in state kept in a file under HOME, as the real ones keep theirs. */
const CODEX = `case "$1 $2" in
  "--version ") echo "codex-cli 0.172.0" ;;
  "login status") if [ -f "$HOME/.codex/auth.json" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi ;;
  "login --device-auth") mkdir -p "$HOME/.codex"; echo '{"token":"${SECRET}"}' > "$HOME/.codex/auth.json"; echo "Enter this code: ABCD-1234" ;;
  "exec --skip-git-repo-check") echo "OK" ;;
esac`;
const OPENCODE = `case "$1 $2" in
  "--version ") echo "1.14.25" ;;
  "auth list") if [ -f "$HOME/.local/share/opencode/auth.json" ]; then printf '●  OpenCode Zen api\\n└  1 credentials\\n'; else echo "└  0 credentials"; fi ;;
  "auth login") mkdir -p "$HOME/.local/share/opencode"; echo '{"key":"${SECRET}"}' > "$HOME/.local/share/opencode/auth.json" ;;
  "run Reply"*) echo "Error: Free usage exceeded" >&2; exit 1 ;;
esac`;
const CLAUDE = `case "$1 $2" in
  "--version ") echo "2.1.322 (Claude Code)" ;;
  "auth status") if [ -f "$HOME/.claude/creds" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","token":"${SECRET}"}'; else echo '{"loggedIn":false,"apiProvider":"firstParty"}'; exit 1; fi ;;
  "auth login") mkdir -p "$HOME/.claude"; echo "${SECRET}" > "$HOME/.claude/creds" ;;
esac`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kn-agents-')));
  home = join(root, 'home');
  dataDir = join(home, '.kestrel');
  calls = join(root, 'calls.log');
  writeFileSync(calls, '');
  plain = hermeticPath(root, []);
  nodeBin = join(dataDir, 'node', 'current', 'node', 'bin');
  mkdirSync(nodeBin, { recursive: true });
  writeFileSync(join(nodeBin, 'node'), '');
  // The bundle's npm: installs a package's program into <prefix>/node_modules/.bin, nothing anywhere else.
  stub(join(nodeBin, 'npm'), 'npm', `prefix=""; pkg=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift ;; -g|--global) echo "global!" >> "${calls}" ;; -*) ;; *) pkg="$1" ;; esac; shift; done
echo "npm_config_global=$npm_config_global" >> "${calls}"
mkdir -p "$prefix/node_modules/.bin"
case "$pkg" in
  @openai/codex@0.172.0) cp "${join(root, 'stubs', 'codex')}" "$prefix/node_modules/.bin/codex" ;;
  opencode-ai@1.14.25) cp "${join(root, 'stubs', 'opencode')}" "$prefix/node_modules/.bin/opencode" ;;
  *) echo "npm warn 1 package has install scripts not yet covered by allowScripts"; echo "added 0 packages in 3s"; echo "npm error code ETARGET" >&2; echo "npm error notarget No matching version found for $pkg." >&2; exit 1 ;;
esac
echo "added 2 packages in 15s"
echo "npm notice New major version of npm available!"`);
  stub(join(root, 'stubs', 'codex'), 'codex', CODEX);
  stub(join(root, 'stubs', 'opencode'), 'opencode', OPENCODE);
  stub(join(root, 'bundle', 'claude'), 'claude', CLAUDE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Everything a program printed, collected even when it would talk to the person (so the test can see it never reaches Kestrel's lines). */
const seen: ProgramOutput[] = [];
beforeEach(() => void (seen.length = 0));
const collecting: RunProgram = async (file, args, options) => {
  const done = await runProgram(file, args, { ...options, quiet: true });
  seen.push(done);
  return done;
};

const programs = () =>
  agentPrograms({
    dataDir,
    env: { HOME: home, PATH: plain, KESTREL_CLAUDE_EXECUTABLE: join(root, 'bundle', 'claude') },
    run: collecting,
    nodeBinary: join(nodeBin, 'node'),
    // Only this test's folder exists: a codex or opencode on this computer is never found.
    exists: (path) => path.startsWith(root) && existsSync(path),
    platform: 'linux',
  });

const log = (): string[] => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);

describe("the agents' programs, as the checklist runs them", () => {
  test('hermetic: the PATH the programs run with reaches no real npm, agent, gh, glab, git or package manager', () => {
    const path = nodeAgentsEnv({ PATH: plain }, dataDir, join(nodeBin, 'node')).PATH!;
    expect(realProgramsOn(path, [agentsBin(dataDir), toolsBin(dataDir), nodeBin])).toEqual([]);
  });

  test('a fresh node: Claude Code from the bundle, the others not installed, none signed in', async () => {
    const p = programs();
    expect(await p.facts('claude')).toEqual({ agent: 'claude', program: join(root, 'bundle', 'claude'), version: '2.1.322', signedIn: false });
    expect(await p.facts('codex')).toEqual({ agent: 'codex', program: null, version: null, signedIn: null });
    expect(await p.facts('opencode')).toEqual({ agent: 'opencode', program: null, version: null, signedIn: null });
  });

  test('installs into Kestrel’s agents folder with the bundle’s npm, never globally, and the node’s lookup finds it there', async () => {
    const p = programs();
    expect(await p.install('codex', '0.172.0')).toEqual({ ok: true });
    expect(await p.install('opencode', '1.14.25')).toEqual({ ok: true });
    const folder = join(dataDir, 'agents');
    // The pinned version exactly, install scripts not run (neither package needs one), only errors printed.
    expect(log().filter((l) => l.startsWith('npm '))).toEqual([
      `npm install --prefix ${folder} --no-fund --no-audit --ignore-scripts --loglevel=error @openai/codex@0.172.0`,
      `npm install --prefix ${folder} --no-fund --no-audit --ignore-scripts --loglevel=error opencode-ai@1.14.25`,
    ]);
    // npm's output is collected, never the person's: its "added 2 packages" and notices go nowhere.
    expect(seen.filter((s) => s.output.includes('added 2 packages'))).toHaveLength(2);
    expect(log()).not.toContain('global!');
    expect(log().filter((l) => l.startsWith('npm_config_global='))).toEqual(['npm_config_global=false', 'npm_config_global=false']);
    // npm and every agent ran with Kestrel's agents folder first on PATH, then the bundle's Node.
    expect(new Set(log().filter((l) => l.startsWith('PATH0 ')))).toEqual(new Set([`PATH0 ${join(folder, 'node_modules', '.bin')}`]));
    expect(await p.facts('codex')).toEqual({ agent: 'codex', program: join(folder, 'node_modules', '.bin', 'codex'), version: '0.172.0', signedIn: false });
    expect(await p.facts('opencode')).toMatchObject({ program: join(folder, 'node_modules', '.bin', 'opencode'), version: '1.14.25', signedIn: false });
    expect(existsSync(join(home, '.npm-global')) || existsSync(join(home, 'node_modules'))).toBe(false);
  });

  test('Claude Code is not installed on its own: it comes with the bundle', async () => {
    expect(await programs().install('claude' as never, '1.0.0')).toMatchObject({ ok: false, reason: expect.stringContaining('comes with Kestrel') });
    expect(log().filter((l) => l.startsWith('npm '))).toEqual([]);
  });

  test("each sign-in is the agent's own, with the arguments that need no browser on the node; signed in is asked of the agent after", async () => {
    const p = programs();
    await p.install('codex', '0.172.0');
    await p.install('opencode', '1.14.25');
    for (const agent of ['claude', 'codex', 'opencode'] as const) await p.signIn(agent);
    expect(log().filter((l) => /^(claude|codex|opencode) (auth login|login)/.test(l))).toEqual(['claude auth login', 'codex login --device-auth', 'opencode auth login']);
    for (const agent of ['claude', 'codex', 'opencode'] as const) expect((await p.facts(agent)).signedIn).toBe(true);
    // Each status is the agent's own command; no credential file is opened by Kestrel.
    expect(log().filter((l) => /(auth status|login status|auth list)/.test(l))).toEqual(expect.arrayContaining(['claude auth status --json', 'codex login status', 'opencode auth list']));
  });

  test('--check runs one short turn in each agent’s own non-interactive mode, and says why one did not run', async () => {
    const p = programs();
    await p.install('codex', '0.172.0');
    await p.install('opencode', '1.14.25');
    expect(await p.check('codex')).toEqual({ ok: true });
    expect(await p.check('opencode')).toEqual({ ok: false, reason: 'Error: Free usage exceeded' });
    expect(log().filter((l) => /^(codex exec|opencode run)/.test(l))).toEqual(['codex exec --skip-git-repo-check Reply with the single word OK.', 'opencode run Reply with the single word OK.']);
  });

  test('nothing an agent keeps or prints about its sign-in reaches what Kestrel says', async () => {
    const p = programs();
    await p.install('codex', '0.172.0');
    await p.install('opencode', '1.14.25');
    for (const agent of ['claude', 'codex', 'opencode'] as const) await p.signIn(agent);
    const facts = await Promise.all((['claude', 'codex', 'opencode'] as const).map((a) => p.facts(a)));
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(JSON.stringify(await p.check('opencode'))).not.toContain(SECRET);
  });

  test('no npm beside the Node: refused with the reason', async () => {
    rmSync(join(nodeBin, 'npm'));
    expect(await programs().install('codex', '0.172.0')).toEqual({ ok: false, reason: `This node's bundle has no npm beside its Node (${join(nodeBin, 'npm')}). Install the node again.`, output: [] });
  });

  test('a failed install says what failed in a sentence, with npm’s last lines', async () => {
    expect(await programs().install('opencode', '9.9.9')).toEqual({
      ok: false,
      reason: 'npm could not install OpenCode 9.9.9 (it ended with exit code 1).',
      output: ['npm warn 1 package has install scripts not yet covered by allowScripts', 'added 0 packages in 3s', 'npm error code ETARGET', 'npm error notarget No matching version found for opencode-ai@9.9.9.'],
    });
  });

  test('the newest version is asked of npm, quietly; null when it cannot say', async () => {
    expect(await programs().newest('codex')).toBeNull();
    expect(log()).toContain('npm view @openai/codex version');
  });
});
