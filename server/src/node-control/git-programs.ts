// What `kestrel node git` runs, in the terminal (git-checklist.ts): `ssh-keygen` to make the node's key and read
// fingerprints, `ssh -T` to test the key at a host with Kestrel's own known hosts, and `gh` and `glab`: installed into
// Kestrel's tools folder at their pins (git-tools-install.ts), signed in by their own sign-in with the person's
// terminal, asked whether they are signed in (by exit code only), and used for three read-only API calls (the key
// list, the signing key list, the verified addresses) and to add the key. Every other program's output is collected and
// read, never passed through. Only the public half of the key is ever read; the private half is written by ssh-keygen
// into Kestrel's folder, mode 600, and never opened by Kestrel. No credential file is opened and no token is read:
// a tool's sign-in is the tool's own. Nothing in ~/.ssh or the user's git configuration is read or written.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { toolsBin, toolsFolder } from '../agents/kestrel-agents.ts';
import { lastLineOf } from '../shared/node-agents.ts';
import { fingerprintFrom, hostKeysFrom, sshAnswerOf, sshTestArgs } from '../shared/node-git-hosts.ts';
import { addKeyCommand, apiArgs, authStatusArgs, signInArgs, signInEnv, toolVersionFrom, type GitTool, type KeyUse, type ToolPins } from '../shared/node-git-tools.ts';
import { nodeGitPaths, nodeGitSettingsText, parseNodeGitSettings, sshOptions, type HostAnswer, type NodeGitPaths, type NodeGitSettings, type ToolState } from '../shared/node-git.ts';
import type { RunProgram } from './agents-programs.ts';
import { installTool, toolPath, type ToolInstall } from './git-tools-install.ts';

type Env = Record<string, string | undefined>;

export type GitOutcome = { ok: true } | { ok: false; reason: string };
export type ApiAnswer = { ok: true; json: unknown } | { ok: false; reason: string };

/** What one test of the key at a host found. */
export interface HostTest {
  answer: HostAnswer;
  detail: string | null;
  /** Host keys taken into Kestrel's known hosts by this test, with their fingerprints. */
  accepted: { type: string; fingerprint: string }[];
}

export interface GitPrograms {
  paths: NodeGitPaths;
  /** Kestrel's tools folder, where gh and glab are installed. */
  toolsFolder: string;
  /** Whether a program is on the PATH the checklist runs with (Kestrel's tools folder first). */
  has(program: string): boolean;
  readSettings(): NodeGitSettings;
  writeSettings(settings: NodeGitSettings): void;
  /** The key's public half, one line, or null when there is no key. */
  publicKey(): string | null;
  /** Makes the key (ed25519, no passphrase: nobody is there to type one) unless it is there; answers its fingerprint. */
  makeKey(comment: string): Promise<{ ok: true; fingerprint: string; made: boolean } | { ok: false; reason: string }>;
  test(host: string): Promise<HostTest>;
  /** Where the tool is (Kestrel's or elsewhere), its version, and the hosts it is signed in to, by exit code. */
  tool(tool: GitTool, hosts: readonly string[]): Promise<ToolState>;
  /** Installs the tool at its pin into Kestrel's tools folder. */
  install(tool: GitTool): Promise<ToolInstall>;
  /** The tool's own sign-in, with the person's terminal; true when it ended well. Kestrel sees nothing it says. */
  signIn(tool: GitTool, host: string, signing: boolean): Promise<boolean>;
  /** A read-only API call (`<tool> api --hostname <host> <path>`), its JSON answer. */
  api(tool: GitTool, host: string, path: string): Promise<ApiAnswer>;
  addKey(tool: GitTool, host: string, title: string, use: KeyUse): Promise<GitOutcome>;
}

export interface GitProgramsContext {
  dataDir: string;
  /** The terminal's environment, for its PATH and the tools' own configuration in the home folder. */
  env: Env;
  run: RunProgram;
  pins: ToolPins;
  /** The machine's architecture as Node names it (`process.arch`). */
  arch: string;
  /** For tests: where an archive's bytes come from. */
  fetch?: (url: string) => Promise<Buffer>;
}

const QUICK_MS = 20_000;
const SSH_MS = 30_000;
/** A sign-in waits for the person on another device. */
const SIGN_IN_MS = 15 * 60_000;
/** An API answer longer than this is not read. */
const API_MAX_BYTES = 1_000_000;
const PRIVATE = 0o600;
const PRIVATE_FOLDER = 0o700;

export function gitPrograms(ctx: GitProgramsContext): GitPrograms {
  const paths = nodeGitPaths(ctx.dataDir);
  const bin = toolsBin(ctx.dataDir);
  const PATH = [bin, ...(ctx.env.PATH ?? '').split(delimiter).filter((d) => d && d !== bin)].join(delimiter);
  // What the tools are run with to read and add: nothing asks a person who is not there, nothing is paged.
  const asking: Env = { ...ctx.env, PATH, NO_COLOR: '1', PAGER: 'cat', GH_PAGER: 'cat', GLAB_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1', GLAB_CHECK_UPDATE: 'false' };
  const env: Env = { ...asking, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1' };
  const run = (file: string, args: readonly string[], extra: Env = {}, timeoutMs = QUICK_MS) => ctx.run(file, args, { env: { ...env, ...extra }, cwd: ctx.dataDir, quiet: true, timeoutMs });
  const has = (program: string): boolean => PATH.split(delimiter).some((dir) => existsSync(join(dir, program)));
  const folder = () => {
    mkdirSync(paths.folder, { recursive: true, mode: PRIVATE_FOLDER });
    chmodSync(paths.folder, PRIVATE_FOLDER);
  };
  const known = async (host: string): Promise<boolean> => existsSync(paths.knownHosts) && (await run('ssh-keygen', ['-F', host, '-f', paths.knownHosts])).code === 0;
  const fingerprint = async (): Promise<string | null> => fingerprintFrom((await run('ssh-keygen', ['-l', '-f', paths.publicKey])).output);

  return {
    paths,
    toolsFolder: toolsFolder(ctx.dataDir),
    has,
    readSettings: () => parseNodeGitSettings(existsSync(paths.settings) ? readFileSync(paths.settings, 'utf8') : null),
    writeSettings(settings) {
      folder();
      const next = `${paths.settings}.${process.pid}`;
      writeFileSync(next, nodeGitSettingsText(settings), { mode: PRIVATE });
      renameSync(next, paths.settings);
    },
    publicKey: () => (existsSync(paths.publicKey) ? readFileSync(paths.publicKey, 'utf8').trim().split('\n')[0]! : null),
    async makeKey(comment) {
      if (existsSync(paths.key) && existsSync(paths.publicKey)) {
        chmodSync(paths.key, PRIVATE);
        const found = await fingerprint();
        return found ? { ok: true, fingerprint: found, made: false } : { ok: false, reason: `The key in ${paths.folder} could not be read by ssh-keygen.` };
      }
      if (!has('ssh-keygen')) return { ok: false, reason: 'ssh-keygen is not installed here. An administrator installs it with the openssh-client package (openssh on some systems).' };
      if (existsSync(paths.key)) return { ok: false, reason: `${paths.key} is there without its public half. Move it away, then run kestrel node git again.` };
      folder();
      const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', paths.key]);
      if (made.code !== 0 || !existsSync(paths.key)) return { ok: false, reason: `ssh-keygen could not make the key: ${lastLineOf(made.output) ?? `it ended with exit code ${made.code}`}.` };
      chmodSync(paths.key, PRIVATE);
      const found = await fingerprint();
      return found ? { ok: true, fingerprint: found, made: true } : { ok: false, reason: 'ssh-keygen made the key but could not say its fingerprint.' };
    },
    async test(host) {
      folder();
      const before = await known(host);
      const said = await run('ssh', sshTestArgs(sshOptions(paths, 'accept-new'), host), {}, SSH_MS);
      if (existsSync(paths.knownHosts)) chmodSync(paths.knownHosts, PRIVATE);
      const accepted = !before && (await known(host)) ? hostKeysFrom((await run('ssh-keygen', ['-l', '-F', host, '-f', paths.knownHosts])).output) : [];
      return { ...sshAnswerOf(said.code, said.output), accepted };
    },
    async tool(tool, hosts) {
      if (!has(tool)) return { installed: false };
      const version = toolVersionFrom((await run(tool, ['--version'])).output);
      const answers = await Promise.all(hosts.map(async (host) => [host, (await run(tool, authStatusArgs(tool, host))).code === 0] as const));
      return {
        installed: true,
        by: existsSync(toolPath(ctx.dataDir, tool)) ? 'kestrel' : 'elsewhere',
        ...(version ? { version } : {}),
        signedIn: answers.filter(([, yes]) => yes).map(([h]) => h),
        notSignedIn: answers.filter(([, yes]) => !yes).map(([h]) => h),
      };
    },
    install: (tool) => installTool(tool, { dataDir: ctx.dataDir, pins: ctx.pins, arch: ctx.arch, env, run: ctx.run, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) }),
    async signIn(tool, host, signing) {
      // The person's terminal, and the tool's own prompts: this is the one run that may ask.
      const done = await ctx.run(tool, signInArgs(tool, host, signing), { env: { ...asking, ...signInEnv(tool) }, cwd: ctx.dataDir, quiet: false, timeoutMs: SIGN_IN_MS });
      return done.code === 0;
    },
    async api(tool, host, path) {
      const done = await ctx.run(tool, apiArgs(host, path), { env, cwd: ctx.dataDir, quiet: true, timeoutMs: QUICK_MS, stdout: { maxBytes: API_MAX_BYTES } });
      if (done.code !== 0) return { ok: false, reason: `${tool} could not read ${path} at ${host}: ${lastLineOf(done.output) ?? (done.code === null ? 'it did not answer in time' : `it ended with exit code ${done.code}`)}` };
      try {
        return { ok: true, json: JSON.parse(done.stdout ?? '') as unknown };
      } catch {
        return { ok: false, reason: `${tool} answered ${path} at ${host} with something that is not JSON.` };
      }
    },
    async addKey(tool, host, title, use) {
      const command = addKeyCommand(tool, host, paths.publicKey, title, use);
      const done = await run(command.file, command.args, command.env);
      if (done.code === 0) return { ok: true };
      return { ok: false, reason: `${tool} could not add the key at ${host}: ${lastLineOf(done.output) ?? `it ended with exit code ${done.code}`}` };
    },
  };
}
