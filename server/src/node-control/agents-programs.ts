// What `kestrel-node agents` runs, in the terminal: each agent's own programs, found and run in the environment the
// node runs them in (agents/kestrel-agents.ts, `nodeAgentsEnv`), so what the checklist installs is what the node finds.
// Kestrel only runs the programs and reads their answers about themselves (a version, signed in or not, whether a turn
// ran). It opens no credential file, prints nothing an agent's status program printed, and copies nothing: a sign-in
// talks to the person directly, its output passed straight through. An install is npm's, collected: the checklist shows a
// wait line, nothing of npm's on success, and its last lines under a plain sentence when it failed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { signedInFromStatus, claudeProgram } from '../agents/claude/sign-in.ts';
import { findCodex, realLookup as codexLookup } from '../agents/codex/binary.ts';
import { agentsFolder, kestrelAgentDirs, nodeAgentsEnv } from '../agents/kestrel-agents.ts';
import { hostPlatform } from '../host.ts';
import type { Platform } from '../shared/platform.ts';
import { findOpencode, realLookup as opencodeLookup } from '../agents/opencode/binary.ts';
import { opencodeDatabase, opencodeLocks, startGate } from '../agents/opencode/one-at-a-time.ts';
import type { Agent } from '../model.ts';
import type { PinnedAgent } from '../shared/node-agent-versions.ts';
import { codexSignedInFrom, isDataVersionFailure, lastLineOf, lastLinesOf, NODE_AGENT_LABEL, NODE_AGENT_PACKAGE, NODE_CHECK_ARGS, NODE_SIGN_IN_ARGS, NODE_SIGN_IN_STATUS_ARGS, opencodeSignedInFrom, versionFrom } from '../shared/node-agents.ts';

type Env = Record<string, string | undefined>;

/** What a program printed (both outputs) and how it ended. Null code: it could not be started, or ran out of time. */
export interface ProgramOutput {
  code: number | null;
  output: string;
  /** Standard output alone, whole up to `maxOutput`: only when `stdout` was asked for (an API answer read as JSON). */
  stdout?: string;
}

/**
 * Runs a program. `quiet`: its output is collected for Kestrel to read (a version, a status) and never printed.
 * Otherwise it talks to the person: input and output are the terminal's own, and nothing is collected.
 */
export type RunProgram = (file: string, args: readonly string[], options: { env: Env; cwd: string; quiet: boolean; timeoutMs: number; stdout?: { maxBytes: number } }) => Promise<ProgramOutput>;

/** What the checklist knows of one agent here. */
export interface AgentFacts {
  agent: Agent;
  /** The program found, or null when it is not installed. */
  program: string | null;
  version: string | null;
  /** What the agent said when asked; null when it could not say. */
  signedIn: boolean | null;
  /** OpenCode could not open its own database: another OpenCode version made it (`isDataVersionFailure`). */
  dataVersion?: true;
}

/** A database moved aside: the command it was, as shown before the yes. */
export type MoveOutcome = { ok: true } | { ok: false; reason: string };

/** Moving OpenCode's database aside, file by file (the database and the journal files SQLite keeps beside it). */
export interface MoveAside {
  moves: { from: string; to: string }[];
}

export type Outcome = { ok: true } | { ok: false; reason: string };

/** An install: done, or why not and the last lines npm printed. */
export type InstallOutcome = { ok: true } | { ok: false; reason: string; output: string[] };

export interface AgentPrograms {
  /** Kestrel's agents folder, where `install` puts Codex and OpenCode. */
  folder: string;
  facts(agent: Agent): Promise<AgentFacts>;
  /** Installs Codex or OpenCode at `version` into the agents folder with the bundle's npm, its output collected. */
  install(agent: PinnedAgent, version: string): Promise<InstallOutcome>;
  /** The newest version npm knows of, to say when the pin differs; null when npm could not say (offline). */
  newest(agent: PinnedAgent): Promise<string | null>;
  /** Runs the agent's own sign-in in this terminal. Whether it worked is asked afterwards (`facts`). */
  signIn(agent: Agent): Promise<void>;
  /** One short turn in the agent's own non-interactive mode: only on `--check`. */
  check(agent: Agent): Promise<Outcome>;
  /** Where OpenCode's database is here (XDG_DATA_HOME respected; one-at-a-time.ts names it). */
  opencodeDatabase: string;
  /** What moving OpenCode's database aside would move: the database and its journal files that are there, to a free `.old`. */
  moveAsidePlan(): MoveAside;
  /** Moves them, as planned. Only on a yes typed in the terminal, after the command was shown. */
  moveAside(plan: MoveAside): MoveOutcome;
}

/** The journal files SQLite may keep beside a database: moved with it, or a fresh database would read the old journal. */
const DATABASE_FILES = ['', '-wal', '-shm'];

/** The database and the journal files beside it that are there, each to the first free `.old` name (`.old`, `.old-2`…). Pure. */
export function moveAsidePlanOf(database: string, exists: (path: string) => boolean): MoveAside {
  const present = DATABASE_FILES.map((suffix) => database + suffix).filter(exists);
  let mark = '.old';
  for (let n = 2; present.some((from) => exists(from + mark)); n++) mark = `.old-${n}`;
  return { moves: present.map((from) => ({ from, to: from + mark })) };
}

/** The shell command a move is, as the person reads it before saying yes. Pure. */
export const moveCommand = (plan: MoveAside, shown: (path: string) => string): string => plan.moves.map((m) => `mv ${shown(m.from)} ${shown(m.to)}`).join(' && ');

const QUICK_MS = 20_000;
const INSTALL_MS = 10 * 60_000;
/** A sign-in waits on the person signing in on another device. */
const SIGN_IN_MS = 30 * 60_000;
const CHECK_MS = 120_000;
/** How many of npm's last lines a failed install shows. */
const NPM_LINES_SHOWN = 12;

/**
 * npm's arguments for one install: into Kestrel's agents folder only, one exact version, quiet but for errors.
 * `--ignore-scripts`: neither pinned package needs its install script on Linux. `@openai/codex` has none (its launcher
 * finds the program in its per-platform package); `opencode-ai` 1.14's postinstall only hard-links the per-platform
 * program beside its launcher as a shortcut, and the launcher finds it in node_modules without it. Whether the program
 * runs is asked right after (`--version`), so a pin that did need its script says so instead of failing later.
 */
export const npmInstallArgs = (folder: string, pkg: string, version: string): string[] => ['install', '--prefix', folder, '--no-fund', '--no-audit', '--ignore-scripts', '--loglevel=error', `${pkg}@${version}`];

export interface ProgramsContext {
  dataDir: string;
  /** The environment the terminal was started with. */
  env: Env;
  run: RunProgram;
  /** The Node running kestrel-node: the bundle's own, beside its npm. */
  nodeBinary?: string;
  exists?: (path: string) => boolean;
  platform?: Platform;
}

/** The environment and lookup the node itself uses (agents/kestrel-agents.ts), for the terminal. */
export function agentPrograms(ctx: ProgramsContext): AgentPrograms {
  const nodeBinary = ctx.nodeBinary ?? process.execPath;
  const exists = ctx.exists ?? existsSync;
  const platform = ctx.platform ?? hostPlatform();
  const env = nodeAgentsEnv(ctx.env, ctx.dataDir, nodeBinary);
  const dirs = kestrelAgentDirs('node', ctx.dataDir);
  const folder = agentsFolder(ctx.dataDir);
  const find = (agent: Agent): string | null => {
    if (agent === 'claude') return claudeProgram(env, platform, process.arch, exists);
    if (agent === 'codex') return findCodex(env, { ...codexLookup, exists }, platform, dirs);
    return findOpencode(env, { ...opencodeLookup, exists }, platform, dirs);
  };
  // Every OpenCode program goes through the gate the node's own `opencode serve` goes through (one-at-a-time.ts), so the
  // two never start against one database at once.
  const gate = startGate(opencodeLocks(ctx.dataDir));
  const runAs = (agent: Agent, file: string, args: readonly string[], options: { quiet: boolean; timeoutMs: number }) => {
    const run = () => ctx.run(file, args, { env, cwd: folderOrHome(), ...options });
    return agent === 'opencode' ? gate.run(env, run) : run();
  };
  const quietly = (agent: Agent, file: string, args: readonly string[]) => runAs(agent, file, args, { quiet: true, timeoutMs: QUICK_MS });
  const folderOrHome = (): string => (exists(folder) ? folder : (ctx.env.HOME ?? folder));
  const npm = join(dirname(nodeBinary), 'npm');
  // Never global, whatever the person's npm configuration says; no update notice in the collected output.
  const npmEnv: Env = { ...env, npm_config_global: 'false', npm_config_update_notifier: 'false' };

  const signedIn = async (agent: Agent, program: string): Promise<boolean | null> => {
    const said = await quietly(agent, program, NODE_SIGN_IN_STATUS_ARGS[agent]);
    if (said.code === null) return null;
    if (agent === 'claude') return signedInFromStatus(said.output);
    if (agent === 'codex') return codexSignedInFrom(said.output);
    return opencodeSignedInFrom(said.output);
  };

  return {
    folder,
    async facts(agent) {
      const program = find(agent);
      if (!program) return { agent, program: null, version: null, signedIn: null };
      const version = versionFrom((await quietly(agent, program, ['--version'])).output);
      if (agent !== 'opencode') return { agent, program, version, signedIn: await signedIn(agent, program) };
      const said = await quietly(agent, program, NODE_SIGN_IN_STATUS_ARGS[agent]);
      if (isDataVersionFailure(said.output)) return { agent, program, version, signedIn: null, dataVersion: true };
      return { agent, program, version, signedIn: said.code === null ? null : opencodeSignedInFrom(said.output) };
    },
    opencodeDatabase: opencodeDatabase(env),
    moveAsidePlan: () => moveAsidePlanOf(opencodeDatabase(env), exists),
    moveAside(plan) {
      try {
        for (const move of plan.moves) renameSync(move.from, move.to);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `It could not be moved: ${(error as Error).message}.` };
      }
    },
    async install(agent, version) {
      const pkg = NODE_AGENT_PACKAGE[agent];
      if (!pkg) return { ok: false, reason: `${NODE_AGENT_LABEL[agent]} comes with Kestrel's bundle and is not installed on its own. Install the node again.`, output: [] };
      if (!exists(npm)) return { ok: false, reason: `This node's bundle has no npm beside its Node (${npm}). Install the node again.`, output: [] };
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const done = await ctx.run(npm, npmInstallArgs(folder, pkg, version), { env: npmEnv, cwd: folder, quiet: true, timeoutMs: INSTALL_MS });
      if (done.code === 0) return { ok: true };
      const ended = done.code === null ? 'it did not finish in time' : `it ended with exit code ${done.code}`;
      return { ok: false, reason: `npm could not install ${NODE_AGENT_LABEL[agent]} ${version} (${ended}).`, output: lastLinesOf(done.output, NPM_LINES_SHOWN) };
    },
    async newest(agent) {
      const pkg = NODE_AGENT_PACKAGE[agent];
      if (!pkg || !exists(npm)) return null;
      const said = await ctx.run(npm, ['view', pkg, 'version'], { env: npmEnv, cwd: folderOrHome(), quiet: true, timeoutMs: QUICK_MS });
      return said.code === 0 ? versionFrom(said.output) : null;
    },
    async signIn(agent) {
      const program = find(agent);
      if (!program) return;
      // A sign-in waits on the person for minutes, too long to hold the gate: OpenCode's database is made first by its
      // status program, through the gate, and the sign-in then opens a database that exists.
      if (agent === 'opencode') await quietly(agent, program, NODE_SIGN_IN_STATUS_ARGS[agent]);
      await ctx.run(program, NODE_SIGN_IN_ARGS[agent], { env, cwd: folderOrHome(), quiet: false, timeoutMs: SIGN_IN_MS });
    },
    async check(agent) {
      const program = find(agent);
      if (!program) return { ok: false, reason: 'it is not installed' };
      const done = await runAs(agent, program, NODE_CHECK_ARGS[agent], { quiet: true, timeoutMs: CHECK_MS });
      if (done.code === 0) return { ok: true };
      return { ok: false, reason: lastLineOf(done.output) ?? (done.code === null ? 'it did not answer in time' : `it ended with exit code ${done.code}`) };
    },
  };
}

/** Runs a program for real: collected when quiet, else on the person's terminal. Never rejects. */
export const runProgram: RunProgram = (file, args, options) =>
  new Promise((resolve) => {
    let output = '';
    let stdout = '';
    let tooLong = false;
    let settled = false;
    const finish = (result: ProgramOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', ignore);
      resolve(result);
    };
    // Ctrl-C while the person's own program runs is that program's: it ends it, not the checklist.
    const ignore = () => undefined;
    if (!options.quiet) process.on('SIGINT', ignore);
    const child = spawn(file, [...args], { env: options.env as NodeJS.ProcessEnv, cwd: options.cwd, stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    // Decoded as a stream, so a character split between two chunks is read whole.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const whole = (): Pick<ProgramOutput, 'stdout'> => (options.stdout && !tooLong ? { stdout } : {});
    const timer = setTimeout(() => (child.kill('SIGTERM'), finish({ code: null, output, ...whole() })), options.timeoutMs);
    child.stdout?.on('data', (text: string) => {
      output = (output + text).slice(-8000);
      if (!options.stdout || tooLong) return;
      stdout += text;
      // An answer longer than asked for is not read at all, rather than read in part.
      if (Buffer.byteLength(stdout) > options.stdout.maxBytes) (tooLong = true), (stdout = '');
    });
    child.stderr?.on('data', (text: string) => (output = (output + text).slice(-8000)));
    child.once('error', (error) => finish({ code: null, output: error.message }));
    child.once('close', (code) => finish({ code, output, ...whole() }));
  });
