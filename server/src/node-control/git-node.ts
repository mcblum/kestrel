// The node's part of `kestrel-node git` (shared/node-commands.ts): what only the running node knows. The terminal makes
// the key, tests it and asks the person (git-checklist.ts); the node reads its git settings again into the environment
// its git and its sessions' agents run in (node-git-env.ts), and says the repositories of the account's projects and
// what the account's other computers publish about their git. No key or token is in what it says.
import type { KestrelHandle } from '../start-server.ts';
import { linkText, type ConnectAccount, type ConnectLink } from '../shared/connect.ts';
import type { NodeGitFacts, PublishedGit } from '../shared/node-commands.ts';

/** The parts of a running server the node's answer is read from. */
export type GitFactsSource = {
  workspace: Pick<KestrelHandle['workspace'], 'view' | 'repos' | 'accountProjects'>;
  connect: Pick<KestrelHandle['connect'], 'publishedGit' | 'view'>;
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The repositories of every project the account has, once each: this node's own (cloned or not yet) and the other
 * computers', as the window draws them (`workspace.view()`, which holds both the projects feed and the projects the
 * other computers' sessions are in). Never only the projects this node has cloned.
 */
async function repositories(source: GitFactsSource): Promise<string[]> {
  const { projects } = await source.workspace.view();
  const own = await Promise.all(projects.filter((p) => !p.away).map((project) => source.workspace.repos.ofProject(project)));
  const away = projects.flatMap((p) => (p.away ? (p.elsewhere?.repos ?? []) : []));
  return [...new Set([...own.flat(), ...away])].sort();
}

/**
 * Why the account's projects are not known yet, or null when they are (the projects feed has been read once). The
 * checklist says this and offers to wait or check again; it never takes an unread account for one with no projects.
 */
export function accountUnknownOf(account: ConnectAccount, link: ConnectLink, feedRead: boolean): string | null {
  if (feedRead) return null;
  if (account.state !== 'signed-in') return 'This node is not in an account yet (`kestrel-node join`), so the account’s projects are not known.';
  if (link.state !== 'connected') return `The account’s projects are not known yet: Kestrel Connect is ${linkText(link).toLowerCase()}.`;
  return 'The account’s projects are not read yet: the node reads them shortly after it connects.';
}

export async function nodeGitFacts(source: GitFactsSource, name: string): Promise<NodeGitFacts> {
  let others: PublishedGit[] = [];
  let othersUnknown: string | null = null;
  try {
    others = await source.connect.publishedGit();
  } catch (error) {
    othersUnknown = reasonOf(error);
  }
  const { account, link } = source.connect.view();
  const feedRead = (await source.workspace.accountProjects.feedMark()) !== null;
  return { name, repositories: await repositories(source), accountUnknown: accountUnknownOf(account, link, feedRead), others, othersUnknown };
}
