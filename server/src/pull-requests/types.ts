// Where a session's linked pull requests come from. One provider per hosting service, chosen by the
// repository's `origin` remote (choose.ts). A provider answers for one repository and one branch.
// `HostCommands` is what creating one needs from a host (create.ts): GitHub and GitLab share the flow.
import type { PRForm } from './create.ts';
import type { BasePipeline, PullRequest } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import type { Sourced } from '../shared/sourced.ts';

export interface PullRequestProvider {
  /** The pull requests whose head is `branch`, in any state. An empty list means none are linked. */
  pullRequestsFor(repoPath: string, branch: string): Promise<Sourced<PullRequest[]>>;
}

/**
 * The pipeline on one commit of a target branch, for Autopilot's watch after a merge (docs/designs/pr-autopilot.md).
 * `ref` is the branch ('' when unknown); GitHub needs only the commit.
 */
export interface PipelineProvider {
  pipelineOn(repoPath: string, sha: string, ref: string): Promise<Sourced<BasePipeline>>;
}

/** Runs a command (never through a shell) and resolves with its output; rejects as `execFile` does. */
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<{ stdout: string }>;

/** One command in the repository, its output trimmed. */
export type RepoCommand = (bin: string, args: string[]) => Promise<string>;

/** A host's own commands for creating a pull request; git itself is the same for every host. */
export interface HostCommands {
  kind: HostKind;
  /** The repository's default branch, or null when the host does not say. */
  defaultBranch(command: RepoCommand): Promise<string | null>;
  /** The address of an open pull request from `branch`, or null when there is none. */
  openRequestUrl(command: RepoCommand, branch: string): Promise<string | null>;
  /** The command that creates the pull request: [binary, arguments]. */
  createCommand(branch: string, form: PRForm): [string, string[]];
  /** The new pull request's address, from what the create command printed. */
  createdUrl(stdout: string): string;
  /** The command that adds a comment to request `number`: [binary, arguments]. */
  commentCommand(number: number, body: string): [string, string[]];
  /** Why a command failed, said plainly. */
  failureReason(error: unknown): string;
}
