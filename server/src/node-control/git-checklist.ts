// `kestrel node git`: the checklist that gives Kestrel's git on a node a key of its own, gets it accepted at the
// account's git hosts, and sets the name and email its commits carry (docs/designs/worker-nodes.md, section 7). It
// runs in the terminal, as `agents` does, drawn by join's drawing function from the same events.
//
// The default path, per host the person ticks: gh or glab is installed at its pin into Kestrel's tools folder, signed
// in by its own sign-in with the person's terminal (with exactly the scopes Kestrel needs, said first), and then, on
// one yes that lists the exact commands, the key is added (once), registered for signing when commits are signed, the
// host's verified addresses are read to pick the commit email, and ssh tests the key. The manual path (a host not
// ticked, a tool that failed, `--manual`) says where to paste the key and tests it on Enter. With `--yes` (or no
// terminal) the tools are installed and the sign-in commands printed; nothing is done at a host.
//
// The terminal makes the key, tests it and asks; the running node says what only it knows (the account's projects'
// repositories, what the other computers publish) and, asked again at the end, reads the settings into the
// environment its git runs in (the socket's `git`, git-node.ts). The key is the node's own: never one of ~/.ssh, never
// copied from or to another computer, and only its public half is ever shown. No credential store is opened and no
// token is read: the tools' sign-ins are their own, and the API answers read are key lists and verified addresses.
import type { JoinSay, JoinStep, NodeGitFacts, PublishedGit } from '../shared/node-commands.ts';
import { hostAnswerText, hostsOfRepositories, keyTitle, wherePasteKey, withoutTool } from '../shared/node-git-hosts.ts';
import { gitToDo, toDoText } from '../shared/node-git-todo.ts';
import {
  addKeyCommand,
  apiArgs,
  emailChoice,
  EMAILS_PATH,
  githubEmails,
  gitlabEmails,
  GITLAB_USER_PATH,
  hostKindOf,
  KEYS_PATH,
  matchingKeys,
  signInCommand,
  signInWhy,
  SIGNING_KEYS_PATH,
  TOOL_LABEL,
  toolForHost,
  type GitTool,
  type HostEmail,
  type KeyUse,
  type ToolPins,
} from '../shared/node-git-tools.ts';
import { identityProblem, isHostName, NODE_GIT_COMMAND, type HostCheck, type NodeGitSettings, type SigningAt, type ToolState } from '../shared/node-git.ts';
import { saidYes, type ChecklistIo } from './agents-checklist.ts';
import { confirm, type AskHint } from './worker-onboarding/ask.ts';
import type { GitPrograms } from './git-programs.ts';

export interface GitOptions {
  /** Ask nothing (`--yes`, or no terminal): install the tools, print the sign-ins, do nothing at a host. */
  unattended: boolean;
  /** Every host by hand (`--manual`): no tool is installed, signed in or run at a host. */
  manual: boolean;
}

export interface GitChecklistDeps {
  programs: GitPrograms;
  pins: ToolPins;
  /** The running node's part (it reads the settings again, then answers); null when no node answers. */
  node(): Promise<NodeGitFacts | null>;
  /** This computer's name, when no node answers. */
  name: string;
  /** The home folder, written as `~` in what is said. */
  home: string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const KEY: JoinStep = 1;
const HOSTS: JoinStep = 2;
const CHOICES: JoinStep = 3;
const AT_HOSTS: JoinStep = 4;
const EMAIL: JoinStep = 5;
const TO_DO: JoinStep = 6;
const TRIES = 3;
/** "Wait" for the account's projects: asked again every few seconds, for up to a minute. */
const WAIT_EVERY_MS = 5_000;
const WAIT_FOR_MS = 60_000;

const tilde = (path: string, home: string): string => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
const shellWord = (word: string): string => (/^[\w@%+=:,./~-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`);
/**
 * The hosts an answer picks from the numbered list `all`: Enter, a, all, both or yes is every one; s, skip, n, no or
 * none is none; numbers (1 2, or 1,2) or the hosts' own names pick those. Null when the answer is none of these.
 */
export function hostsPicked(answer: string, all: readonly string[]): string[] | null {
  const typed = answer.trim().toLowerCase();
  if (/^(|a|all|both|y|yes)$/.test(typed)) return [...all];
  if (/^(s|skip|n|no|none)$/.test(typed)) return [];
  const picked = new Set<string>();
  for (const word of typed.split(/[\s,]+/).filter(Boolean)) {
    const host = /^\d+$/.test(word) ? all[Number(word) - 1] : all.find((h) => h === word);
    if (!host) return null;
    picked.add(host);
  }
  return all.filter((h) => picked.has(h));
}

/** The account's projects are not known yet: check again, wait for them, or carry on. */
const UNTIL_KNOWN: AskHint = {
  kind: 'choose',
  choices: [
    { answer: '', label: 'Check again' },
    { answer: 'w', label: 'Wait for it', note: 'up to a minute', shortcut: 'w' },
    { answer: 'c', label: 'Carry on without them', shortcut: 'c' },
  ],
  initial: '',
};

/** The key pasted at a site by hand: check again, or skip. */
const BY_HAND: AskHint = {
  kind: 'choose',
  choices: [
    { answer: '', label: 'Check again', note: 'once the key is added' },
    { answer: 's', label: 'Skip', shortcut: 's' },
  ],
  initial: '',
};

/** Enter is yes: for what is offered as the way to go ([Y/n]). */
const yesByDefault = (answer: string | null): boolean => answer !== null && (answer.trim() === '' || saidYes(answer));
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The hosts the checklist works with: the account's (or the ones checked before), and which of them the tools set up. */
interface Hosts {
  all: string[];
  ticked: string[];
  /** False when the account's projects could not be read. */
  known: boolean;
}

/** What one host's default path found, kept into the settings. */
interface AtHost {
  check: HostCheck;
  /** The address the host verified and the person chose, when it was read. */
  email: string | null;
}

class GitChecklist {
  private settings: NodeGitSettings;
  private tools: { gh: ToolState | null; glab: ToolState | null };
  /** Hosts whose tool did not get as far as the one yes: they are done by hand. */
  private readonly byHand = new Set<string>();
  private readonly read = new Map<string, string>();
  /** The address another computer of the account publishes, if any: taken at a host only where that host verified it. */
  private publishedEmail: string | null = null;

  constructor(
    private readonly deps: GitChecklistDeps,
    private readonly io: ChecklistIo,
    private readonly options: GitOptions,
    private readonly name: string,
  ) {
    this.settings = deps.programs.readSettings();
    this.tools = { ...this.settings.tools };
  }

  private say(step: JoinStep, line: JoinSay): void {
    this.io.say({ event: 'say', step, ...line });
  }

  private async agreed(step: JoinStep, prompt: string, byDefault: boolean, hint: AskHint = confirm(byDefault)): Promise<boolean> {
    const answer = await this.io.ask(step, `${prompt} ${byDefault ? '[Y/n]' : '[y/N]'} `, hint);
    return byDefault ? yesByDefault(answer) : saidYes(answer);
  }

  private shown = (path: string): string => tilde(path, this.deps.home);

  /** A tool's command as the person would type it. */
  private commandText(file: string, args: readonly string[], env: Record<string, string> = {}): string {
    return `${Object.entries(env).map(([k, v]) => `${k}=${v} `).join('')}${file} ${args.map(shellWord).join(' ')}`;
  }

  private addKeyText(tool: GitTool, host: string, use: KeyUse): string {
    const c = addKeyCommand(tool, host, this.shown(this.deps.programs.paths.publicKey), keyTitle(this.name), use);
    return this.commandText(c.file, c.args, c.env);
  }

  /** 1: the node's own key, made here if there is none, and its public half. */
  async key(): Promise<boolean> {
    const { paths } = this.deps.programs;
    this.say(KEY, { kind: 'heading', text: "This node's key" });
    const there = this.deps.programs.publicKey() !== null;
    if (!there && !this.options.unattended && !(await this.agreed(KEY, "Make an SSH key for Kestrel's git on this node? It is used only by Kestrel here and never leaves this node.", true, confirm(true, { yes: 'Make a key', no: 'Not now' })))) {
      this.say(KEY, { kind: 'line', text: `No key. Without one Kestrel's git on this node cannot reach your git hosts. To make it later: ${NODE_GIT_COMMAND}` });
      return false;
    }
    const made = await this.deps.programs.makeKey(`kestrel-node ${this.name}`);
    if (!made.ok) return (this.say(KEY, { kind: 'problem', text: made.reason }), false);
    this.settings = { ...this.settings, key: { fingerprint: made.fingerprint, madeAt: made.made ? this.deps.now() : (this.settings.key?.madeAt ?? this.deps.now()) } };
    this.say(KEY, { kind: 'done', text: made.made ? `Made a key: ${made.fingerprint}` : `Key: ${made.fingerprint}` });
    this.say(KEY, { kind: 'line', text: `It is kept in ${this.shown(paths.folder)} (the private half readable only by you), used only by Kestrel's git here, and never leaves this node. Its public half:` });
    this.say(KEY, { kind: 'code', code: this.deps.programs.publicKey() ?? '' });
    return true;
  }

  /** While the account's projects are not known: say why, and offer to check again or wait. Answers the facts as they end up. */
  private async untilKnown(facts: NodeGitFacts | null): Promise<NodeGitFacts | null> {
    let now = facts;
    for (let i = 0; i < TRIES && (!now || now.accountUnknown); i++) {
      this.say(HOSTS, { kind: 'line', text: now ? now.accountUnknown! : `The node is not running, so it cannot say which hosts your account's projects use. Start it (kestrel node start).` });
      if (this.options.unattended) return now;
      const answer = await this.io.ask(HOSTS, 'Press Enter to check again, type w to wait for it (up to a minute), or c to carry on without them: ', UNTIL_KNOWN);
      if (answer === null || /^\s*c/i.test(answer)) return now;
      if (/^\s*w/i.test(answer)) {
        this.say(HOSTS, { kind: 'wait', text: "Waiting for the node to read your account's projects…" });
        for (let waited = 0; waited < WAIT_FOR_MS && (!now || now.accountUnknown); waited += WAIT_EVERY_MS) {
          await this.deps.sleep(WAIT_EVERY_MS);
          now = (await this.deps.node()) ?? now;
        }
      } else now = (await this.deps.node()) ?? now;
    }
    return now;
  }

  /** 2: the GitHub and GitLab hosts, each ticked when the account's projects use it; one question for all of them. */
  async hosts(given: NodeGitFacts | null): Promise<{ facts: NodeGitFacts | null; hosts: Hosts }> {
    this.say(HOSTS, { kind: 'heading', text: 'Where your repositories are' });
    const facts = await this.untilKnown(given);
    const known = Boolean(facts && !facts.accountUnknown);
    const fromAccount = facts ? hostsOfRepositories(facts.repositories) : [];
    const before = Object.keys(this.settings.hosts).sort();
    const all = known ? fromAccount : [...new Set([...fromAccount, ...before])].sort();
    if (!known && before.length > 0) this.say(HOSTS, { kind: 'line', text: `Carrying on with the ${plural(before.length, 'host', 'hosts')} checked before.` });
    if (known && all.length === 0) this.say(HOSTS, { kind: 'line', text: "Your account's projects have no repository at a git host yet." });
    if (this.options.manual) {
      if (all.length > 0) this.say(HOSTS, { kind: 'line', text: `By hand (--manual): ${all.join(', ')}.` });
      return { facts, hosts: { all, ticked: [], known } };
    }
    if (this.options.unattended) {
      if (all.length > 0) this.say(HOSTS, { kind: 'line', text: `${known ? "Your account's projects use" : 'Hosts'}: ${all.map((h) => `${h} (${hostKindOf(h) === 'github' ? 'GitHub' : 'GitLab'}, with ${toolForHost(h)})`).join(', ')}.` });
      return { facts, hosts: { all, ticked: all, known } };
    }
    const ticked = all.length > 0 ? await this.pickHosts(all) : await this.typedHosts();
    return { facts, hosts: { all: [...new Set([...all, ...ticked])].sort(), ticked, known } };
  }

  /**
   * Which of the hosts found this node should reach repositories on: a numbered choice per host, all of them, or
   * skip, the default shown. Choosing one starts its guided sign-in and then offers, as a question of its own, to add
   * this node's public key there; nothing changes at a host before that yes.
   */
  private async pickHosts(all: readonly string[]): Promise<string[]> {
    this.say(HOSTS, { kind: 'line', text: "Which sites should this node use to reach your repositories? Choosing one signs in to it here with its own tool, then offers to add this node's public key there." });
    // A short list of choices, a key each: a line apiece, so a key sits beside its choice and not in a field's wide column.
    const kind = (host: string) => `${hostKindOf(host) === 'github' ? 'GitHub' : 'GitLab'}, with ${toolForHost(host)}`;
    if (!this.io.drawsChoices) {
      all.forEach((host, i) => this.say(HOSTS, { kind: 'line', text: `${i + 1}) ${host} (${kind(host)})` }));
      if (all.length > 1) this.say(HOSTS, { kind: 'line', text: `a) ${all.length === 2 ? 'Both' : 'All of them'}` });
      this.say(HOSTS, { kind: 'line', text: 's) Skip (add the key by hand later)' });
    }
    const fallback = all.length > 1 ? 'a' : '1';
    const hint: AskHint = {
      kind: 'pick',
      label: 'Which sites should this node use?',
      choices: all.map((host, i) => ({ answer: String(i + 1), label: host, note: kind(host) })),
      initial: all.map((_, i) => String(i + 1)),
      answer: (chosen) => (chosen.length === 0 ? 's' : chosen.join(' ')),
    };
    for (let i = 0; i < TRIES; i++) {
      const answer = await this.io.ask(HOSTS, `Choose${all.length > 1 ? ` (1-${all.length}, a or s)` : ' (1 or s)'} [${fallback}]: `, hint);
      if (answer === null) return [];
      const picked = hostsPicked(answer, all);
      if (picked) return picked;
      this.say(HOSTS, { kind: 'line', text: `Type ${all.length > 1 ? `a number from 1 to ${all.length}, several (like 1 2), a for ${all.length === 2 ? 'both' : 'all'},` : '1'} or s to skip.` });
    }
    return [];
  }

  /** No host found in the account's projects: one may be typed, or none. */
  private async typedHosts(): Promise<string[]> {
    for (let i = 0; i < TRIES; i++) {
      const answer = await this.io.ask(HOSTS, 'Type a site to set up (like github.com), or press Enter to skip: ', { kind: 'text', label: 'Type a site to set up, or leave it empty to skip', placeholder: 'github.com', maxLength: 253 });
      if (answer === null) return [];
      const words = answer.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
      if (words.length === 0 || (words.length === 1 && /^(s|skip|n|no|none)$/.test(words[0]!))) return [];
      const wrong = words.filter((w) => !isHostName(w) || !w.includes('.'));
      if (wrong.length === 0) return [...new Set(words)].sort();
      this.say(HOSTS, { kind: 'line', text: `Not a site: ${wrong.join(', ')}. A site is like github.com.` });
    }
    return [];
  }

  /** 3: signing first (asked once, yes offered when a computer of the account signs), then the commit name, asked once. */
  async choices(facts: NodeGitFacts | null, hasKey: boolean): Promise<void> {
    this.say(CHOICES, { kind: 'heading', text: 'Signing and your name' });
    const signers = (facts?.others ?? []).filter((o) => o.signs).map((o) => o.computer);
    if (!hasKey) this.settings = { ...this.settings, signing: 'off' };
    else {
      if (signers.length > 0) this.say(CHOICES, { kind: 'line', text: `${signers.join(', ')} ${plural(signers.length, 'signs its', 'sign their')} commits. A key never comes here from another computer, so commits made here are signed with this node's own key, or not at all.` });
      if (!this.options.unattended) {
        const byDefault = signers.length > 0 || this.settings.signing === 'node-key';
        const sign = await this.agreed(CHOICES, `Sign commits made on ${this.name} with this node's key?`, byDefault, confirm(byDefault, { yes: "Sign with this node's key", no: 'Do not sign' }));
        this.settings = { ...this.settings, signing: sign ? 'node-key' : 'off' };
      } else if (this.settings.signing === null && signers.length > 0) this.say(CHOICES, { kind: 'line', text: `Signing is not chosen. Run ${NODE_GIT_COMMAND} at a terminal to choose.` });
    }
    if (this.settings.signing) this.say(CHOICES, { kind: 'done', text: this.settings.signing === 'node-key' ? "Commits made here are signed with this node's key" : 'Commits made here are not signed' });

    const published = this.published(facts);
    this.publishedEmail = (facts?.others ?? []).find((o) => o.email)?.email ?? null;
    const offered = this.settings.name ?? published?.name ?? null;
    if (!this.settings.name && published) this.say(CHOICES, { kind: 'line', text: `Filled in from ${published.computer}'s git settings.` });
    else if (!this.settings.name && facts?.othersUnknown) this.say(CHOICES, { kind: 'line', text: `Nothing to fill in from: ${facts.othersUnknown}` });
    const name = this.options.unattended ? offered : await this.value(CHOICES, 'Commit name', 'name', offered);
    if (name) {
      this.settings = { ...this.settings, name };
      this.say(CHOICES, { kind: 'done', text: `Commits made here are by ${name}` });
    } else this.say(CHOICES, { kind: 'line', text: `No commit name yet. To set it: ${NODE_GIT_COMMAND}` });
  }

  private published(facts: NodeGitFacts | null): (PublishedGit & { name: string }) | undefined {
    return (facts?.others ?? []).find((o): o is PublishedGit & { name: string } => Boolean(o.name));
  }

  /** Asks for one value, offering `given`; a valid answer, `given` on Enter, or null after three tries or a closed terminal. */
  private async value(step: JoinStep, label: string, what: 'name' | 'email', given: string | null): Promise<string | null> {
    for (let i = 0; i < TRIES; i++) {
      const answer = await this.io.ask(step, `${label}${given ? ` [${given}]` : ''}: `, { kind: 'text', label, ...(given ? { initial: given } : {}), placeholder: what === 'name' ? 'Your Name' : 'you@example.com', maxLength: 254 });
      if (answer === null) return given;
      const value = answer.trim() || given || '';
      const problem = identityProblem(value, what);
      if (!problem) return value.trim();
      this.say(step, { kind: 'line', text: problem });
    }
    return given;
  }

  /** The tool for these hosts, installed at its pin when it is not on the node (on a yes, or with --yes). */
  private async tool(tool: GitTool, hosts: readonly string[]): Promise<ToolState> {
    let state = await this.deps.programs.tool(tool, hosts);
    if (!state.installed) {
      const pin = this.deps.pins[tool].version;
      const folder = this.shown(this.deps.programs.toolsFolder);
      const yes = this.options.unattended || (await this.agreed(AT_HOSTS, `Install ${TOOL_LABEL[tool]} ${pin} into ${folder}, for Kestrel only?`, true, confirm(true, { yes: 'Install', no: 'Not now' })));
      if (!yes) {
        this.say(AT_HOSTS, { kind: 'line', text: `${tool} is not installed. ${withoutTool(tool, hosts.join(', '))}` });
      } else {
        this.say(AT_HOSTS, { kind: 'line', text: `Installing ${tool} ${pin}, checked against its published checksum; nothing is installed for the whole system.` });
        const done = await this.deps.programs.install(tool);
        if (done.ok) {
          this.say(AT_HOSTS, { kind: 'done', text: `Installed ${tool} ${done.version} in ${folder}` });
          state = await this.deps.programs.tool(tool, hosts);
        } else this.say(AT_HOSTS, { kind: 'problem', text: done.reason });
      }
    } else this.say(AT_HOSTS, { kind: 'done', text: `${tool}${state.version ? ` ${state.version}` : ''}: ${state.by === 'kestrel' ? 'installed by Kestrel' : 'found on this node'}` });
    this.tools = { ...this.tools, [tool]: state };
    return state;
  }

  private signedIn(tool: GitTool, host: string): boolean {
    const state = this.tools[tool];
    return Boolean(state?.installed && state.signedIn.includes(host));
  }

  private signs(): boolean {
    return this.settings.signing === 'node-key';
  }

  /** The tool's own sign-in at a host, said first; with --yes only printed. */
  private async signIn(tool: GitTool, host: string): Promise<boolean> {
    if (this.signedIn(tool, host)) return (this.say(AT_HOSTS, { kind: 'done', text: `${tool} is signed in to ${host}` }), true);
    this.say(AT_HOSTS, { kind: 'line', text: signInWhy(tool, host, this.signs()) });
    if (this.options.unattended) {
      this.say(AT_HOSTS, { kind: 'line', text: 'Sign it in at a terminal with:' });
      this.say(AT_HOSTS, { kind: 'code', code: signInCommand(tool, host, this.signs()) });
      return false;
    }
    const signIn = {
      label: 'Sign in at the site',
      action: `Run ${tool}'s own sign-in for ${host} in this terminal. Kestrel reads no token.`,
      destination: host,
      reason: signInWhy(tool, host, this.signs()),
      commands: [signInCommand(tool, host, this.signs())],
    };
    if (!(await this.agreed(AT_HOSTS, `Sign ${tool} in to ${host} now?`, true, confirm(true, { yes: 'Sign in now', no: 'Not now', trust: signIn })))) return false;
    await this.deps.programs.signIn(tool, host, this.signs());
    this.io.ran();
    const state = await this.deps.programs.tool(tool, [host]);
    const now = state.installed && state.signedIn.includes(host);
    const before = this.tools[tool];
    if (before?.installed) {
      const signedIn = [...new Set([...before.signedIn.filter((h) => h !== host), ...(now ? [host] : [])])].sort();
      const notSignedIn = [...new Set([...before.notSignedIn.filter((h) => h !== host), ...(now ? [] : [host])])].sort();
      this.tools = { ...this.tools, [tool]: { ...before, signedIn, notSignedIn } };
    }
    this.say(AT_HOSTS, now ? { kind: 'done', text: `${tool} is signed in to ${host}` } : { kind: 'problem', text: `${tool} did not sign in to ${host}. ${withoutTool(tool, host)}` });
    return now;
  }

  /** The exact commands the one yes at a host runs, as shown. */
  private plan(tool: GitTool, host: string): string[] {
    const ssh = `ssh -T git@${host}  # with this node's key only`;
    const list = (path: string, why: string) => `${this.commandText(tool, apiArgs(host, path))}  # ${why}`;
    if (tool === 'gh') {
      return [
        list(KEYS_PATH.gh, 'is the key there already?'),
        `${this.addKeyText('gh', host, 'auth')}  # only if it is not`,
        ...(this.signs() ? [list(SIGNING_KEYS_PATH, 'is it registered for signing?'), `${this.addKeyText('gh', host, 'signing')}  # only if it is not`] : []),
        list(EMAILS_PATH.gh, 'your verified addresses, nothing else'),
        ssh,
      ];
    }
    return [
      list(KEYS_PATH.glab, 'is the key there already?'),
      `${this.addKeyText('glab', host, this.signs() ? 'auth_and_signing' : 'auth')}  # only if it is not`,
      list(GITLAB_USER_PATH, 'your primary and commit addresses'),
      list(EMAILS_PATH.glab, 'your other confirmed addresses'),
      ssh,
    ];
  }

  /** The key at a host with its tool: listed first, so it is added once and never twice. Answers whether it is there now. */
  private async keyThere(tool: GitTool, host: string, publicKey: string): Promise<{ there: boolean; addedBy?: GitTool; signing?: SigningAt }> {
    const listed = await this.deps.programs.api(tool, host, KEYS_PATH[tool]);
    if (!listed.ok) return (this.say(AT_HOSTS, { kind: 'problem', text: listed.reason }), { there: false });
    const mine = matchingKeys(listed.json, publicKey);
    const gitlabSigning = (usage: string | null): SigningAt | undefined => (tool !== 'glab' ? undefined : usage === 'auth_and_signing' || usage === 'signing' ? 'registered' : 'not-registered');
    if (mine.length > 0) {
      this.say(AT_HOSTS, { kind: 'done', text: `The key is already at ${host}` });
      const signing = gitlabSigning(mine[0]!.usage);
      if (this.signs() && signing === 'not-registered') this.say(AT_HOSTS, { kind: 'line', text: `It is there for authentication only. GitLab cannot change that: delete it at ${host} (Preferences → SSH Keys) and run ${NODE_GIT_COMMAND} again, so it is added for both.` });
      return { there: true, ...(signing ? { signing } : {}) };
    }
    const use: KeyUse = tool === 'glab' && this.signs() ? 'auth_and_signing' : 'auth';
    const added = await this.deps.programs.addKey(tool, host, keyTitle(this.name), use);
    if (!added.ok) return (this.say(AT_HOSTS, { kind: 'problem', text: added.reason }), { there: false });
    this.say(AT_HOSTS, { kind: 'done', text: `Added the key at ${host}${use === 'auth_and_signing' ? ', for authentication and signing' : ''}` });
    return { there: true, addedBy: tool, ...(tool === 'glab' ? { signing: use === 'auth_and_signing' ? 'registered' : 'not-registered' } : {}) };
  }

  /** gh keeps signing keys in a list of their own: listed first, added once. */
  private async githubSigning(host: string, publicKey: string): Promise<SigningAt | undefined> {
    const listed = await this.deps.programs.api('gh', host, SIGNING_KEYS_PATH);
    if (!listed.ok) return void this.say(AT_HOSTS, { kind: 'problem', text: listed.reason });
    if (matchingKeys(listed.json, publicKey).length > 0) return (this.say(AT_HOSTS, { kind: 'done', text: `It is already registered for signing at ${host}` }), 'registered');
    const added = await this.deps.programs.addKey('gh', host, keyTitle(this.name), 'signing');
    if (!added.ok) return void this.say(AT_HOSTS, { kind: 'problem', text: added.reason });
    this.say(AT_HOSTS, { kind: 'done', text: `Registered it for signing at ${host}` });
    return 'registered';
  }

  /** The host's verified addresses, read; one chosen, asking when several could be it. Never one the host did not verify. */
  private async emailAt(tool: GitTool, host: string): Promise<string | null> {
    let verified: HostEmail[];
    if (tool === 'gh') {
      const emails = await this.deps.programs.api('gh', host, EMAILS_PATH.gh);
      if (!emails.ok) return (this.say(AT_HOSTS, { kind: 'problem', text: emails.reason }), null);
      verified = githubEmails(emails.json);
    } else {
      const user = await this.deps.programs.api('glab', host, GITLAB_USER_PATH);
      if (!user.ok) return (this.say(AT_HOSTS, { kind: 'problem', text: user.reason }), null);
      const emails = await this.deps.programs.api('glab', host, EMAILS_PATH.glab);
      verified = gitlabEmails(user.json, emails.ok ? emails.json : []);
    }
    const choice = emailChoice(verified, this.settings.hosts[host]?.email ?? this.settings.email ?? this.publishedEmail);
    if ('none' in choice) return (this.say(AT_HOSTS, { kind: 'line', text: `${host} listed no verified address.` }), null);
    if ('email' in choice) return (this.say(AT_HOSTS, { kind: 'done', text: `Commit email at ${host}: ${choice.email} (verified there)` }), choice.email);
    this.say(AT_HOSTS, { kind: 'line', text: `${host} has verified ${choice.ask.length} addresses:` });
    const preferred = (e: HostEmail) => (e.preferred ? (tool === 'gh' ? 'primary' : 'commit email') : '');
    if (!this.io.drawsChoices) choice.ask.forEach((e, i) => this.say(AT_HOSTS, { kind: 'line', text: `${i + 1}. ${e.email}${preferred(e) ? ` (${preferred(e)})` : ''}` }));
    const hint: AskHint = {
      kind: 'choose',
      choices: choice.ask.map((e, i) => ({ answer: String(i + 1), label: e.email, ...(preferred(e) ? { note: preferred(e) } : {}) })),
      initial: String(Math.max(1, choice.ask.findIndex((e) => e.email === choice.offer) + 1)),
    };
    for (let i = 0; i < TRIES; i++) {
      const answer = (await this.io.ask(AT_HOSTS, `Which do you commit with at ${host}? [${choice.offer}] `, hint))?.trim() ?? '';
      const picked = answer === '' ? choice.offer : /^\d+$/.test(answer) ? choice.ask[Number(answer) - 1]?.email : choice.ask.find((e) => e.email.toLowerCase() === answer.toLowerCase())?.email;
      if (picked) return (this.say(AT_HOSTS, { kind: 'done', text: `Commit email at ${host}: ${picked}` }), picked);
      this.say(AT_HOSTS, { kind: 'line', text: `Type a number from 1 to ${choice.ask.length}, or one of the addresses.` });
    }
    return null;
  }

  /** ssh's test of the key at a host, with the host keys it took said. */
  private async test(host: string) {
    const found = await this.deps.programs.test(host);
    for (const k of found.accepted) this.say(AT_HOSTS, { kind: 'line', text: `Accepted ${host}'s host key (${k.type} ${k.fingerprint}) into Kestrel's known hosts. Compare it with the fingerprints ${host} publishes.` });
    return found;
  }

  private said(host: string, check: HostCheck, detail: string | null): void {
    if (check.answer === 'works') this.say(AT_HOSTS, { kind: 'done', text: hostAnswerText(host, 'works') });
    else this.say(AT_HOSTS, { kind: 'problem', text: `${hostAnswerText(host, check.answer, detail)}.` });
  }

  /** 4, the default path at one host: tool, sign-in, one yes, then the commands it listed. Null when it is left to the manual path. */
  private async withTool(host: string, hasKey: boolean): Promise<AtHost | null> {
    const tool = toolForHost(host);
    this.say(AT_HOSTS, { kind: 'line', text: `${host}, with ${tool}:` });
    const state = this.tools[tool];
    if (!state?.installed) return null;
    if (!(await this.signIn(tool, host)) || this.options.unattended || !hasKey) return null;
    const publicKey = this.deps.programs.publicKey();
    if (!publicKey) return null;
    this.say(AT_HOSTS, { kind: 'line', text: `At ${host}, Kestrel would run:` });
    const plan = this.plan(tool, host);
    for (const line of plan) this.say(AT_HOSTS, { kind: 'code', code: line });
    const register = {
      label: "Register this node's key",
      action: "Add this node's public key once, read your verified addresses, and test the key with ssh.",
      destination: host,
      reason: "So Kestrel's git on this node can reach your repositories there. Nothing changes at the site before this yes.",
      commands: plan,
    };
    if (!(await this.agreed(AT_HOSTS, `Run these at ${host}?`, false, confirm(false, { yes: 'Run them', no: 'Not now', trust: register })))) return null;
    const key = await this.keyThere(tool, host, publicKey);
    // Registered for signing only where the key itself is there: otherwise both are left to the still-to-do list.
    const signing = this.signs() && tool === 'gh' && key.there ? await this.githubSigning(host, publicKey) : key.signing;
    const email = await this.emailAt(tool, host);
    if (email) this.read.set(host, email);
    const found = await this.test(host);
    const before = this.settings.hosts[host];
    const check: HostCheck = {
      answer: found.answer,
      ...(key.addedBy ? { addedBy: key.addedBy } : before?.addedBy ? { addedBy: before.addedBy } : {}),
      at: this.deps.now(),
      ...(before?.name ? { name: before.name } : {}),
      ...(signing ? { signing } : before?.signing ? { signing: before.signing } : {}),
    };
    this.said(host, check, found.detail);
    return { check, email };
  }

  /** 4, by hand at one host: tested; where to paste the key; tested again on Enter. */
  private async byHandAt(host: string): Promise<HostCheck> {
    let found = await this.test(host);
    if (found.answer === 'not-added') {
      this.say(AT_HOSTS, { kind: 'line', text: wherePasteKey(host, hostKindOf(host)) });
      this.say(AT_HOSTS, { kind: 'code', code: this.deps.programs.publicKey() ?? '' });
      if (!this.options.unattended) {
        const answer = await this.io.ask(AT_HOSTS, 'Press Enter once it is added to check again, or type s to skip: ', BY_HAND);
        if (answer !== null && !/^\s*s/i.test(answer)) found = await this.test(host);
      }
    }
    const before = this.settings.hosts[host];
    const check: HostCheck = { ...before, answer: found.answer, at: this.deps.now() };
    this.said(host, check, found.detail);
    return check;
  }

  /** 4: every host, by its tool where it was ticked and the tool got there, else by hand. */
  async atHosts(hosts: Hosts, hasKey: boolean): Promise<void> {
    this.say(AT_HOSTS, { kind: 'heading', text: 'At your git hosts' });
    if (hosts.all.length === 0) return void this.say(AT_HOSTS, { kind: 'line', text: 'No host to set up yet.' });
    for (const tool of ['gh', 'glab'] as const) {
      const toolHosts = hosts.ticked.filter((h) => toolForHost(h) === tool);
      if (toolHosts.length > 0) await this.tool(tool, toolHosts);
    }
    const checked: Record<string, HostCheck> = { ...this.settings.hosts };
    for (const host of hosts.ticked) {
      const done = await this.withTool(host, hasKey);
      if (done) checked[host] = done.check;
      else this.byHand.add(host);
    }
    for (const host of hosts.all.filter((h) => !hosts.ticked.includes(h) || this.byHand.has(h))) {
      if (!hasKey) {
        this.say(AT_HOSTS, { kind: 'line', text: `${host}: not checked, there is no key.` });
        continue;
      }
      this.say(AT_HOSTS, { kind: 'line', text: `${host}, by hand:` });
      checked[host] = await this.byHandAt(host);
    }
    this.settings = { ...this.settings, hosts: checked };
  }

  /** 5: the default commit email, then each host's own when there is more than one host. */
  async emails(facts: NodeGitFacts | null, hosts: readonly string[]): Promise<void> {
    this.say(EMAIL, { kind: 'heading', text: 'Commit email' });
    const fromHosts = [...new Set(this.read.values())];
    const published = (facts?.others ?? []).find((o) => o.email)?.email ?? null;
    const offered = this.settings.email ?? (fromHosts.length === 1 ? fromHosts[0]! : null) ?? published;
    if (!this.settings.email && offered && offered === published && fromHosts.length !== 1) this.say(EMAIL, { kind: 'line', text: 'Filled in from what another computer of your account publishes.' });
    const email = this.options.unattended ? offered : await this.value(EMAIL, 'Commit email', 'email', offered);
    if (!email) return void this.say(EMAIL, { kind: 'line', text: `No commit email yet. To set it: ${NODE_GIT_COMMAND}` });
    this.settings = { ...this.settings, email };
    const hostsNow: Record<string, HostCheck> = { ...this.settings.hosts };
    // A host's own address is kept on its record, so only on a host that was checked.
    const own = (host: string, value: string | null) => {
      const check = hostsNow[host];
      if (!check) return;
      const { email: _old, ...rest } = check;
      hostsNow[host] = value && value.toLowerCase() !== email.toLowerCase() ? { ...rest, email: value } : rest;
    };
    for (const [host, read] of this.read) own(host, read);
    if (hosts.length > 1 && !this.options.unattended) {
      const left = hosts.filter((h) => !this.read.has(h) && hostsNow[h]);
      if (left.length > 0) this.say(EMAIL, { kind: 'line', text: 'For each host: the same address, unless you commit there with another one.' });
      for (const host of left) own(host, await this.value(EMAIL, `Commit email at ${host}`, 'email', hostsNow[host]?.email ?? email));
    }
    this.settings = { ...this.settings, hosts: hostsNow };
    this.say(EMAIL, { kind: 'done', text: `Commits made here are from ${email}` });
    for (const [host, check] of Object.entries(this.settings.hosts).sort()) if (check.email) this.say(EMAIL, { kind: 'done', text: `At ${host}: ${check.email}` });
  }

  /** 6: what is still to do, numbered; the same rule `status` sums up. Answers how many. */
  stillToDo(hosts: Hosts, hasKey: boolean): number {
    this.say(TO_DO, { kind: 'heading', text: 'Still to do' });
    const items = gitToDo(this.current(), { keyIsThere: hasKey, hosts: hosts.all, hostsKnown: hosts.known });
    if (items.length === 0) return (this.say(TO_DO, { kind: 'done', text: `Nothing. Git on ${this.name} is ready.` }), 0);
    const publicKey = this.deps.programs.publicKey();
    items.forEach((item, i) => {
      const { text, code } = toDoText(item, publicKey);
      this.say(TO_DO, { kind: 'line', text: `${i + 1}. ${text}` });
      if (code) this.say(TO_DO, { kind: 'code', code });
    });
    return items.length;
  }

  save(): void {
    this.deps.programs.writeSettings(this.current());
  }

  current(): NodeGitSettings {
    return { ...this.settings, tools: { gh: this.tools.gh ?? this.settings.tools.gh, glab: this.tools.glab ?? this.settings.tools.glab } };
  }
}

/** The closing line: never "0 of 0", and never a count of hosts it could not know. */
function endText(name: string, settings: NodeGitSettings, hosts: Hosts, hasKey: boolean, left: number): string {
  const who = settings.name && settings.email ? `commits as ${settings.name} <${settings.email}>` : 'no commit name and email yet';
  if (!hasKey) return `Git on ${name}: no key yet; ${who}.`;
  const working = hosts.all.filter((h) => settings.hosts[h]?.answer === 'works').length;
  const where = hosts.all.length > 0 ? `the key works at ${working} of ${hosts.all.length} ${plural(hosts.all.length, 'host', 'hosts')}` : hosts.known ? 'no git host to check yet' : "your account's hosts are not known yet";
  const todo = left > 0 ? ` ${left} ${plural(left, 'thing', 'things')} to do.` : '';
  return `Git on ${name}: ${where}; ${who}.${todo}`;
}

/** Runs the checklist; resolves with the exit code: 0 when nothing is still to do. */
export async function runGitChecklist(deps: GitChecklistDeps, io: ChecklistIo, options: GitOptions): Promise<number> {
  const first = await deps.node();
  const name = first?.name ?? deps.name;
  const list = new GitChecklist(deps, io, options, name);
  io.say({ event: 'say', step: 0, kind: 'heading', text: `Kestrel worker node: git on ${name}` });
  const hasKey = await list.key();
  const { facts, hosts } = await list.hosts(first);
  await list.choices(facts, hasKey);
  await list.atHosts(hosts, hasKey);
  await list.emails(facts, hosts.all);
  list.save();
  // The node reads what was chosen into the environment its git runs in.
  const applied = facts ? await deps.node() : null;
  if (!applied) io.say({ event: 'say', step: 0, kind: 'line', text: 'The node is not running; it uses this when it starts (kestrel node start).' });
  const left = list.stillToDo(hosts, hasKey);
  const ok = left === 0;
  io.say({ event: 'end', ok, text: endText(name, list.current(), hosts, hasKey, left), next: 'kestrel node status' });
  return ok ? 0 : 1;
}
