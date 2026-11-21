// Creating a pull request from a session's branch, in three steps the New PR form calls through
// create-api.ts: check what the form sent (`validatePRForm`), find the default branch and, for
// "Generated", the text to fill the form with (`preparePR`), and push the branch and open the pull
// request (`publishPR`). "Generated" describes the session's own commits: those after the commit the
// session's branch started from (`branch.<name>.kestrelbase`, git.ts), not the ones it inherited from
// the checkout it started on; `preparePR` also counts those inherited commits for the form's note. The host's own commands (gh for GitHub, glab for GitLab) come in as a
// `HostCommands` (types.ts); git is the same for both. Every command goes through the injected
// runner, never a shell, so tests never push or call gh or glab.
import type { PRMaterial } from '../agents/pr-text-request.ts';
import type { TitleProvider } from '../agents/title-providers.ts';
import type { Agent } from '../model.ts';
import { writePRText } from './generate.ts';
import { execRunner, githubCommands } from './github.ts';
import type { CommandRunner, HostCommands, RepoCommand } from './types.ts';

export interface PRForm {
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

/** The hosts' own limits on a pull request's title and body (GitHub's, the tighter). */
export const MAX_TITLE_CHARS = 256;
export const MAX_BODY_CHARS = 65_000;
/** How long one gh or git command may take while preparing, and while pushing and creating. */
export const PREPARE_TIMEOUT_MS = 15_000;
export const PUBLISH_TIMEOUT_MS = 60_000;
/** Characters a base branch name may not have (git check-ref-format), and what it may not start with. */
const BAD_BASE = /[\s~^:?*[\\]|\.\.|@\{/;

/** The form as sent, checked; throws with what to fix. */
export function validatePRForm(value: Record<string, unknown>): PRForm {
  const { title, body, base, draft } = value;
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_CHARS) throw new Error(`Enter a title (up to ${MAX_TITLE_CHARS} characters).`);
  if (typeof body !== 'string' || body.length > MAX_BODY_CHARS) throw new Error('Description must be under 65,000 characters.');
  // A lone "-" is how gh and glab are told to read the text from elsewhere (a file, an editor).
  if (body.trim() === '-') throw new Error('The description cannot be just "-".');
  if (typeof base !== 'string' || !base.trim() || base.trim().startsWith('-') || BAD_BASE.test(base.trim())) throw new Error('Enter a valid base branch.');
  if (typeof draft !== 'boolean') throw new Error('Choose draft or ready for review.');
  return { title: title.trim(), body, base: base.trim(), draft };
}

export interface HostOptions {
  run?: CommandRunner;
  /** The host's commands; GitHub's when absent. */
  commands?: HostCommands;
}

export interface PrepareOptions extends HostOptions {
  /** The project's chosen base branch (shared/git-defaults.ts); the host's default branch when absent or empty. */
  base?: string;
  /** Who may write the generated text (agents/title-providers.ts); none means the plain text. */
  writers?: readonly TitleProvider[];
  /** The session's agent: its own provider is asked first. */
  agent?: Agent;
  /** The session's model, asked of its own agent's provider; empty or absent means that agent's default. */
  model?: string;
  /** The clock for the model's time limit; tests pass one. */
  wait?: (ms: number) => Promise<void>;
}

/** What the form starts with, and how many commits the request carries from before the session began. */
export type PreparedPR = Omit<PRForm, 'draft'> & { draft: false; inherited: number };

/** What a recorded base commit must look like before it goes into a range. */
const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;

/** The commit the session's branch started from (git.ts `addWorktree`), or null when none is recorded. */
async function recordedBase(command: RepoCommand, branch: string): Promise<string | null> {
  const value = await command('git', ['config', '--get', `branch.${branch}.kestrelbase`]).catch(() => '');
  return COMMIT_HASH.test(value) ? value : null;
}

/** How many commits on `origin/<base>..<start>` the request carries besides the session's own; 0 when git cannot say. */
async function inheritedCount(command: RepoCommand, base: string, start: string): Promise<number> {
  const out = await command('git', ['rev-list', '--count', `origin/${base}..${start}`, '--']).catch(() => '');
  const count = Number.parseInt(out, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * What the form starts with: blank for "Manually", written for "Generated"; the base is the default
 * branch either way. "Generated" describes the commits after the session's recorded start (or, when
 * none is recorded, everything beyond origin/<base>), and refuses when there are none.
 */
export async function preparePR(cwd: string, branch: string, generated: boolean, options: PrepareOptions = {}): Promise<PreparedPR> {
  const command = repoCommand(cwd, options.run, PREPARE_TIMEOUT_MS);
  const base = options.base || (await (options.commands ?? githubCommands).defaultBranch(command));
  if (!base) throw new Error('Could not find the repository’s default branch.');
  const start = await recordedBase(command, branch);
  const inherited = start ? await inheritedCount(command, base, start) : 0;
  if (!generated) return { title: '', body: '', base, draft: false, inherited };
  // From the session's start the base is an ancestor, so two dots; from origin, the merge base (three).
  const logRange = start ? `${start}..${branch}` : `origin/${base}..${branch}`;
  const diffRange = start ? `${start}..${branch}` : `origin/${base}...${branch}`;
  const commits = await command('git', ['log', '--format=%s', logRange, '--']);
  if (!commits) throw new Error(start ? "Nothing is committed on this branch yet. Commit this session's changes, then generate the text." : 'There are no commits on this branch beyond the default branch to describe yet.');
  const material: PRMaterial = {
    branch,
    base,
    subjects: commits.split('\n'),
    stat: await command('git', ['diff', '--stat', diffRange, '--']),
    // A diff too big to read is not a reason to give up: the subjects and the stat still say plenty.
    diff: await command('git', ['diff', '--no-color', '--no-ext-diff', diffRange, '--']).catch(() => ''),
  };
  const text = await writePRText(material, options.writers ?? [], { agent: options.agent ?? 'claude', model: options.model }, options.wait);
  return { ...text, base, draft: false, inherited };
}

/** Pushes the branch to origin and opens the pull request; an open one for the branch is returned instead. */
export async function publishPR(cwd: string, branch: string, form: PRForm, options: HostOptions = {}): Promise<{ url: string }> {
  const commands = options.commands ?? githubCommands;
  const command = repoCommand(cwd, options.run, PUBLISH_TIMEOUT_MS);
  // Recheck before a retry, so a lost HTTP response cannot create a duplicate PR.
  const existing = await commands.openRequestUrl(command, branch);
  if (existing) return { url: existing };
  // --set-upstream, so a later plain `git push` or `git pull` in the worktree (and gh's own lookups) find it.
  await command('git', ['push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  const [bin, args] = commands.createCommand(branch, form);
  return { url: commands.createdUrl(await command(bin, args)) };
}

/** Runs one command in `cwd` with a time limit; its output trimmed. */
function repoCommand(cwd: string, run: CommandRunner = execRunner, timeoutMs: number): RepoCommand {
  return async (bin, args) => (await run(bin, args, { cwd, timeoutMs })).stdout.trim();
}

/** Adds a comment to the checkout's pull request `number`. Throws with the host's own reason when it cannot. */
export async function commentOnPR(cwd: string, number: number, body: string, options: HostOptions = {}): Promise<void> {
  const commands = options.commands ?? githubCommands;
  const [bin, args] = commands.commentCommand(number, body);
  try {
    await repoCommand(cwd, options.run, PUBLISH_TIMEOUT_MS)(bin, args);
  } catch (error) {
    throw new Error(commands.failureReason(error));
  }
}
