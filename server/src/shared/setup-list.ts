// The set-up list (docs/designs/onboarding.md, sections 3, 7 and 8): what the other machines of the
// account have that this one lacks, built from their set-up records and this machine's own, read again
// each time the page opens so every line's check is current. One line per thing, in seven groups, in
// the order the work needs them. Each line has a kind (brought over, done here, installed here, cannot
// be brought), says in one sentence what it does, names the secrets it will need, and knows whether it
// is already done here. In stage 1 only the Claude and Codex sign-ins act. Pure and browser-safe.
import { AGENT_LABEL, type Agent } from '../model.ts';
import type { Platform } from './platform.ts';
import { blankText, type SetupRecord } from './setup-record.ts';

export type SetupGroup = 'agents' | 'git' | 'tools' | 'projects' | 'mcp' | 'settings' | 'kestrel';

export const SETUP_GROUPS: readonly { id: SetupGroup; title: string }[] = [
  { id: 'agents', title: 'Agents' },
  { id: 'git', title: 'Git' },
  { id: 'tools', title: 'Tools' },
  { id: 'projects', title: 'Projects' },
  { id: 'mcp', title: 'MCP servers' },
  { id: 'settings', title: 'Agent settings' },
  { id: 'kestrel', title: 'Kestrel' },
];

export type SetupLineKind = 'bring' | 'here' | 'install' | 'cannot';

/** The kind's chip: brought over, done here with a click, installed here, cannot be brought. */
export const SETUP_KIND_TEXT: Record<SetupLineKind, string> = { bring: 'Bring over', here: 'Do here', install: 'Install here', cannot: 'Cannot bring' };

/** What a line's button does now. Only these act in stage 1; every other line says what it will do. */
export type SetupAction = { kind: 'sign-in'; agent: Extract<Agent, 'claude' | 'codex'> };

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
  action: SetupAction | null;
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
}

const LATER = 'A later version of Kestrel does this from here.';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const machine = (platform: Platform) => (platform === 'mac' ? 'this Mac' : 'this computer');

type Draft = Omit<SetupLine, 'from' | 'done'> & { done: (here: SetupRecord) => boolean };

function agentLines(other: SetupRecord, here: SetupRecord): Draft[] {
  return other.agents
    .filter((a) => a.state === 'ready')
    .map((a): Draft => {
      const label = AGENT_LABEL[a.agent];
      const mine = here.agents.find((h) => h.agent === a.agent)?.state ?? 'missing';
      const done = (h: SetupRecord) => h.agents.some((x) => x.agent === a.agent && x.state === 'ready');
      if (mine === 'missing') return { id: `agent:${a.agent}`, group: 'agents', kind: 'install', title: `Install ${label}`, does: `Installs ${label} on ${machine(here.machine.platform)}, then signs it in. ${LATER}`, secrets: [], action: null, done };
      if (a.agent === 'opencode') return { id: `agent:${a.agent}`, group: 'agents', kind: 'here', title: `Sign in to ${label}`, does: 'OpenCode signs in to each model provider in its own prompt: run `opencode auth login` in a terminal here.', secrets: [], action: null, done };
      return { id: `agent:${a.agent}`, group: 'agents', kind: 'here', title: `Sign in to ${label}`, does: `Runs ${label}'s own sign-in, which opens in your browser. Use the account ${other.machine.name} uses; nothing is copied from it.`, secrets: [], action: { kind: 'sign-in', agent: a.agent }, done };
    });
}

function gitLines(other: SetupRecord, here: SetupRecord): Draft[] {
  const lines: Draft[] = [];
  const g = other.git;
  if (g.name || g.email) {
    const who = [g.name, g.email && `<${g.email}>`].filter(Boolean).join(' ');
    lines.push({ id: `git:identity:${who}`, group: 'git', kind: 'bring', title: `Git identity: ${who}`, does: `Sets user.name and user.email in your global git settings. ${LATER}`, secrets: [], action: null, done: (h) => h.git.name === g.name && h.git.email === g.email });
  }
  for (const tool of ['gh', 'glab'] as const) {
    const hosts = other.hosts.filter((h) => h.tool === tool && h.signedIn);
    if (hosts.length === 0) continue;
    if (here.problems.some((p) => p.reason === `${tool} is not installed.`)) lines.push({ id: `tool:${tool}`, group: 'git', kind: 'install', title: `Install ${tool}`, does: `Installs ${tool}, so this machine can sign in to ${hosts.map((h) => h.host).join(' and ')}. ${LATER}`, secrets: [], action: null, done: (h) => !h.problems.some((p) => p.reason === `${tool} is not installed.`) });
    for (const host of hosts) {
      const command = tool === 'gh' ? `gh auth login --web --hostname ${host.host}` : `glab auth login --hostname ${host.host}`;
      lines.push({ id: `host:${tool}:${host.host}`, group: 'git', kind: 'here', title: `Sign in to ${tool} on ${host.host}${host.user ? ` as ${host.user}` : ''}`, does: `Runs \`${command}\`; you sign in in your browser, and the token is made here. ${LATER}`, secrets: [], action: null, done: (h) => h.hosts.some((x) => x.tool === tool && x.host === host.host && x.signedIn) });
    }
  }
  if (g.signs) lines.push({ id: 'git:signing', group: 'git', kind: 'cannot', title: `Commit signing${g.format ? ` (${g.format === 'openpgp' ? 'OpenPGP' : g.format.toUpperCase()})` : ''}`, does: `The signing key stays on ${other.machine.name}. Later, ${machine(here.machine.platform)} signs with its own SSH key, or does not sign.`, secrets: [], action: null, done: (h) => h.git.signs });
  if (other.ssh.hosts.length > 0) {
    const names = other.ssh.hosts.map((s) => s.host);
    const keys = [...new Set(other.ssh.hosts.flatMap((s) => s.identityFiles))];
    const dropped = here.machine.platform !== 'mac' ? [...new Set(other.ssh.hosts.flatMap((s) => s.options.filter((o) => /^(UseKeychain|AddKeysToAgent)$/i.test(o))))] : [];
    lines.push({
      id: 'ssh:config',
      group: 'git',
      kind: 'bring',
      title: `SSH hosts: ${names.join(', ')}`,
      does: `Adds these hosts to ~/.ssh/config${dropped.length ? `, without ${dropped.join(' and ')}` : ''}. Private keys never leave ${other.machine.name}${keys.length ? ` (${keys.join(', ')})` : ''}: ${machine(here.machine.platform)} makes its own. ${LATER}`,
      secrets: [],
      action: null,
      done: (h) => names.every((n) => h.ssh.hosts.some((s) => s.host === n)),
    });
  }
  return lines;
}

function toolLines(other: SetupRecord, here: SetupRecord, checks: SetupChecks): Draft[] {
  return other.tools.map((t): Draft => {
    const done = () => checks.tool(t.name);
    const why = t.why.join('; ');
    if (t.name === 'Xcode' && here.machine.platform !== 'mac') return { id: `tool:${t.name}`, group: 'tools', kind: 'cannot', title: 'Xcode', does: `Xcode runs only on a Mac (needed for ${why}).`, secrets: [], action: null, done: () => false };
    if (t.name === 'Xcode') return { id: `tool:${t.name}`, group: 'tools', kind: 'install', title: 'Xcode', does: `Opens Xcode in the App Store, which needs your Apple sign-in (needed for ${why}). ${LATER}`, secrets: [], action: null, done };
    return { id: `tool:${t.name}`, group: 'tools', kind: 'install', title: t.name, does: `Installs ${t.name} (needed for ${why}). ${LATER}`, secrets: [], action: null, done };
  });
}

function projectLines(other: SetupRecord): Draft[] {
  return other.projects.flatMap((p) =>
    p.folders.map((f): Draft => {
      const title = p.folders.length > 1 ? `${p.name}: ${f.name}` : p.name;
      const done = (h: SetupRecord) => h.projects.some((q) => q.folders.some((g) => (f.origin ? g.origin === f.origin : q.name === p.name && g.name === f.name)));
      if (!f.origin) return { id: `project:${p.name}:${f.name}`, group: 'projects', kind: 'cannot', title, does: `${f.path} has no origin remote on ${other.machine.name}, so there is nothing to clone: copy it by hand.`, secrets: [], action: null, done };
      return { id: `project:${f.origin}`, group: 'projects', kind: 'bring', title: `Clone ${title}`, does: `Clones ${f.origin} into ${f.path} and adds it to Kestrel. ${LATER}`, secrets: [], action: null, done };
    }),
  );
}

function mcpLines(other: SetupRecord, here: SetupRecord): Draft[] {
  return other.mcp.map((s): Draft => {
    const done = (h: SetupRecord) => h.mcp.some((m) => m.name === s.name);
    const secrets = [...new Set(s.blanks.map(blankText))];
    const what = s.transport === 'stdio' ? `runs ${[s.command, ...s.args.map((a) => a ?? '…')].filter(Boolean).join(' ')}` : `connects to ${s.url ?? 'an address left out'}`;
    if (s.appProgram && here.machine.platform !== 'mac') return { id: `mcp:${s.name}`, group: 'mcp', kind: 'cannot', title: s.name, does: `It runs a program inside ${s.appProgram}, a Mac app.`, secrets: [], action: null, done };
    const app = s.appProgram ? ` It needs ${s.appProgram} installed here.` : '';
    return { id: `mcp:${s.name}`, group: 'mcp', kind: 'bring', title: s.name, does: `Keeps it in Kestrel's own set-up and hands it to sessions; it ${what}.${app}${secrets.length ? ' You enter each value here.' : ''} ${LATER}`, secrets, action: null, done };
  });
}

const FILE_WORDS = { instructions: 'instructions', rules: 'rules', skill: 'skill', settings: 'settings' } as const;

function fileLines(other: SetupRecord): Draft[] {
  return other.files.map((f): Draft => {
    const done = (h: SetupRecord) => h.files.some((x) => x.path === f.path);
    const title = `${AGENT_LABEL[f.agent]} ${FILE_WORDS[f.kind]}: ${f.path}`;
    if (f.keyAt) return { id: `file:${f.path}`, group: 'settings', kind: 'cannot', title, does: `${f.keyAt.path} line ${f.keyAt.line} looks like a key. Remove it there to bring ${f.kind === 'skill' ? 'this skill' : 'this file'}.`, secrets: [], action: null, done };
    const does = f.kind === 'settings' ? `Writes ${f.path}${f.env.length ? ' without the values in its env block' : ''}${f.plugins.length ? `, with ${plural(f.plugins.length, 'plugin')} for Claude to install` : ''}.` : `Copies ${plural(f.files, 'file')} into ${f.path}.`;
    return { id: `file:${f.path}`, group: 'settings', kind: 'bring', title, does: `${does} ${LATER}`, secrets: f.env, action: null, done };
  });
}

/** The list for `here`, from every other machine's record. Pure. */
export function setupListOf(here: SetupRecord, records: readonly SetupRecord[], checks: SetupChecks): SetupList {
  const others = records.filter((r) => r.machine.id !== here.machine.id);
  const lines = new Map<string, SetupLine>();
  for (const other of others) {
    const drafts = [...agentLines(other, here), ...gitLines(other, here), ...toolLines(other, here, checks), ...projectLines(other), ...mcpLines(other, here), ...fileLines(other)];
    for (const { done, ...draft } of drafts) {
      const seen = lines.get(draft.id);
      if (seen) lines.set(draft.id, { ...seen, from: [...seen.from, other.machine.name], secrets: [...new Set([...seen.secrets, ...draft.secrets])] });
      else lines.set(draft.id, { ...draft, from: [other.machine.name], done: done(here) });
    }
  }
  const order = new Map(SETUP_GROUPS.map((g, i) => [g.id, i]));
  return {
    here: here.machine,
    others: others.map((r) => ({ id: r.machine.id, name: r.machine.name, readAt: r.readAt })),
    lines: [...lines.values()].sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0)),
    problems: here.problems.map((p) => p.reason),
  };
}

/** Whether a line is still to do: not already here, and not a thing that cannot come. Pure. */
export const setupToDo = (line: Pick<SetupLine, 'done' | 'kind'>): boolean => !line.done && line.kind !== 'cannot';

/** How many lines are left to do. Pure. */
export const setupLeft = (list: Pick<SetupList, 'lines'>): number => list.lines.filter(setupToDo).length;
