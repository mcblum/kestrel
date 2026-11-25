// Which hosts `gh` and `glab` are signed in to, asked of each program. Only the host, the user and
// the git protocol are kept; the programs' tokens are never asked for (`gh auth status` without
// `--show-token`) and anything else they print is dropped here.
import type { SetupHost, SetupPart } from '../shared/setup-record.ts';
import type { Run } from './io.ts';

type Found = { hosts: SetupHost[]; problems: { part: SetupPart; reason: string }[] };

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `gh auth status --json hosts`, read into hosts. Pure. */
export function ghHostsOf(json: string): SetupHost[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return Object.entries(obj(obj(parsed).hosts)).flatMap(([host, accounts]) =>
    (Array.isArray(accounts) ? accounts : []).map((a) => {
      const account = obj(a);
      return { tool: 'gh' as const, host, user: str(account.login), protocol: str(account.gitProtocol), signedIn: account.state === 'success' };
    }),
  );
}

/** `glab auth status`, read into hosts: a host on a line of its own, then what it says of it. Pure. */
export function glabHostsOf(text: string): SetupHost[] {
  const hosts: SetupHost[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[A-Za-z0-9.-]+(?::\d+)?\s*$/.test(line)) {
      hosts.push({ tool: 'glab', host: line.trim(), user: null, protocol: null, signedIn: false });
      continue;
    }
    const current = hosts.at(-1);
    if (!current) continue;
    const signedIn = /Logged in to \S+ as (\S+)/.exec(line);
    if (signedIn) {
      current.signedIn = true;
      current.user = signedIn[1] ?? null;
    }
    const protocol = /Git operations for \S+ configured to use (ssh|https) protocol/.exec(line);
    if (protocol) current.protocol = protocol[1] ?? null;
  }
  return hosts;
}

export async function readHosts(run: Run, gh: string | null, glab: string | null): Promise<Found> {
  const problems: Found['problems'] = [];
  const hosts: SetupHost[] = [];
  if (!gh) problems.push({ part: 'hosts', reason: 'gh is not installed.' });
  else {
    const answer = await run(gh, ['auth', 'status', '--json', 'hosts']);
    const found = answer ? ghHostsOf(answer.stdout) : null;
    if (found) hosts.push(...found);
    else problems.push({ part: 'hosts', reason: 'gh did not say which hosts it is signed in to (it may be older than 2.58).' });
  }
  if (!glab) problems.push({ part: 'hosts', reason: 'glab is not installed.' });
  else {
    const answer = await run(glab, ['auth', 'status']);
    // glab prints its status on standard error, and ends with a failure when any host is signed out.
    if (answer) hosts.push(...glabHostsOf(`${answer.stdout}\n${answer.stderr}`));
    else problems.push({ part: 'hosts', reason: 'glab could not be asked which hosts it is signed in to.' });
  }
  return { hosts, problems };
}
