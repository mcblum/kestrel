// What `kestrel` says about itself: with no command, one line of status and the commands (`overviewText`); `kestrel
// help` the commands alone; `kestrel node` (or `kestrel node help`) the node group's; `kestrel help <command>` (or
// `kestrel node help <command>`, or `<command> --help`) how to type one and what it does. Pure. One line per command
// comes from the closed lists (shared/node-commands.ts); the rest is here.
import { commandAbout, NODE_CLI, NODE_GROUP, NODE_GROUP_COMMAND_NAMES, nodeCommandLine, TOP_COMMAND_NAMES, TOP_COMMANDS } from '../shared/node-commands.ts';
import type { HelpTopic } from './args.ts';

interface CommandHelp {
  /** How it is typed, after `kestrel`. */
  usage: string;
  /** What it does, in a few sentences. */
  more: string;
}

const RUN_ABOUT = 'Run the node in this terminal (what the service runs).';

const HELP: Record<Exclude<HelpTopic, 'node'>, CommandHelp> = {
  configure: {
    usage: 'node configure',
    more: 'First what needs an administrator (lingering, and bubblewrap and socat for the command sandbox): each is said with what happens without it, the exact commands are shown, and on one yes they run here through sudo, which asks for your password itself, before anything slow. Then joining your account, the agents (one is enough; the others are optional) and git. Any step can be skipped. Run it again at any time: it asks the node what is left and offers only that. With no terminal it asks nothing and runs nothing, and lists what is left.',
  },
  status: {
    usage: 'node status [--json]',
    more: 'Says the version, whether the node is signed in, in your account and connected, each agent, git, the command sandbox, lingering, where secrets are kept and free disk. --json prints the same facts as one line of JSON, {"running":false} when no node answers.',
  },
  join: {
    usage: 'node join',
    more: 'Signs this node in (open the address on any device and type the short code shown here), then asks to join your account: a device already in it lets it in with the six-digit code shown here, and you type back the code that device shows. Recovery words are never shown on or typed into a node.',
  },
  agents: {
    usage: 'node agents [claude|codex|opencode] [--yes] [--check]',
    more: 'Asks once which agents to set up (each is optional), installs Codex and OpenCode into ~/.kestrel/agents at the versions this Kestrel runs (never globally, never with sudo), runs each chosen agent’s own sign-in in this terminal, and says whether the command sandbox is ready. Name an agent to do only that one. --yes asks nothing and prints the sign-in commands; --check runs one short turn in each signed-in agent, which spends a little usage.',
  },
  git: {
    usage: 'node git [--yes] [--manual]',
    more: 'Makes this node’s own SSH key (in ~/.kestrel/git, never ~/.ssh), asks which of your account’s git sites to use (a numbered choice, all or skip), installs gh or glab for them and signs them in, adds the key there on one yes per site, sets signing and the commit name and email, and ends with what is still to do. --manual does every host by hand; --yes asks nothing.',
  },
  start: { usage: 'node start', more: 'Starts the node’s systemd user service. Where there is no systemd user manager, run "kestrel node run" instead, in tmux or screen to keep it running after you log out.' },
  stop: { usage: 'node stop', more: 'Ends the sessions’ turns cleanly and stops the node: the service, or a node started by hand.' },
  logs: { usage: 'node logs [-f] [-n <lines>]', more: 'Prints the node’s last 200 log lines, from the journal (or, for a node started by hand, Kestrel’s own log file). -f keeps printing what is written; -n says how many lines.' },
  upgrade: {
    usage: 'upgrade [version]',
    more: 'Installs the newest version of this node’s channel (the betas when it runs a beta, else the releases), or the version given, like 0.0.35 or 0.0.35-beta.2: the same as running the install command again. The checksum is checked before anything is unpacked, Kestrel’s data is kept, the version that ran before stays for going back, and the node restarts.',
  },
  run: {
    usage: 'node run',
    more: 'Starts the node here and keeps it running until it is stopped (Ctrl-C, or "kestrel node stop" in another terminal). This is what the service runs; start it by hand only where there is no systemd user manager, in tmux or screen; started so, what it prints also goes to Kestrel’s own log file, for "kestrel node logs".',
  },
  version: { usage: 'version', more: 'Prints the version of Kestrel this command is, as the install named it.' },
  uninstall: { usage: 'node uninstall', more: 'Removes this node from your account and deletes it from this computer, after asking. Refused while a session has work that is not pushed. Says which keys and sign-ins to remove elsewhere.' },
};

const NAME_WIDTH = 10;

const line = (name: string, about: string): string => `  ${name.padEnd(NAME_WIDTH)} ${about}`;

/** The node group's commands, one line each, with `run` after them. */
const nodeCommandLines = (): string[] => [...NODE_GROUP_COMMAND_NAMES.map((name) => line(name, commandAbout(name))), line('run', RUN_ABOUT)];

/** `kestrel help`, and what follows a mistyped command: `kestrel`'s own commands, then the node group's. */
export const usageText = (): string =>
  [
    `Usage: ${NODE_CLI} <command>`,
    '',
    ...TOP_COMMAND_NAMES.map((name) => line(name, TOP_COMMANDS[name].about)),
    '',
    `Worker node commands (${NODE_CLI} ${NODE_GROUP} <command>):`,
    ...nodeCommandLines(),
  ].join('\n');

/** `kestrel node` alone, `kestrel node help`, and what follows a mistyped node command. */
export const nodeUsageText = (): string =>
  [`Usage: ${NODE_CLI} ${NODE_GROUP} <command>`, '', ...nodeCommandLines(), line('help', `Say more about a command: ${nodeCommandLine('help <command>')}.`)].join('\n');

/** `kestrel` with no command: what it is, one line of status, and the commands. */
export const overviewText = (summary: string): string => ['Kestrel', summary, '', usageText()].join('\n');

/** One line saying what a topic is. */
const aboutOf = (topic: Exclude<HelpTopic, 'node'>): string => (topic === 'run' ? RUN_ABOUT : topic === 'version' ? TOP_COMMANDS.version.about : commandAbout(topic));

/** `kestrel help <command>`; `kestrel help node` is the group's list. */
export function commandHelpText(topic: HelpTopic): string {
  if (topic === 'node') return nodeUsageText();
  const help = HELP[topic];
  return [`Usage: ${NODE_CLI} ${help.usage}`, '', aboutOf(topic), '', help.more].join('\n');
}
