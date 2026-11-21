// A short title (or a pull request's text, "Create PR → Generated") from the Codex CLI, for a user
// with OpenAI and no Claude. One `codex exec` run:
// read-only sandbox, outside any repository (a fresh temp folder), not saved as a Codex session,
// at low reasoning effort, with no MCP servers started (quiet.ts). A title uses the user's
// configured model; a pull request's text uses the session's model (`--model`) when it has one,
// else the configured model, as a session on the default would. Only the final message is read, from the
// file `--output-last-message` writes. The run is killed if it takes longer than the time limit.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PR_TEXT_INSTRUCTION, PR_TEXT_TIMEOUT_MS } from '../pr-text-request.ts';
import { sleep, TITLE_INSTRUCTION, TITLE_TIMEOUT_MS, titleRequest } from '../title-request.ts';
import { codexEnv, findCodex } from './binary.ts';
import { mcpServerNames, quietArgs, readCodexConfig } from './quiet.ts';

type Env = Record<string, string | undefined>;

/** The part of a child process the title run uses. */
export interface TitleChild {
  readonly stdin: { end(text: string): void; on(event: 'error', listener: (error: Error) => void): unknown } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type Spawn = (command: string, args: readonly string[], options: { cwd: string; env: Env }) => TitleChild;

export interface CodexTitleDeps {
  spawn: Spawn;
  find: () => string | null;
  wait: (ms: number) => Promise<void>;
  env: Env;
  /** The user's codex config.toml (to switch its MCP servers off for this run), or null. */
  readConfig: () => string | null;
}

const realSpawn: Spawn = (command, args, options) => nodeSpawn(command, [...args], { ...options, stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as TitleChild;

const realDeps = (): CodexTitleDeps => ({ spawn: realSpawn, find: () => findCodex(process.env), wait: sleep, env: process.env, readConfig: () => readCodexConfig(process.env) });

const STDERR_TAIL = 300;

/**
 * The `codex exec` arguments: the prompt comes on stdin (`-`), the final message goes to `outFile`;
 * none of `servers` is started. `model` empty or absent leaves the user's configured model.
 */
export const codexArgs = (outFile: string, cwd: string, servers: readonly string[] = [], model?: string): string[] => [
  'exec',
  '--sandbox', 'read-only',
  '--skip-git-repo-check',
  '--ephemeral',
  '--color', 'never',
  // One argument, so a model id can never be read as another option.
  ...(model ? [`--model=${model}`] : []),
  '-c', 'model_reasoning_effort="low"',
  ...quietArgs(servers),
  '--cd', cwd,
  '--output-last-message', outFile,
  '-',
];

/** What Codex is sent: it has no separate system prompt in `exec`, so the instruction leads. */
export const codexPrompt = (prompt: string): string => `${TITLE_INSTRUCTION}\n\n${titleRequest(prompt)}`;

/** Resolves with the exit code and the end of stderr once the child closes; rejects if it cannot run. */
function exited(child: TitleChild): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
}

const readReply = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/**
 * The raw reply to `fullPrompt` from Codex. Null when `codex` is not installed or `timeoutMs`
 * passed (the child is killed); throws when it ran and failed (not signed in, for one).
 */
async function codexAsk(fullPrompt: string, timeoutMs: number, deps: CodexTitleDeps, model?: string): Promise<string | null> {
  const binary = deps.find();
  if (!binary) return null;
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-codex-title-'));
  const outFile = join(dir, 'last-message.txt');
  try {
    const servers = mcpServerNames(deps.readConfig() ?? '');
    const child = deps.spawn(binary, codexArgs(outFile, dir, servers, model), { cwd: dir, env: codexEnv(deps.env, binary) });
    const exit = exited(child);
    exit.catch(() => undefined); // after a timeout nobody awaits it any more
    child.stdin?.on('error', () => undefined); // a child that dies early must not crash the server
    child.stdin?.end(fullPrompt);
    const result = await Promise.race([exit, deps.wait(timeoutMs).then(() => 'timeout' as const)]);
    if (result === 'timeout') {
      child.kill('SIGTERM');
      return null;
    }
    if (result.code !== 0) throw new Error(`codex exited with ${result.code}${result.stderr ? `: ${result.stderr}` : ''}`);
    return readReply(outFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The raw title reply for `prompt` from Codex, or null (not installed, or too slow). */
export function codexTitle(prompt: string, deps: CodexTitleDeps = realDeps()): Promise<string | null> {
  return codexAsk(codexPrompt(prompt), TITLE_TIMEOUT_MS, deps);
}

/**
 * The raw reply to a pull request text request (pr-text-request.ts `prTextRequest`), or null.
 * `model` is the session's; empty or absent leaves the user's configured model.
 */
export function codexPullRequestText(request: string, model?: string, deps: CodexTitleDeps = realDeps()): Promise<string | null> {
  return codexAsk(`${PR_TEXT_INSTRUCTION}\n\n${request}`, PR_TEXT_TIMEOUT_MS, deps, model || undefined);
}
