// Which ticket sources there are: the scripted one with fake data; otherwise GitLab on every server a
// registered project's `origin` is on that glab is signed in to, GitHub while gh is signed in, and
// Jira Cloud and Linear while they are connected (jira.ts, linear.ts). The only place that knows
// which trackers exist, and how each stands for Settings → Tickets. Which of them are used is the
// user's choice, applied by the sync (`ticketSourceOn`).
import { isGithubHost } from '../../pull-requests/choose.ts';
import type { GlabSignInCheck } from '../../pull-requests/glab.ts';
import type { AccountLogin } from '../../git-settings/github-login.ts';
import { hostsOf, projectRemote, type ProjectsSource } from '../../review-requests/sync.ts';
import type { TicketSourceStatus } from '../../shared/tickets.ts';
import type { TicketSource } from '../source.ts';
import { fakeTicketSource } from './fake.ts';
import { githubTicketSource } from './github.ts';
import { gitlabTicketSource } from './gitlab.ts';

export interface TicketSourcesDeps {
  fake: boolean;
  workspace: ProjectsSource;
  originOf(path: string): Promise<string | null>;
  glabSignIn: GlabSignInCheck;
  /** Who gh is signed in as, or why it is not. */
  githubLogin(): Promise<AccountLogin>;
  /** Jira Cloud's source while it is connected, else null. */
  jira(): Promise<TicketSource | null>;
  /** Linear's source while it is connected, else null. */
  linear(): Promise<TicketSource | null>;
  gitlab?: (host: string) => TicketSource;
  github?: () => TicketSource;
}

export interface TicketSources {
  /** Every source that is ready, switched on or not. */
  list(): Promise<TicketSource[]>;
  /** How each tracker stands, in Settings → Tickets' order. */
  status(): Promise<TicketSourceStatus[]>;
}

export const SAMPLE_SOURCE_LINE = 'Kestrel is running on sample data, so the sample tracker stands in for every tracker.';

interface GitlabHosts {
  signedIn: string[];
  reasons: string[];
  any: boolean;
}

export function ticketSources(deps: TicketSourcesDeps): TicketSources {
  const fake = fakeTicketSource();
  const gitlabs = new Map<string, TicketSource>();
  const gitlabOf = (host: string): TicketSource => {
    let source = gitlabs.get(host);
    if (!source) gitlabs.set(host, (source = (deps.gitlab ?? gitlabTicketSource)(host)));
    return source;
  };
  const github = (deps.github ?? githubTicketSource)();
  const gitlabHosts = async (): Promise<GitlabHosts> => {
    const projects = (await deps.workspace.state()).projects;
    const remotes = await Promise.all(projects.flatMap((p) => p.folders.map(async (f) => projectRemote(p.id, await deps.originOf(f.path).catch(() => null)))));
    const hosts = hostsOf(remotes.filter((r) => r !== null)).filter((host) => !isGithubHost(host));
    const answers = await Promise.all(hosts.map(async (host) => ({ host, answer: await deps.glabSignIn(host) })));
    return { signedIn: answers.flatMap((a) => (a.answer.signedIn ? [a.host] : [])), reasons: answers.flatMap((a) => (a.answer.signedIn ? [] : [a.answer.reason])), any: hosts.length > 0 };
  };
  const githubReady = async (): Promise<AccountLogin> => deps.githubLogin().catch((error: unknown) => ({ available: false as const, reason: String(error) }));

  return {
    async list() {
      if (deps.fake) return [fake];
      const [hosts, login, jira, linear] = await Promise.all([gitlabHosts(), githubReady(), deps.jira().catch(() => null), deps.linear().catch(() => null)]);
      return [...hosts.signedIn.map(gitlabOf), ...(login.available ? [github] : []), ...(jira ? [jira] : []), ...(linear ? [linear] : [])];
    },
    async status() {
      if (deps.fake) {
        return [
          { id: 'gitlab', state: 'sample', line: SAMPLE_SOURCE_LINE },
          { id: 'github', state: 'sample', line: SAMPLE_SOURCE_LINE },
          { id: 'jira', state: 'sample', line: SAMPLE_SOURCE_LINE },
          { id: 'linear', state: 'sample', line: SAMPLE_SOURCE_LINE },
        ];
      }
      const [hosts, login, jira, linear] = await Promise.all([gitlabHosts(), githubReady(), deps.jira().catch(() => null), deps.linear().catch(() => null)]);
      const gitlab: TicketSourceStatus =
        hosts.signedIn.length > 0
          ? { id: 'gitlab', state: 'ready', line: `Uses glab’s sign-in on ${hosts.signedIn.join(', ')}.` }
          : { id: 'gitlab', state: 'needs-setup', line: hosts.any ? `glab is not signed in to the GitLab servers your projects are on. ${hosts.reasons[0] ?? ''}`.trim() : 'No registered project is on a GitLab server, so there is no GitLab to ask.' };
      return [
        gitlab,
        login.available ? { id: 'github', state: 'ready', line: `Uses gh’s sign-in, as ${login.login}.` } : { id: 'github', state: 'needs-setup', line: `gh is not signed in: ${login.reason}.` },
        jira ? { id: 'jira', state: 'ready', line: 'Connected below.' } : { id: 'jira', state: 'needs-setup', line: 'Connect Jira below before turning it on.' },
        linear
          ? { id: 'linear', state: 'ready', line: 'Connected below. Checked against Linear’s published API schema only, not yet against a workspace.' }
          : { id: 'linear', state: 'needs-setup', line: 'Connect Linear below before turning it on.' },
      ];
    },
  };
}
