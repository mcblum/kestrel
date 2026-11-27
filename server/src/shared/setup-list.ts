import { repositoryKey } from './knowledge.ts';
// The set-up list (docs/designs/onboarding.md, sections 3, 7 and 8): what the other machines of the
// account have that this one lacks, built from their set-up records and this machine's own, read again
// each time the page opens so every line's check is current. One line per thing, in seven groups, in
// the order the work needs them. Each line has a kind (brought over, done here, installed here, cannot
// be brought), says in one sentence what it does, names the secrets it will need, and knows whether it
// is already done here. An agent's skills are one line and its rules files one line, with the names
// inside (`fileLines`); a file with a key in it, or one that needs a value here, stays a line of its own.
// Each line also carries what its Run does (`action`, one closed union), how that runs here (`run`), the
// command to show (`command`), what it needs first (`needs`, from setup-needs.ts) and whether this
// computer dismissed it (onboarding.md, section 18). The page draws these and decides nothing.
// Pure and browser-safe.
import { AGENT_LABEL, type Agent } from '../model.ts';
import type { Platform } from './platform.ts';
import { agentRecipeOf, commandText, HOMEBREW, installRecipeOf, NO_HOST, shellOf, type InstallHost, type InstallRecipe, type SetupCommand, type SetupRun } from './setup-install.ts';
import { mcpRunnerTool, setupNeedsOf, sshHostOf } from './setup-needs.ts';
import { listNameOf } from './mcp-servers.ts';
import { copyOffersOf, copyStepOf, type SetupCopy } from './setup-values.ts';
import { blankText, type HostTool, type SetupFile, type SetupFileKind, type SetupKnowledge, type SetupMcpServer, type SetupRecord, type SetupSshHost } from './setup-record.ts';
import { andList, mergeDoesText, mergeDone, mergeLeftText, mergeWhoDoesWhat } from './who-does-what-merge.ts';
import { NOBODY, type WhoDoesWhat } from './who-does-what.ts';

export type { SetupCommand, SetupRun } from './setup-install.ts';

export type SetupGroup = 'agents' | 'git' | 'tools' | 'projects' | 'mcp' | 'settings' | 'knowledge' | 'kestrel';

export const SETUP_GROUPS: readonly { id: SetupGroup; title: string }[] = [
  { id: 'agents', title: 'Agents' },
  { id: 'git', title: 'Git' },
  { id: 'tools', title: 'Tools' },
  { id: 'projects', title: 'Projects' },
  { id: 'mcp', title: 'MCP servers' },
  { id: 'settings', title: 'Agent settings' },
  { id: 'knowledge', title: 'Knowledge base' },
  { id: 'kestrel', title: 'Kestrel' },
];

export type SetupLineKind = 'bring' | 'here' | 'install' | 'cannot';

/** The kind's chip: brought over, done here with a click, installed here, cannot be brought. */
export const SETUP_KIND_TEXT: Record<SetupLineKind, string> = { bring: 'Bring over', here: 'Do here', install: 'Install here', cannot: 'Cannot bring' };

/** What a line's Run does. The server takes it from its own copy of the list, never from the page. */
export type SetupAction =
  | { kind: 'agent-install'; agent: Agent }
  | { kind: 'sign-in'; agent: Extract<Agent, 'claude' | 'codex'> }
  | { kind: 'host-sign-in'; tool: HostTool; host: string; protocol: 'ssh' | 'https' | null; web: boolean }
  | { kind: 'git-identity'; name: string | null; email: string | null }
  | { kind: 'ssh-hosts'; hosts: SetupSshHost[] }
  | { kind: 'ssh-key'; host: string; tool: HostTool | null }
  | { kind: 'install'; tool: string; why: string[] }
  | { kind: 'clone'; origin: string; path: string; project: string; folder: string }
  | { kind: 'mcp'; server: SetupMcpServer }
  | { kind: 'files'; agent: Agent; paths: string[] }
  /** Use this repository as the knowledge base here (18.15): only on this line's own click. */
  | { kind: 'knowledge'; repo: string; name: string }
  /** Merge another computer's model presets and Who does what into this one's: adds what is missing, replaces nothing. */
  | { kind: 'models'; who: WhoDoesWhat; instructionLeftOut: boolean };

export interface SetupLine {
  /** Stable across reads: the same thing from two machines is one line. */
  id: string;
  group: SetupGroup;
  kind: SetupLineKind;
  title: string;
  /** One sentence: what its button does, or will do, or what to do instead. */
  does: string;
  /** Which machines have it. */
  from: string[];
  /** The secrets it will need here, by name; never a value. */
  secrets: string[];
  /** Its check, run on this machine: already here. */
  done: boolean;
  /** What Run does; null when there is nothing Kestrel can run (the line says what to do). */
  action: SetupAction | null;
  /** How it runs here (onboarding.md 18.7); null with no action. */
  run: SetupRun | null;
  /** The command to show, copyable, whether or not Kestrel runs it. */
  command: SetupCommand | null;
  /** A page Run opens (`run: 'open'`). */
  url: string | null;
  /** A page of Kestrel's own where the person finishes the step (an MCP server's values): `#/…`. */
  page: string | null;
  /** The ids of lines that must be done first (setup-needs.ts). */
  needs: string[];
  /** This computer dismissed it (`applyDismissals`). */
  dismissed: boolean;
  /** Ask the agent is offered whatever its state: the step needs judgment (18.12). */
  askAgent: boolean;
  /** A line that stands for many (an agent's skills, its rules files): what is in it. Null for one thing. */
  items: SetupItems | null;
  /** Who its missing values may be copied from (onboarding.md section 19); null or absent when nobody. Names only. */
  copy?: SetupCopy | null;
}

/** What a grouped line holds. Counted in files for rules, in skills for skills. */
export interface SetupItems {
  names: { name: string; done: boolean }[];
  here: number;
  total: number;
  /** "131 of 143 here" while some but not all are; null otherwise. */
  progress: string | null;
}

export interface SetupList {
  here: { id: string; name: string; platform: Platform };
  others: { id: string; name: string; readAt: number }[];
  lines: SetupLine[];
  /** Parts of this machine that could not be read, and why. */
  problems: string[];
}

/** What only this machine can answer, asked by the server as the list is built. */
export interface SetupChecks {
  /** Whether a tool is on this machine. */
  tool(name: string): boolean;
  /** What decides an install's route (Homebrew, npm's folder, polkit). None: nothing extra is assumed. */
  host?: InstallHost;
  /** Whether this computer reaches a git host over SSH with a key of its own. */
  sshReaches?(host: string): boolean;
  /** Where Kestrel's own MCP list has each server, and whether every value is set. */
  mcp?(name: string): 'missing' | 'needs-values' | 'ready';
  /** The names of a server in Kestrel's own list that have no value here; null when it is not in the list. */
  mcpMissing?(name: string): string[] | null;
  /** The knowledge base this computer uses now, by repository key and name; null when none. */
  knowledge?: SetupKnowledge | null;
  /** The model presets and Who does what as stored here now; absent, this computer's record says. */
  whoDoesWhat?: WhoDoesWhat | null;
  /** The `origin` of the git clone at a `~/…` path on this computer, or null when there is none there. */
  originAt?(path: string): string | null;
  /** The `Host` names in this computer's `~/.ssh/config` now; names only, read here and sent nowhere. */
  sshHosts?(): string[];
  /** Whether a `~/…` or absolute path is here (an MCP server's program by path). */
  exists?(path: string): boolean;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const machine = (platform: Platform) => (platform === 'mac' ? 'this Mac' : 'this computer');

/** A file that is one of many in a grouped line, its check already run against this machine. */
interface Member {
  path: string;
  files: number;
  done: boolean;
}
type Bundle = { agent: Agent; kind: GroupedKind; members: Member[] };
type Draft = Omit<SetupLine, 'from' | 'done' | 'items' | 'run' | 'command' | 'url' | 'page' | 'needs' | 'dismissed' | 'askAgent'> & Partial<Pick<SetupLine, 'run' | 'command' | 'url' | 'page' | 'askAgent'>> & { done: (here: SetupRecord) => boolean; bundle?: Bundle };

/** A recipe's part of a line: how it runs, what to show, what it opens. */
const routeOf = (recipe: InstallRecipe | null): Pick<SetupLine, 'run' | 'command' | 'url'> => (recipe ? { run: recipe.run, command: recipe.command, url: recipe.url } : { run: null, command: null, url: null });

function agentLines(other: SetupRecord, here: SetupRecord, host: InstallHost): Draft[] {
  const platform = here.machine.platform;
  const shell = shellOf(platform);
  return other.agents
    .filter((a) => a.state === 'ready')
    .flatMap((a): Draft[] => {
      const label = AGENT_LABEL[a.agent];
      const mine = here.agents.find((h) => h.agent === a.agent)?.state ?? 'missing';
      const ready = (h: SetupRecord) => h.agents.some((x) => x.agent === a.agent && x.state === 'ready');
      const installed = (h: SetupRecord) => h.agents.some((x) => x.agent === a.agent && x.state !== 'missing');
      const lines: Draft[] = [];
      if (mine === 'missing') {
        const recipe = agentRecipeOf(a.agent, platform, host);
        lines.push({ id: `agent:${a.agent}:install`, group: 'agents', kind: 'install', title: `Install ${label}`, does: recipe?.command ? `Runs ${label}'s installer as you.` : `Install ${label} the way you usually do.`, secrets: [], action: recipe ? { kind: 'agent-install', agent: a.agent } : null, ...routeOf(recipe), done: installed });
      }
      if (a.agent === 'opencode') lines.push({ id: `agent:${a.agent}`, group: 'agents', kind: 'here', title: `Sign in to ${label}`, does: 'OpenCode signs in to each model provider in its own prompt: run this in a terminal here.', secrets: [], action: null, command: { shell, text: 'opencode auth login' }, done: ready });
      else lines.push({ id: `agent:${a.agent}`, group: 'agents', kind: 'here', title: `Sign in to ${label}`, does: `Runs ${label}'s own sign-in, which opens in your browser. Use the account ${other.machine.name} uses; nothing is copied from it.`, secrets: [], action: { kind: 'sign-in', agent: a.agent }, run: 'user', command: { shell, text: a.agent === 'claude' ? 'claude auth login' : 'codex login' }, done: ready });
      return lines;
    });
}

function gitLines(other: SetupRecord, here: SetupRecord, checks: SetupChecks): Draft[] {
  const lines: Draft[] = [];
  const g = other.git;
  const platform = here.machine.platform;
  const shell = shellOf(platform);
  if (g.name || g.email) {
    const who = [g.name, g.email && `<${g.email}>`].filter(Boolean).join(' ');
    const text = [g.name && commandText(['git', 'config', '--global', 'user.name', g.name], shell), g.email && commandText(['git', 'config', '--global', 'user.email', g.email], shell)].filter(Boolean).join('\n');
    lines.push({ id: `git:identity:${who}`, group: 'git', kind: 'bring', title: `Git identity: ${who}`, does: 'Sets user.name and user.email in your global git settings, and nothing else.', secrets: [], action: { kind: 'git-identity', name: g.name, email: g.email }, run: 'user', command: { shell, text }, done: (h) => h.git.name === g.name && h.git.email === g.email });
  }
  for (const tool of ['gh', 'glab'] as const) {
    const hosts = other.hosts.filter((h) => h.tool === tool && h.signedIn);
    if (hosts.length === 0) continue;
    const missing = here.problems.some((p) => p.reason === `${tool} is not installed.`);
    if (missing) {
      const recipe = installRecipeOf(tool, platform, checks.host ?? NO_HOST);
      lines.push({ id: `tool:${tool}`, group: 'git', kind: 'install', title: `Install ${tool}`, does: `Installs ${tool}, so this machine can sign in to ${hosts.map((h) => h.host).join(' and ')}.`, secrets: [], action: recipe ? { kind: 'install', tool, why: [] } : null, ...routeOf(recipe), done: (h) => !h.problems.some((p) => p.reason === `${tool} is not installed.`) });
    }
    for (const host of hosts) {
      const web = tool === 'gh' || host.host === 'gitlab.com';
      const protocol = host.protocol === 'ssh' || host.protocol === 'https' ? host.protocol : null;
      const argv = tool === 'gh' ? ['gh', 'auth', 'login', '--web', '--hostname', host.host, ...(protocol ? ['--git-protocol', protocol] : [])] : ['glab', 'auth', 'login', '--hostname', host.host, ...(web ? ['--web'] : ['--stdin'])];
      const does = web ? 'Runs this; you sign in in your browser with the code shown, and the token is made here.' : `Paste a personal access token made on ${host.host} for this computer; it goes to glab once and Kestrel keeps it nowhere.`;
      lines.push({ id: `host:${tool}:${host.host}`, group: 'git', kind: 'here', title: `Sign in to ${tool} on ${host.host}${host.user ? ` as ${host.user}` : ''}`, does, secrets: web ? [] : ['a personal access token'], action: { kind: 'host-sign-in', tool, host: host.host, protocol, web }, run: 'user', command: { shell, text: commandText(argv.filter((a) => a !== '--stdin'), shell) }, done: (h) => h.hosts.some((x) => x.tool === tool && x.host === host.host && x.signedIn) });
    }
  }
  if (g.signs) lines.push({ id: 'git:signing', group: 'git', kind: 'cannot', title: `Commit signing${g.format ? ` (${g.format === 'openpgp' ? 'OpenPGP' : g.format.toUpperCase()})` : ''}`, does: `The signing key stays on ${other.machine.name}. Later, ${machine(platform)} signs with its own SSH key, or does not sign.`, secrets: [], action: null, askAgent: false, done: (h) => h.git.signs });
  if (other.ssh.hosts.length > 0) {
    const names = other.ssh.hosts.map((s) => s.host);
    const dropped = platform !== 'mac' ? [...new Set(other.ssh.hosts.flatMap((s) => s.options.filter((o) => /^(UseKeychain|AddKeysToAgent)$/i.test(o))))] : [];
    const notBrought = [...new Set(other.ssh.hosts.flatMap((s) => s.options))].filter((o) => !dropped.includes(o));
    lines.push({
      id: 'ssh:config',
      group: 'git',
      kind: 'bring',
      title: `SSH hosts: ${names.join(', ')}`,
      does: `Adds the hosts that are not there yet to ~/.ssh/config: HostName, User, Port, and IdentityFile where that file is here${dropped.length ? `, without ${dropped.join(' and ')} (Mac only)` : ''}.${notBrought.length ? ` Not brought (their values stay on ${other.machine.name}): ${notBrought.join(', ')}.` : ''} Private keys never leave ${other.machine.name}.`,
      secrets: [],
      action: { kind: 'ssh-hosts', hosts: other.ssh.hosts },
      run: 'user',
      // As the step itself reads it: the config on this disk. This computer's record carries no host at all when
      // its config has a line that looks like a key, and the step would then say done while this said not.
      done: (h) => {
        const have = checks.sshHosts?.() ?? h.ssh.hosts.map((s) => s.host);
        return names.every((n) => have.includes(n));
      },
    });
  }
  // This computer's own key, for each host a project's SSH remote is on (18.2).
  const sshHosts = [...new Set(other.projects.flatMap((p) => p.folders.flatMap((f) => (f.origin ? [sshHostOf(f.origin)] : []))).filter((h): h is string => !!h))];
  for (const host of sshHosts) {
    const cli = other.hosts.find((h) => h.host === host && h.signedIn)?.tool ?? (host === 'github.com' ? 'gh' : null);
    // Neither program takes a host for this: outside a repository each goes to its own default (github.com,
    // gitlab.com) unless told, so the host is named for it (`sshKeyHostEnv`).
    const hostEnv = cli ? sshKeyHostEnv(cli, host) : null;
    const told = hostEnv ? (shell === 'sh' ? `${Object.entries(hostEnv).map(([k, v]) => `${k}=${v}`).join(' ')} ` : `${Object.entries(hostEnv).map(([k, v]) => `$env:${k}='${v}';`).join(' ')} `) : '';
    const add = cli ? `${told}${cli} ssh-key add ~/.ssh/id_ed25519.pub --title ${commandText([here.machine.name], shell)}` : null;
    // As the step does it: a key that is already there is kept, never asked about or replaced.
    const make = `ssh-keygen -t ed25519 -N "" -C ${commandText([here.machine.name], shell)} -f ~/.ssh/id_ed25519`;
    const keygen = shell === 'sh' ? `test -f ~/.ssh/id_ed25519 || ${make}` : make;
    lines.push({
      id: `ssh-key:${host}`,
      group: 'git',
      kind: 'here',
      title: `This computer's SSH key for ${host}`,
      does: `Makes ~/.ssh/id_ed25519 when there is none (no passphrase), then ${add ? `adds its public half at ${host} through ${cli}` : `shows its public half to add at ${host} yourself`}. No private key is copied.`,
      secrets: [],
      action: { kind: 'ssh-key', host, tool: cli },
      run: 'user',
      command: { shell, text: [keygen, add].filter(Boolean).join('\n') },
      // Done once a project on that host is cloned here, or the key step reached it this run.
      done: (h) => h.projects.some((p) => p.folders.some((f) => !!f.origin && sshHostOf(f.origin) === host)) || (checks.sshReaches?.(host) ?? false),
    });
  }
  return lines;
}

function toolLines(other: SetupRecord, here: SetupRecord, checks: SetupChecks): Draft[] {
  const platform = here.machine.platform;
  return other.tools.map((t): Draft => {
    const done = () => checks.tool(t.name);
    const why = t.why.join('; ');
    if (t.name === 'Xcode' && platform !== 'mac') return { id: `tool:${t.name}`, group: 'tools', kind: 'cannot', title: 'Xcode', does: `Xcode runs only on a Mac (needed for ${why}).`, secrets: [], action: null, askAgent: false, done: () => false };
    const recipe = installRecipeOf(t.name, platform, checks.host ?? NO_HOST, t.why);
    const action: SetupAction | null = recipe ? { kind: 'install', tool: t.name, why: t.why } : null;
    if (t.name === 'Xcode') return { id: `tool:${t.name}`, group: 'tools', kind: 'install', title: 'Xcode', does: `Opens Xcode in the App Store, which needs your Apple sign-in (needed for ${why}).`, secrets: [], action, ...routeOf(recipe), done };
    const how = !recipe ? 'Kestrel does not know how to install it here: install it the way you usually do.' : recipe.run === 'user' ? 'Runs this as you.' : recipe.run === 'os-prompt' ? 'Runs this; your operating system asks for an administrator itself.' : recipe.run === 'paste' ? 'It needs an administrator: paste this into a terminal, then Check again.' : 'Opens its download page.';
    return { id: `tool:${t.name}`, group: 'tools', kind: 'install', title: t.name, does: `${how} Needed for ${why}.`, secrets: [], action, ...routeOf(recipe), done };
  });
}

/** Whether two git addresses are one repository, however each is written (ssh or https, with or without `.git`). */
const sameRepo = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && (a === b || (repositoryKey(a) !== null && repositoryKey(a) === repositoryKey(b)));

function projectLines(other: SetupRecord, here: SetupRecord, checks: SetupChecks): Draft[] {
  const shell = shellOf(here.machine.platform);
  return other.projects.flatMap((p) =>
    p.folders.map((f): Draft => {
      const title = p.folders.length > 1 ? `${p.name}: ${f.name}` : p.name;
      const done = (h: SetupRecord) => h.projects.some((q) => q.folders.some((g) => (f.origin ? sameRepo(g.origin, f.origin) : q.name === p.name && g.name === f.name)));
      if (!f.origin) return { id: `project:${p.name}:${f.name}`, group: 'projects', kind: 'cannot', title, does: `${f.path} has no origin remote on ${other.machine.name}, so there is nothing to clone: copy it by hand.`, secrets: [], action: null, done };
      // Cloned here already (by hand, say) and not yet a project in Kestrel: nothing is cloned again, it is only added.
      if (sameRepo(checks.originAt?.(f.path), f.origin)) return { id: `project:${f.origin}`, group: 'projects', kind: 'bring', title: `Add ${title} to Kestrel`, does: `It is already cloned at ${f.path}. This adds it to Kestrel as ${p.name}; nothing is cloned again.`, secrets: [], action: { kind: 'clone', origin: f.origin, path: f.path, project: p.name, folder: f.name }, run: 'user', askAgent: false, done };
      return { id: `project:${f.origin}`, group: 'projects', kind: 'bring', title: `Clone ${title}`, does: `Clones ${f.origin} into ${f.path} and adds it to Kestrel as ${p.name}.`, secrets: [], action: { kind: 'clone', origin: f.origin, path: f.path, project: p.name, folder: f.name }, run: 'user', command: { shell, text: commandText(['git', 'clone', f.origin, f.path], shell) }, askAgent: true, done };
    }),
  );
}

/** Package runners that download what they run the first time: the package is named, as a download, not a step. */
const FETCHERS = new Set(['uvx', 'npx', 'bunx', 'pipx']);

/** What a local-command server needs on this machine, in words (18.11). Nothing is guessed. Pure. */
export function mcpNeedsText(s: SetupMcpServer, other: SetupRecord, here: SetupRecord, checks: SetupChecks): string {
  if (s.transport !== 'stdio' || !s.command) return '';
  const word = s.command.trim().split(/\s+/)[0] ?? '';
  const runner = mcpRunnerTool(s.command);
  if (runner) {
    const recipe = checks.tool(runner) ? null : installRecipeOf(runner, here.machine.platform, checks.host ?? NO_HOST);
    const need = checks.tool(runner) ? '' : recipe?.command ? ` Needs ${runner}: ${recipe.command.text}.` : ` Needs ${runner}.`;
    const pkg = FETCHERS.has(word) ? s.args.find((a) => !!a && !a.startsWith('-')) : undefined;
    return `${need}${pkg ? ` ${word} fetches ${pkg} the first time the server starts.` : ''}`;
  }
  const name = word.slice(word.lastIndexOf('/') + 1);
  const found = word.includes('/') ? checks.exists?.(word) : checks.tool(word);
  if (found === undefined) return '';
  return found ? ` ${name} is here.` : ` Runs ${name}. Kestrel does not know how ${name} was installed on ${other.machine.name}.`;
}

function mcpLines(other: SetupRecord, here: SetupRecord, checks: SetupChecks): Draft[] {
  return other.mcp.map((s): Draft => {
    const state = (h: SetupRecord) => checks.mcp?.(s.name) ?? (h.mcp.some((m) => m.name === s.name) ? 'ready' : 'missing');
    const done = (h: SetupRecord) => state(h) === 'ready';
    const secrets = [...new Set(s.blanks.map(blankText))];
    const what = s.transport === 'stdio' ? `runs ${[s.command, ...s.args.map((a) => a ?? '…')].filter(Boolean).join(' ')}` : `connects to ${s.url ?? 'an address left out'}`;
    if (s.appProgram && here.machine.platform !== 'mac') return { id: `mcp:${s.name}`, group: 'mcp', kind: 'cannot', title: s.name, does: `It runs a program inside ${s.appProgram}, a Mac app.`, secrets: [], action: null, askAgent: false, done };
    const app = s.appProgram ? ` It needs ${s.appProgram} installed here; Kestrel cannot install it.` : mcpNeedsText(s, other, here, checks);
    // In Kestrel's list already, with a value still to enter: finished on the server's own page.
    if (state(here) === 'needs-values') return { id: `mcp:${s.name}`, group: 'mcp', kind: 'bring', title: s.name, does: `It is in Kestrel's own MCP servers, without its values; it ${what}. Copy them from a computer that has them, or enter them on its page.${app}`, secrets, action: null, page: `#/settings/agent-setup/mcp/${encodeURIComponent(listNameOf(s.name))}`, askAgent: false, done };
    return { id: `mcp:${s.name}`, group: 'mcp', kind: 'bring', title: s.name, does: `Adds it to Kestrel's own MCP servers, which hands it to sessions; it ${what}.${app}${secrets.length ? ' Then you enter each value on its page.' : ''}`, secrets, action: { kind: 'mcp', server: s }, run: 'user', askAgent: s.transport === 'stdio', done };
  });
}

const FILE_WORDS = { instructions: 'instructions', rules: 'rules', skill: 'skill', settings: 'settings' } as const;

/** The kinds of file shown as one line per agent; an instructions or settings file is always its own. */
type GroupedKind = Extract<SetupFileKind, 'skill' | 'rules'>;
const GROUPED: ReadonlySet<SetupFileKind> = new Set<GroupedKind>(['skill', 'rules']);
/** A file goes into its agent's line unless it is an exception: a key was found in it, or it needs a value entered here. */
const grouped = (f: SetupFile): f is SetupFile & { kind: GroupedKind } => GROUPED.has(f.kind) && !f.keyAt && f.env.length === 0;
const UNIT: Record<GroupedKind, string> = { skill: 'skill', rules: 'rules file' };
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

function fileLine(f: SetupFile): Draft {
  const done = (h: SetupRecord) => h.files.some((x) => x.path === f.path);
  const title = `${AGENT_LABEL[f.agent]} ${FILE_WORDS[f.kind]}: ${f.path}`;
  if (f.keyAt) return { id: `file:${f.path}`, group: 'settings', kind: 'cannot', title, does: `${f.keyAt.path} line ${f.keyAt.line} looks like a key. Remove it there to bring ${f.kind === 'skill' ? 'this skill' : 'this file'}.`, secrets: [], action: null, askAgent: false, done };
  const does = f.kind === 'settings' ? `Writes ${f.path}${f.env.length ? ' without the values in its env block' : ''}${f.plugins.length ? `, with ${plural(f.plugins.length, 'plugin')} for Claude to install` : ''}.` : `Copies ${plural(f.files, 'file')} into ${f.path}.`;
  return { id: `file:${f.path}`, group: 'settings', kind: 'bring', title, does, secrets: f.env, action: { kind: 'files', agent: f.agent, paths: [f.path] }, run: 'user', done };
}

/** The Agent settings lines from one machine: each agent's skills one line, its rules one line, at the place of the first. */
function fileLines(other: SetupRecord, here: SetupRecord): Draft[] {
  const drafts: Draft[] = [];
  const bundles = new Map<string, Bundle>();
  for (const f of other.files) {
    if (!grouped(f)) {
      drafts.push(fileLine(f));
      continue;
    }
    const id = `files:${f.agent}:${f.kind}`;
    const member = { path: f.path, files: f.files, done: here.files.some((x) => x.path === f.path) };
    const bundle = bundles.get(id);
    if (bundle) {
      bundle.members.push(member);
      continue;
    }
    const fresh: Bundle = { agent: f.agent, kind: f.kind, members: [member] };
    bundles.set(id, fresh);
    // Title, does and the check are worked out once every machine's members are in (`bundledLine`).
    drafts.push({ id, group: 'settings', kind: 'bring', title: '', does: '', secrets: [], action: null, run: 'user', askAgent: false, done: () => false, bundle: fresh });
  }
  return drafts;
}

/** Two machines' members of one grouped line, as one list by path. */
function mergeBundles(a: Bundle, b: Bundle): Bundle {
  const known = new Set(a.members.map((m) => m.path));
  return { ...a, members: [...a.members, ...b.members.filter((m) => !known.has(m.path))] };
}

/** A grouped line as the page shows it: how many, how many are here, and the names inside. */
function bundledLine(line: Omit<SetupLine, 'items' | 'done'>, bundle: Bundle): SetupLine {
  const members = [...bundle.members].sort((x, y) => x.path.localeCompare(y.path));
  const weight = (m: Member) => (bundle.kind === 'rules' ? m.files : 1);
  const total = members.reduce((n, m) => n + weight(m), 0);
  const here = members.reduce((n, m) => n + (m.done ? weight(m) : 0), 0);
  const names = members.map((m) => ({ name: bundle.kind === 'skill' ? baseName(m.path) : `${m.path} (${plural(m.files, 'file')})`, done: m.done }));
  const where = [...new Set(members.map((m) => (bundle.kind === 'skill' ? parentOf(m.path) : m.path)))].join(' and ');
  const does = bundle.kind === 'skill' ? `Copies each skill that is not here yet into ${where}.` : `Copies the rules files into ${where}.`;
  return {
    ...line,
    title: `${AGENT_LABEL[bundle.agent]}: ${plural(total, UNIT[bundle.kind])}`,
    does,
    action: { kind: 'files', agent: bundle.agent, paths: members.map((m) => m.path) },
    done: here === total,
    items: { names, here, total, progress: here > 0 && here < total ? `${here} of ${total} here` : null },
  };
}

/** Fully defined steps: Kestrel knows exactly what to do (18.12). Every other kind offers Ask the agent. */
const FULLY_DEFINED: ReadonlySet<SetupAction['kind']> = new Set(['git-identity', 'ssh-hosts', 'files', 'mcp', 'models']);

/** Whether a line's step is fully defined: no judgment, nothing of the person's needed. Pure. */
export const fullyDefined = (line: Pick<SetupLine, 'action' | 'run' | 'secrets'>): boolean => line.action !== null && FULLY_DEFINED.has(line.action.kind) && line.run === 'user';

/** A tool a recipe needs first (Homebrew, Node) that is not here and not on the list: a line of its own. */
function neededTools(lines: readonly SetupLine[], here: SetupRecord, checks: SetupChecks): SetupLine[] {
  const ids = new Set(lines.map((l) => l.id));
  const added: SetupLine[] = [];
  for (const line of lines) {
    const recipe = line.action?.kind === 'install' ? installRecipeOf(line.action.tool, here.machine.platform, checks.host ?? NO_HOST, line.action.why) : line.action?.kind === 'agent-install' ? agentRecipeOf(line.action.agent, here.machine.platform, checks.host ?? NO_HOST) : null;
    // An MCP server's command needs its runner (uv for `uvx`), made a line here when no record had one (18.11).
    const runner = line.action?.kind === 'mcp' ? mcpRunnerTool(line.action.server.command) : null;
    const tool = recipe?.needs ?? runner;
    if (!tool || ids.has(`tool:${tool}`) || checks.tool(tool)) continue;
    ids.add(`tool:${tool}`);
    const need = installRecipeOf(tool, here.machine.platform, checks.host ?? NO_HOST);
    const how = tool === HOMEBREW ? "Homebrew's own installer asks for an administrator: paste this into a terminal, then Check again." : need ? 'Runs this as you.' : `Install ${tool} the way you usually do.`;
    added.push({ id: `tool:${tool}`, group: 'tools', kind: 'install', title: tool, does: `${how} ${runner ? `Needed by the ${line.title} MCP server` : `Needed to install ${line.title.replace(/^Install /, '')}`}.`, from: line.from, secrets: [], done: false, action: need && need.run !== 'paste' ? { kind: 'install', tool, why: [] } : null, ...routeOf(need), page: null, needs: [], dismissed: false, askAgent: true, items: null });
  }
  return added;
}

/** The knowledge base line (18.15): the other computer's, unless this one already uses it. */
function knowledgeLines(other: SetupRecord, checks: SetupChecks): Draft[] {
  const k = other.knowledge;
  if (!k) return [];
  const current = checks.knowledge ?? null;
  const replacing = current && current.repo !== k.repo ? ` This computer uses ${current.name} now; Run asks before replacing it.` : '';
  return [{
    id: `knowledge:${k.repo}`,
    group: 'knowledge',
    kind: 'bring',
    title: `Use ${k.name} as the knowledge base`,
    does: `Sets ${k.name} (${k.repo}) as the knowledge base sessions here read, as Settings → Workflow → Knowledge base does.${replacing}`,
    secrets: [],
    action: { kind: 'knowledge', repo: k.repo, name: k.name },
    run: 'user',
    page: '#/settings/workflow',
    askAgent: false,
    done: () => current?.repo === k.repo,
  }];
}

/** The model presets and roles line (onboarding.md 19): one per computer that has presets, merged in, never replacing. */
function modelsLines(other: SetupRecord, here: SetupRecord, checks: SetupChecks): Draft[] {
  const models = other.models;
  if (!models || models.who.presets.length === 0) return [];
  const current = checks.whoDoesWhat ?? here.models?.who ?? NOBODY;
  const merge = mergeWhoDoesWhat(current, models.who, () => 'new');
  const doing = mergeDoesText(merge);
  // A preset for an agent that cannot run here yet is still brought: its roles go to the next choice until it can.
  const notReady = [...new Set(merge.added.map((p) => p.agent))].filter((a) => !here.agents.some((h) => h.agent === a && h.state === 'ready'));
  const waits = notReady.length > 0 ? ` ${andList(notReady.map((a) => AGENT_LABEL[a]))} ${notReady.length === 1 ? 'is' : 'are'} not ready here yet; until then, a role on ${notReady.length === 1 ? 'its' : 'their'} presets goes to its next choice.` : '';
  const note = models.instructionLeftOut ? ' The note on who does what is not brought: something in it looks like a key.' : '';
  const does = doing ? `${doing}, as Settings → Models & roles would. Nothing here is replaced.${mergeLeftText(merge)}${waits}${note}` : `This computer already has ${other.machine.name}'s presets and roles.${mergeLeftText(merge)}${note}`;
  return [{
    id: `models:${other.machine.id}`,
    group: 'kestrel',
    kind: 'bring',
    title: 'Model presets and roles',
    does,
    secrets: [],
    action: { kind: 'models', who: models.who, instructionLeftOut: models.instructionLeftOut },
    run: 'user',
    page: '#/settings/presets',
    askAgent: false,
    done: () => mergeDone(merge),
  }];
}

/** Who a line's missing values may be copied from: only a line not done that names values (onboarding.md 19). */
function copyOf(line: SetupLine, others: readonly SetupRecord[], checks: SetupChecks): SetupCopy | null {
  if (line.done || line.secrets.length === 0) return null;
  const step = copyStepOf(line.id);
  if (!step) return null;
  const missing = step.kind === 'mcp' ? (checks.mcpMissing?.(step.server) ?? 'all') : 'all';
  return copyOffersOf(line.id, others, missing);
}

/** The list for `here`, from every other machine's record. Pure. */
export function setupListOf(here: SetupRecord, records: readonly SetupRecord[], checks: SetupChecks): SetupList {
  const others = records.filter((r) => r.machine.id !== here.machine.id);
  const host = checks.host ?? NO_HOST;
  const lines = new Map<string, Omit<SetupLine, 'items'> & { bundle?: Bundle }>();
  for (const other of others) {
    const drafts = [...agentLines(other, here, host), ...gitLines(other, here, checks), ...toolLines(other, here, checks), ...projectLines(other, here, checks), ...mcpLines(other, here, checks), ...fileLines(other, here), ...knowledgeLines(other, checks), ...modelsLines(other, here, checks)];
    for (const { done, ...draft } of drafts) {
      const seen = lines.get(draft.id);
      const bundle = seen?.bundle && draft.bundle ? mergeBundles(seen.bundle, draft.bundle) : (seen?.bundle ?? draft.bundle);
      if (seen) lines.set(draft.id, { ...seen, from: [...seen.from, other.machine.name], secrets: [...new Set([...seen.secrets, ...draft.secrets])], bundle });
      else {
        const full = { run: null, command: null, url: null, page: null, ...draft, needs: [], dismissed: false, askAgent: false, from: [other.machine.name], done: done(here) };
        lines.set(draft.id, { ...full, askAgent: draft.askAgent ?? (full.kind !== 'cannot' && !fullyDefined(full)) });
      }
    }
  }
  const order = new Map(SETUP_GROUPS.map((g, i) => [g.id, i]));
  const built = [...lines.values()].map(({ bundle, ...line }): SetupLine => (bundle ? bundledLine(line, bundle) : { ...line, items: null }));
  const finished = [...built, ...neededTools(built, here, checks)];
  const withNeeds = finished.map((line) => ({ ...line, needs: setupNeedsOf(line, finished), copy: copyOf(line, others, checks) }));
  return {
    here: here.machine,
    others: others.map((r) => ({ id: r.machine.id, name: r.machine.name, readAt: r.readAt })),
    lines: withNeeds.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0)),
    // A tool that is missing is said by its own Install line, not twice.
    problems: here.problems.map((p) => p.reason).filter((reason) => !lines.has(`tool:${/^(\S+) is not installed\.$/.exec(reason)?.[1] ?? ''}`)),
  };
}

/** Whether a line is still to do: not already here, not a thing that cannot come, not dismissed. Pure. */
/**
 * How `gh` or `glab` is told which host a key is added at, as environment for the command: nothing for the
 * host each defaults to. Without it `glab ssh-key add` posts to gitlab.com whatever host you signed in to. Pure.
 */
export function sshKeyHostEnv(tool: HostTool, host: string): Record<string, string> | null {
  if (tool === 'gh') return host === 'github.com' ? null : { GH_HOST: host };
  return host === 'gitlab.com' ? null : { GITLAB_HOST: host };
}

/**
 * What a step's button says. A step with a terminal command runs it, so "Run". A step with none changes
 * something in Kestrel or copies files, and says which, so nobody wonders what would run. Pure.
 */
export function setupActLabel(line: Pick<SetupLine, 'action' | 'command' | 'run' | 'from'>): string {
  if (line.run === 'open') return 'Open';
  if (line.command || !line.action) return 'Run';
  switch (line.action.kind) {
    // What is brought is the other computer's own: its definition, its files, its hosts. Never a value.
    case 'mcp':
    case 'files':
    case 'ssh-hosts':
    case 'models':
      return `Copy from ${copySourceText(line.from)}`;
    case 'knowledge':
      return 'Use as knowledge base';
    // A clone with no command to show is one that is already on disk: only Kestrel's own list changes.
    case 'clone':
      return 'Add to Kestrel';
    default:
      return 'Run';
  }
}

/** Where a copy comes from, in a button: the one computer that has it, or "your other computers". Pure. */
export function copySourceText(from: readonly string[]): string {
  // One computer may be named twice when it has the thing in two places.
  const names = [...new Set(from)];
  return names.length === 1 ? names[0]! : 'your other computers';
}

/**
 * What a step still needs on this computer, in words: environment variables are called that; anything
 * else (a token) is named as it is. The row's note says how they get here (`missingNote` in
 * setup-values.ts: copied from another computer, or entered here). Pure.
 */
export function missingText(secrets: readonly string[]): string {
  if (secrets.length === 0) return '';
  const env = secrets.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
  return env ? `Missing environment ${secrets.length === 1 ? 'variable' : 'variables'}` : 'Missing';
}

export const setupToDo = (line: Pick<SetupLine, 'done' | 'kind'> & Partial<Pick<SetupLine, 'dismissed'>>): boolean => !line.done && line.kind !== 'cannot' && line.dismissed !== true;

/** How many lines are left to do. Pure. */
export const setupLeft = (list: Pick<SetupList, 'lines'>): number => list.lines.filter(setupToDo).length;
