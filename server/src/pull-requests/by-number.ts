// One pull or merge request by its number, for the requests linked to a session that are no longer
// on its current branch (session-requests.ts): `gh pr view <n> --json <the list's fields>` and
// `glab mr view <n> --output json`, mapped by the same functions as the branch lookups (github.ts,
// gitlab.ts), so a request looks the same however it was found. The host saying there is no such
// request is `null`, apart from failing to ask. The command runner is injected: tests never call gh or glab.
import type { PullRequest } from '../shared/details.ts';
import { ready, reasonOf, unavailable, type Sourced } from '../shared/sourced.ts';
import { execRunner, ghFailureReason, GH_FIELDS, GH_TIMEOUT_MS, mapGhItem } from './github.ts';
import { mapGlabMergeRequest, viewArgs } from './gitlab.ts';
import { GLAB_TIMEOUT_MS, glabFailureReason } from './glab.ts';
import type { CommandRunner } from './types.ts';

/** A request by number: the request, null when the host has none with that number, or why it could not be asked. */
export type ByNumber = Sourced<PullRequest | null>;

export interface ByNumberProvider {
  pullRequestByNumber(repoPath: string, number: number): Promise<ByNumber>;
}

/** gh's words for a number with no pull request behind it (GraphQL "Could not resolve to a PullRequest"). */
const GH_NOT_FOUND = /could not resolve to a pull ?request|no pull requests? found/i;
/** glab's words for an iid with no merge request behind it (the API's 404). */
const GLAB_NOT_FOUND = /\b404\b/;

const stderrOf = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const ghViewArgs = (number: number): string[] => ['pr', 'view', String(number), '--json', GH_FIELDS];

/** `gh pr view --json` output as a pull request; throws when it is not one. Pure. */
export function mapGhView(json: string): PullRequest {
  const parsed: unknown = JSON.parse(json);
  if (!isObject(parsed) || typeof parsed.number !== 'number') throw new Error('gh did not answer with a pull request');
  return mapGhItem(parsed);
}

/** `glab mr view --output json` output as a pull request; throws when it is not one. Pure. */
export function mapGlabView(json: string): PullRequest {
  const parsed: unknown = JSON.parse(json);
  if (!isObject(parsed) || !Number.isInteger(parsed.iid)) throw new Error('glab did not answer with a merge request');
  return mapGlabMergeRequest(parsed);
}

interface ViewCommand {
  bin: string;
  args(number: number): string[];
  timeoutMs: number;
  notFound: RegExp;
  failureReason(error: unknown): string;
  map(json: string): PullRequest;
}

function viewProvider(command: ViewCommand, run: CommandRunner): ByNumberProvider {
  return {
    async pullRequestByNumber(repoPath, number) {
      let stdout: string;
      try {
        ({ stdout } = await run(command.bin, command.args(number), { cwd: repoPath, timeoutMs: command.timeoutMs }));
      } catch (error) {
        return command.notFound.test(stderrOf(error)) ? ready(null) : unavailable(command.failureReason(error));
      }
      try {
        return ready(command.map(stdout));
      } catch (error) {
        return unavailable(`${command.bin} gave an answer Kestrel cannot read: ${reasonOf(error)}`);
      }
    },
  };
}

export function githubByNumber(run: CommandRunner = execRunner): ByNumberProvider {
  return viewProvider({ bin: 'gh', args: ghViewArgs, timeoutMs: GH_TIMEOUT_MS, notFound: GH_NOT_FOUND, failureReason: ghFailureReason, map: mapGhView }, run);
}

export function gitlabByNumber(run: CommandRunner = execRunner): ByNumberProvider {
  return viewProvider({ bin: 'glab', args: viewArgs, timeoutMs: GLAB_TIMEOUT_MS, notFound: GLAB_NOT_FOUND, failureReason: (error) => glabFailureReason(error), map: mapGlabView }, run);
}
