// What each line of the set-up list needs done first (docs/designs/onboarding.md, 18.4): one function,
// read from the line's own action, naming only lines that are on the list. A need is met when its line
// is done. Running a section, a line, or a step the agent asks for all read it from here. Pure and
// browser-safe.
import type { SetupLine } from './setup-list.ts';
import { repositoryKey } from './knowledge.ts';

/** The host of a git remote reached over SSH (`git@host:path`, `ssh://…`), or null. */
export function sshHostOf(origin: string): string | null {
  if (/^ssh:\/\//i.test(origin)) {
    try {
      return new URL(origin).hostname || null;
    } catch {
      return null;
    }
  }
  if (origin.includes('://')) return null;
  return /^(?:[^@/:\s]+@)?([A-Za-z0-9.-]+):/.exec(origin)?.[1] ?? null;
}

/** The host of a git remote reached over HTTPS, or null. */
export function httpsHostOf(origin: string): string | null {
  if (!/^https?:\/\//i.test(origin)) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/** The program an MCP server's command runs, as a tool line's name: `uvx` is uv's, `npx` is Node's. */
export function mcpRunnerTool(command: string | null): string | null {
  const word = (command ?? '').trim().split(/\s+/)[0] ?? '';
  if (!word || /[/\\]/.test(word)) return null;
  const known: Record<string, string> = { uvx: 'uv', uv: 'uv', npx: 'node', node: 'node', bunx: 'bun', bun: 'bun', pipx: 'pipx', deno: 'deno', python: 'python', python3: 'python', docker: 'docker' };
  return known[word] ?? null;
}

/** An install's route needs what its command runs first: Homebrew for `brew`, Node for `npm`. */
function runnerNeeds(line: SetupLine): string[] {
  const first = line.command?.text.split(/\s+/)[0] ?? '';
  return first === 'brew' ? ['tool:Homebrew'] : first === 'npm' ? ['tool:node'] : [];
}

/** The ids a line would need, before keeping only those on the list. */
function wanted(line: SetupLine, lines: readonly SetupLine[]): string[] {
  const a = line.action;
  if (!a) return [];
  switch (a.kind) {
    case 'agent-install':
    case 'install':
      return runnerNeeds(line);
    case 'sign-in':
      return [`agent:${a.agent}:install`];
    case 'host-sign-in':
      return [`tool:${a.tool}`];
    case 'ssh-key':
      return lines.filter((l) => l.action?.kind === 'host-sign-in' && l.action.host === a.host).map((l) => l.id);
    case 'clone': {
      // Already cloned here (it has no command to show): adding it to Kestrel needs nothing first.
      if (!line.command) return [];
      const ssh = sshHostOf(a.origin);
      const https = httpsHostOf(a.origin);
      const host = ssh ?? https;
      const signIns = host ? lines.filter((l) => l.action?.kind === 'host-sign-in' && l.action.host === host).map((l) => l.id) : [];
      // Git identity first (Matt's example, 18.13 Q4), so the first commit there is the person's.
      const identity = lines.filter((l) => l.action?.kind === 'git-identity').map((l) => l.id);
      return ['tool:git', ...identity, ...(ssh ? [`ssh-key:${ssh}`] : signIns)];
    }
    case 'mcp': {
      const tool = mcpRunnerTool(a.server.command);
      const inProject = lines.filter((l) => l.action?.kind === 'clone' && [a.server.command, ...a.server.args].some((x) => !!x && (x === (l.action as { path: string }).path || x.startsWith(`${(l.action as { path: string }).path}/`))));
      return [...(tool ? [`tool:${tool}`] : []), ...inProject.map((l) => l.id)];
    }
    case 'files': {
      const install = [`agent:${a.agent}:install`];
      // A settings file needs the tools its hooks run (the tool lines say "a hook in Claude's settings").
      const hooks = a.agent === 'claude' && a.paths.some((p) => /settings(\.local)?\.json$/.test(p)) ? lines.filter((l) => l.group === 'tools' && /a hook in Claude's settings/.test(l.does)).map((l) => l.id) : [];
      return [...install, ...hooks];
    }
    case 'knowledge':
      // Its repository cloned here first; a project already registered here has no clone line.
      return lines.filter((l) => l.action?.kind === 'clone' && repositoryKey(l.action.origin) === a.repo).map((l) => l.id);
    case 'git-identity':
    case 'ssh-hosts':
    // The presets are brought whether or not their agents are here (a role falls to its next choice meanwhile).
    case 'models':
      return [];
  }
}

/** The ids of the lines `line` needs done first, each on the list and none itself. Pure. */
export function setupNeedsOf(line: SetupLine, lines: readonly SetupLine[]): string[] {
  const ids = new Set(lines.map((l) => l.id));
  return [...new Set(wanted(line, lines))].filter((id) => id !== line.id && ids.has(id));
}

/** The needs of a line that are not met, as lines: not done here. Pure. */
export function unmetNeeds(line: Pick<SetupLine, 'needs'>, lines: readonly SetupLine[]): SetupLine[] {
  return line.needs.flatMap((id) => lines.filter((l) => l.id === id && !l.done));
}
