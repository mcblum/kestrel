// Git's steps (onboarding.md 18.2): the identity, SSH hosts, this computer's own SSH key, a `gh` or
// `glab` sign-in, and cloning a project. Every value from another computer's record is checked before it
// reaches a file or a program: host names and users are plain words, an origin is a git address that
// does not start with `-` and goes after `--`, a path stays inside this home folder. A token the person
// typed for `glab` goes to its standard input once and is kept nowhere. No private key is read or sent.
import { join } from 'node:path';
import { sshHostsOf } from '../shared/setup-record.ts';
import { repositoryKey } from '../shared/knowledge.ts';
import { sshKeyHostEnv, type SetupAction } from '../shared/setup-list.ts';
import { sshHostOf } from '../shared/setup-needs.ts';
import { capture, failed, LIMIT, realHomePath, runFor, type ExecuteDeps } from './execute.ts';
import type { StepContext, StepResult } from './steps.ts';

const WORD = /^[A-Za-z0-9._@%+-]{1,253}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;
/** How git reaches a host over SSH from a step: never a prompt; a new host's key is remembered (Matt, Q2). */
export const GIT_SSH = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' };

// ---- identity ----------------------------------------------------------------------------------

export async function gitIdentityStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'git-identity' }>): Promise<StepResult> {
  const keys = (['name', 'email'] as const).filter((k) => action[k] !== null);
  const before: Record<string, string | null> = {};
  for (const key of keys) {
    const value = action[key]!;
    if (value.length > 200 || /[\r\n\0]/.test(value)) return failed(`The ${key} from the other computer cannot be set: it is not one line.`);
    const got = await capture(deps, ['git', 'config', '--global', '--get', `user.${key}`]);
    before[key] = got.code === 0 ? got.text : null;
    const problem = await runFor(deps, ctx, ['git', 'config', '--global', `user.${key}`, value], LIMIT.other);
    if (problem) return problem;
  }
  return {
    state: 'done',
    said: `Set ${keys.map((k) => `user.${k}`).join(' and ')} in your global git settings.`,
    undo: async () => {
      for (const key of keys) {
        const was = before[key];
        await capture(deps, was === null || was === undefined ? ['git', 'config', '--global', '--unset', `user.${key}`] : ['git', 'config', '--global', `user.${key}`, was]);
      }
    },
  };
}

// ---- SSH hosts ---------------------------------------------------------------------------------

const BLOCK_END = '# End of what Kestrel added';

/**
 * Whether a `Host` line's name can be written as it is: one pattern or several with a space between
 * ("forge forge.example.com 10.0.0.2"), each of plain characters, `*`, `?`, or a leading `!`. Pure.
 */
export const sshHostWritable = (host: string): boolean => host.length <= 400 && host.split(' ').every((p) => /^!?[A-Za-z0-9.*?_-]{1,200}$/.test(p));

/** The block of `Host` entries to add: only plain values, IdentityFile only where that file is here. Pure over `has`. */
export function sshBlock(hosts: Extract<SetupAction, { kind: 'ssh-hosts' }>['hosts'], present: readonly string[], from: string, has: (name: string) => boolean): string | null {
  const lines: string[] = [];
  for (const h of hosts) {
    if (present.includes(h.host) || !sshHostWritable(h.host)) continue;
    lines.push(`Host ${h.host}`);
    if (h.hostName && HOST.test(h.hostName)) lines.push(`  HostName ${h.hostName}`);
    if (h.user && WORD.test(h.user)) lines.push(`  User ${h.user}`);
    if (h.port && /^\d{1,5}$/.test(h.port)) lines.push(`  Port ${h.port}`);
    for (const file of h.identityFiles) if (/^[A-Za-z0-9._-]{1,100}$/.test(file) && has(file)) lines.push(`  IdentityFile ~/.ssh/${file}`);
  }
  if (lines.length === 0) return null;
  return [`# Added by Kestrel from ${from.replace(/[\r\n]/g, ' ')}`, ...lines, BLOCK_END, ''].join('\n');
}

export async function sshHostsStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'ssh-hosts' }>): Promise<StepResult> {
  const dir = join(deps.home, '.ssh');
  const path = join(dir, 'config');
  if (!realHomePath('~/.ssh/config', deps)) return failed('~/.ssh/config points outside your home folder, so Kestrel leaves it alone.');
  const before = deps.fs.read(path);
  const present = before ? sshHostsOf(before).map((h) => h.host) : [];
  const block = sshBlock(action.hosts, present, ctx.line.from[0] ?? 'another computer', (name) => deps.fs.exists(join(dir, name)));
  if (!block) {
    // Nothing to add is done only when every host really is there: one Kestrel will not write is said, not passed over.
    const left = action.hosts.filter((h) => !present.includes(h.host)).map((h) => h.host);
    if (left.length > 0) return failed(`Kestrel will not write ${left.map((h) => `"${h}"`).join(', ')} to ~/.ssh/config: the name has characters it does not copy. Add it there by hand.`);
    return { state: 'done', said: 'Every host was already in ~/.ssh/config.' };
  }
  if (!deps.fs.exists(dir)) deps.fs.mkdir(dir, 0o700);
  const text = `${before ?? ''}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${block}`;
  deps.fs.write(path, text, 0o600);
  const added = block.split('\n').filter((l) => l.startsWith('Host ')).length;
  return {
    state: 'done',
    said: `Added ${added} host${added === 1 ? '' : 's'} to ~/.ssh/config.`,
    undo: async () => {
      const now = deps.fs.read(path);
      if (now === null || !now.includes(block)) throw new Error('~/.ssh/config changed since, so Kestrel did not take the hosts back out.');
      const back = now.replace(before ? `\n${block}` : block, '');
      if (before === null && back.trim() === '') deps.fs.remove(path);
      else deps.fs.write(path, back, 0o600);
    },
  };
}

// ---- this computer's SSH key -------------------------------------------------------------------

const KEY = '~/.ssh/id_ed25519';

/** A clone on the list whose origin is on `host`, to check that the key reaches it. */
const originOn = (ctx: StepContext, host: string): string | null => ctx.list.lines.flatMap((l) => (l.action?.kind === 'clone' && sshHostOf(l.action.origin) === host ? [l.action.origin] : []))[0] ?? null;

/** The fingerprint known_hosts holds for a host, to say which key was remembered. */
async function hostKey(deps: ExecuteDeps, host: string): Promise<string | null> {
  const got = await capture(deps, ['ssh-keygen', '-l', '-F', host, '-f', join(deps.home, '.ssh', 'known_hosts')]);
  return got.code === 0 ? (/(SHA256:[A-Za-z0-9+/=]+)/.exec(got.text)?.[1] ?? null) : null;
}

export async function sshKeyStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'ssh-key' }>): Promise<StepResult> {
  if (!HOST.test(action.host)) return failed('That host name cannot be used.');
  const key = realHomePath(KEY, deps);
  if (!key) return failed('~/.ssh points outside your home folder, so Kestrel leaves it alone.');
  const name = (ctx.list.here.name || 'Kestrel').replace(/[\r\n]/g, ' ').slice(0, 80);
  let made = false;
  if (!deps.fs.exists(key)) {
    if (!deps.fs.exists(join(deps.home, '.ssh'))) deps.fs.mkdir(join(deps.home, '.ssh'), 0o700);
    const problem = await runFor(deps, ctx, ['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', name, '-f', key], LIMIT.other);
    if (problem) return problem;
    made = true;
  }
  const pub = `${key}.pub`;
  if (action.tool === null) {
    const text = deps.fs.read(pub)?.trim() ?? '';
    return { state: 'waiting', on: `you: add this computer's public key at ${action.host} (its SSH keys page), then Check again: ${text}` };
  }
  const add = action.tool === 'gh' ? ['gh', 'ssh-key', 'add', pub, '--title', name] : ['glab', 'ssh-key', 'add', pub, '--title', name];
  // The host is named for the program: outside a repository it would go to its own default (gitlab.com).
  const env = sshKeyHostEnv(action.tool!, action.host) ?? undefined;
  let output = '';
  const first = await deps.run(add, { cwd: deps.home, timeoutMs: LIMIT.other, ...(env ? { env } : {}), output: (t) => ((output += t), ctx.output(t)) });
  const exists = /already (exists|in use)|key is already|has already been taken/i.test(output);
  if (first.problem || (first.code !== 0 && !exists)) {
    // gh needs the admin:public_key scope once: a browser step of its own.
    if (action.tool === 'gh' && /admin:public_key|scope/i.test(output)) {
      const refreshed = await deviceSignIn(deps, ctx, ['gh', 'auth', 'refresh', '--hostname', action.host, '--scopes', 'admin:public_key'], action.host);
      if (refreshed) return refreshed;
      const again = await runFor(deps, ctx, add, LIMIT.other, env ? { env } : {});
      if (again) return again;
    } else return failed(first.problem ?? `${action.tool} could not add the key at ${action.host}.`, output);
  }
  const origin = originOn(ctx, action.host);
  if (origin) {
    const reach = await runFor(deps, ctx, ['git', 'ls-remote', '--heads', '--', origin], LIMIT.other, { env: GIT_SSH });
    if (reach) return { ...reach, reason: `The key was added at ${action.host}, but git could not reach ${origin} with it yet: ${reach.state === 'failed' ? reach.reason : ''}` } as StepResult;
  }
  const fingerprint = await hostKey(deps, action.host);
  return { state: 'done', said: `${made ? 'Made ~/.ssh/id_ed25519 and added' : 'Added'} its public half at ${action.host}.${fingerprint ? ` ${action.host}'s host key was remembered on first contact: ${fingerprint}.` : ''}` };
}

// ---- gh and glab sign-ins ----------------------------------------------------------------------

/**
 * A sign-in that shows a one-time code and a page: the code and the page are said on the line while the
 * program waits for the browser. Null when it ended well; Kestrel never sees the token it makes.
 */
async function deviceSignIn(deps: ExecuteDeps, ctx: StepContext, argv: readonly string[], host: string): Promise<StepResult | null> {
  let seen = '';
  let said = '';
  const watch = (text: string) => {
    seen += text;
    const code = /code:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(seen)?.[1];
    const url = /(https:\/\/[^\s]+)/.exec(seen)?.[1];
    // Said again when the page's address arrives after the code: the line shows both, to copy and to open.
    const now = `${code ?? ''}|${url ?? ''}`;
    if ((code || url) && now !== said) {
      said = now;
      ctx.say(`you: ${code ? `enter ${code}` : 'sign in'} ${url ? `at ${url}` : `in your browser for ${host}`}`, { code, url });
    }
  };
  // A new line answers "Press Enter to open … in your browser".
  return runFor(deps, { ...ctx, output: (t) => (watch(t), ctx.output(t)) }, argv, LIMIT.signIn, { stdin: '\n' });
}

export async function hostSignInStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'host-sign-in' }>): Promise<StepResult> {
  if (!HOST.test(action.host)) return failed('That host name cannot be used.');
  const protocol = action.protocol === 'ssh' || action.protocol === 'https' ? ['--git-protocol', action.protocol] : [];
  if (action.tool === 'gh') {
    const problem = await deviceSignIn(deps, ctx, ['gh', 'auth', 'login', '--web', '--hostname', action.host, ...protocol], action.host);
    return problem ?? { state: 'done', said: `gh is signed in to ${action.host}.` };
  }
  if (action.web) {
    const problem = await deviceSignIn(deps, ctx, ['glab', 'auth', 'login', '--hostname', action.host, '--web', ...protocol], action.host);
    return problem ?? { state: 'done', said: `glab is signed in to ${action.host}.` };
  }
  const token = ctx.input.token?.trim() ?? '';
  if (!token) return { state: 'waiting', on: `you: paste a personal access token made on ${action.host} for this computer` };
  if (/[\r\n\s]/.test(token)) return failed('A token is one word with no spaces.');
  const problem = await runFor(deps, ctx, ['glab', 'auth', 'login', '--hostname', action.host, '--stdin', ...protocol], LIMIT.other, { stdin: `${token}\n` });
  return problem ?? { state: 'done', said: `glab is signed in to ${action.host} with the token you pasted. Kestrel did not keep it.` };
}

// ---- cloning -------------------------------------------------------------------------------------

/** A git address Kestrel will hand to `git clone`: https, ssh or git URL, or `user@host:path`. Pure. */
export function cloneableOrigin(origin: string): boolean {
  if (origin.startsWith('-') || /[\s\0]/.test(origin) || origin.length > 500) return false;
  if (/^(https|ssh|git):\/\/[A-Za-z0-9.-]+(:\d+)?\/\S+$/i.test(origin)) return true;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(origin);
}

/** Whether a clone Kestrel made is still as it was: nothing changed, stashed or committed there since. */
async function untouched(deps: ExecuteDeps, dir: string): Promise<boolean> {
  const status = await capture(deps, ['git', '-C', dir, 'status', '--porcelain']);
  const stash = await capture(deps, ['git', '-C', dir, 'stash', 'list']);
  const branches = await capture(deps, ['git', '-C', dir, 'for-each-ref', '--format=%(refname)', 'refs/heads']);
  const ahead = await capture(deps, ['git', '-C', dir, 'rev-list', '@{u}..HEAD']);
  return status.code === 0 && status.text === '' && stash.text === '' && branches.text.split('\n').filter(Boolean).length <= 1 && ahead.code === 0 && ahead.text === '';
}

export async function cloneStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'clone' }>): Promise<StepResult> {
  if (!cloneableOrigin(action.origin)) return failed(`${action.origin} is not a git address Kestrel will clone.`);
  const dir = realHomePath(action.path, deps);
  if (!dir) return failed(`${action.path} is outside your home folder, so Kestrel will not clone into it.`);
  if (!deps.addProject) return failed('This copy of Kestrel cannot add projects from here.');
  let cloned = false;
  if (deps.fs.exists(dir)) {
    const origin = await capture(deps, ['git', '-C', dir, 'remote', 'get-url', 'origin']);
    // The same repository however its address is written: a clone made over https is still that project.
    const same = origin.text === action.origin || (repositoryKey(origin.text) !== null && repositoryKey(origin.text) === repositoryKey(action.origin));
    if (origin.code !== 0 || !same) return failed(`${action.path} is already there and is not a clone of ${action.origin}. Move it, or clone by hand.`);
  } else {
    ctx.say(`git: cloning ${action.origin}`);
    const problem = await runFor(deps, ctx, ['git', 'clone', '--', action.origin, dir], LIMIT.clone, { env: GIT_SSH });
    if (problem) {
      // A failed clone leaves a partial folder: it was Kestrel's, so it goes.
      if (deps.fs.exists(dir)) deps.fs.remove(dir);
      return problem;
    }
    cloned = true;
  }
  const added = await deps.addProject(action.project, dir);
  return {
    state: 'done',
    said: `${cloned ? `Cloned ${action.origin} into ${action.path} and` : `${action.path} was already a clone;`} ${added.said}`,
    undo: async () => {
      await added.undo();
      if (!cloned) return;
      if (!(await untouched(deps, dir))) throw new Error(`${action.path} has changes since it was cloned, so Kestrel left the folder where it is.`);
      deps.fs.remove(dir);
    },
  };
}
