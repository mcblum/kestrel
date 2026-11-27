// An approved proposal becomes a pull request against the knowledge base (design doc:
// docs/designs/knowledge.md, "A proposal is a pull request, written by Kestrel"). No agent writes
// the file: Kestrel renders it from the checked fields, so every proposal from every developer has
// the same shape, costs no tokens, and passes the check the index is built with.
//
// The work happens in a throwaway worktree cut from the fetched default branch, so the user's own
// checkout of the knowledge base is never touched, whatever it has checked out or uncommitted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, originUrl } from '../git.ts';
import { resolveProvider } from '../pull-requests/choose.ts';
import { publishPR } from '../pull-requests/create.ts';
import { githubCommands } from '../pull-requests/github.ts';
import { gitlabCommands } from '../pull-requests/gitlab.ts';
import { sharedGlabSignIn } from '../pull-requests/glab.ts';
import type { CommandRunner, HostCommands } from '../pull-requests/types.ts';
import { entryPath, proposalBranch } from '../shared/knowledge.ts';
import { Refused } from '../workspace.ts';
import type { CheckedProposal } from './service.ts';

export interface ProposeOptions {
  /** A folder Kestrel owns, where the throwaway worktree is made. */
  workDir: string;
  /** The host's commands; chosen from the repository's remote when absent. */
  commands?: HostCommands;
  run?: CommandRunner;
}

const COMMANDS = { github: githubCommands, gitlab: gitlabCommands } as const;

async function commandsFor(repo: string): Promise<HostCommands> {
  const choice = await resolveProvider(await originUrl(repo), sharedGlabSignIn);
  if (choice.kind === 'none') throw new Refused(`${choice.reason}, so no pull request can be opened for the knowledge base.`);
  return COMMANDS[choice.kind];
}

/** What the pull request says: what it adds or corrects, and why the session thought it worth keeping. */
export function proposalForm(checked: CheckedProposal, reason: string, base: string): { title: string; body: string; base: string; draft: false } {
  const what = checked.isUpdate ? 'Corrects' : 'Adds';
  const lines = [`${what} \`${entryPath(checked.id)}\`.`, '', checked.entry.summary, ...(reason ? ['', `Why: ${reason}`] : []), '', 'Proposed from a Kestrel session and approved there by the person who opened this. Check it as you would anything written down for everyone: is it true, is it in the right place, and is the owner right?'];
  return { title: `knowledge: ${checked.entry.title}`, body: lines.join('\n'), base, draft: false };
}

/**
 * Open the pull request for a checked proposal. `ref` is the fetched default branch the entry was
 * checked against (`origin/main`). Throws a `Refused` with a reason a person can act on.
 */
export async function openProposal(repo: string, ref: string, checked: CheckedProposal, reason: string, opts: ProposeOptions): Promise<{ url: string }> {
  if (!(await originUrl(repo))) throw new Refused('The knowledge base has no remote, so there is nowhere to open a pull request.');
  if (!ref.startsWith('origin/')) throw new Refused('The knowledge base’s remote has not been fetched yet. Try again in a moment.');
  const commands = opts.commands ?? (await commandsFor(repo));
  const branch = proposalBranch(checked.id);
  // One branch per entry: a second person proposing the same thing is sent to the first one's request.
  if ((await git(repo, ['ls-remote', '--heads', 'origin', branch], { allowFail: true })).trim()) {
    throw new Refused(`This has been proposed already: the branch ${branch} is on the knowledge base’s remote, with a pull request of its own. Add to that one.`);
  }
  mkdirSync(opts.workDir, { recursive: true });
  const tree = mkdtempSync(join(opts.workDir, 'proposal-'));
  try {
    // -B: a branch left behind by an attempt that failed is Kestrel's own, and is started again.
    await git(repo, ['worktree', 'add', '--quiet', '-B', branch, tree, ref]);
    const file = join(tree, entryPath(checked.id));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, checked.text);
    await git(tree, ['add', '--', entryPath(checked.id)]);
    await git(tree, ['commit', '--quiet', '-m', `knowledge: ${checked.entry.title}`]);
    try {
      return await publishPR(tree, branch, proposalForm(checked, reason, ref.slice('origin/'.length)), { commands, ...(opts.run ? { run: opts.run } : {}) });
    } catch (error) {
      throw new Refused(commands.failureReason(error));
    }
  } finally {
    await git(repo, ['worktree', 'remove', '--force', tree], { allowFail: true });
    rmSync(tree, { recursive: true, force: true });
    await git(repo, ['branch', '-D', branch], { allowFail: true });
  }
}
