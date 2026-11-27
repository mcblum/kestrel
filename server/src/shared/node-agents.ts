// The agents on a worker node (docs/designs/worker-nodes.md, section 6), purely: what each agent's own programs are
// asked (to install, sign in, say whether it is signed in), how their answers are read, and the one way a node
// words an agent that cannot run. A node has no Sign in button and no Homebrew to point at, so every sentence about
// an agent there names the one command to run on it, and, when another device reads it, the node. The desktop app's
// own wording is not here and is unchanged (agents/claude/sign-in.ts, agents/codex/process.ts, agents/opencode/process.ts).
import type { Agent } from '../model.ts';
import type { PinnedAgent } from './node-agent-versions.ts';

/** The checklist that installs and signs in the agents on a node. */
export const NODE_AGENTS_COMMAND = 'kestrel-node agents';

/** The agents the checklist knows, in the order it shows them. */
export const NODE_AGENTS: readonly Agent[] = ['claude', 'codex', 'opencode'];

/** What each agent is called in everything a node says (its checklist, its status, the offers): its program's own name. */
export const NODE_AGENT_LABEL: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/**
 * Why an agent cannot run on a node, when it is a reason that lasts until the person does something there. `data-version`:
 * OpenCode's own database was made by another OpenCode version and this one cannot open it (its migration fails).
 */
export type AgentTrouble = 'missing' | 'signed-out' | 'out-of-usage' | 'data-version';

/**
 * Why an agent cannot run on a node, as a value: a lasting reason, or any other in the agent's own words. `database`, for
 * `data-version`: where OpenCode's database is, as the node's terminal would type it (`~/…`).
 */
export type NodeAgentProblem = { trouble: AgentTrouble; detail?: string; database?: string } | { trouble: 'other'; detail: string };

/**
 * Who reads a sentence about a node's agent: another device (a phone, a desktop, a session started from one), which is
 * told the node's name and to run the command "there"; or the node's own terminal (`status`, the checklist), which is
 * not told where it is.
 */
export type AgentReader = { elsewhere: string } | 'here';

/** The longest line of a program's own output a checklist quotes (npm's last lines). */
const DETAIL_MAX = 160;

const clipped = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 1)}…` : one;
};

/** The longest cause a sentence quotes; a longer one is left to the log rather than cut in the middle. */
const CAUSE_MAX = 160;

/** OpenCode's database where OpenCode keeps it unless XDG_DATA_HOME says otherwise, for a problem that did not say. */
export const OPENCODE_DATABASE_SHOWN = '~/.local/share/opencode/opencode.db';

/**
 * OpenCode failing to migrate a database another OpenCode version made, as it fails (1.14.25 over a database 1.19.6
 * made: "DrizzleError: Failed to run the query 'CREATE TABLE `project` …"). Pure.
 */
export function isDataVersionFailure(text: string): boolean {
  return /DrizzleError|Failed to run the query '\s*(CREATE|ALTER|DROP)\b|\btable [`"']?[\w-]+[`"']? already exists|duplicate column name/i.test(text);
}

/** Where the raw words of a program begin: an error class's name, a quoted SQL statement, a stack line. */
const RAW = /\b[A-Z][A-Za-z]*[a-z](?:Error|Exception)\b|'\s*(?:CREATE|ALTER|INSERT|SELECT|UPDATE|DELETE|DROP)\b|\bat \S+:\d+/;
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What failed, in a few plain words, from an agent's failure as Kestrel's adapters pass it on ("OpenCode could not
 * start: OpenCode could not list its providers: DrizzleError: Failed to run the query 'CREATE TABLE…"): only its first
 * line, Kestrel's own prefixes taken off, cut where the program's raw words begin, and the agent's name as "it". Null when
 * nothing plain is left or it would be too long to read whole: then the sentence points at the log, which has it all,
 * and never quotes a statement cut in the middle. Pure.
 */
export function plainCause(label: string, detail: string): { cause: string | null; cut: boolean } {
  const line = (detail.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  let text = line.replace(new RegExp(`^(?:${escaped(label)} (?:could not start|cannot run):\\s*)+(?=${escaped(label)} )`, 'i'), '').replace(/^(?:Error:\s*)+/i, '');
  const raw = RAW.exec(text);
  if (raw) text = text.slice(0, raw.index);
  text = text.replace(/[\s:;,.(-]+$/, '').trim();
  if (text.toLowerCase().startsWith(`${label.toLowerCase()} `)) text = `it ${text.slice(label.length + 1)}`;
  const cut = Boolean(raw) || line.length < detail.trim().length;
  if (!text || text.length > CAUSE_MAX) return { cause: null, cut: true };
  return { cause: text, cut };
}

const run = (reader: AgentReader, agent?: Agent): string => {
  const command = agent ? `${NODE_AGENTS_COMMAND} ${agent}` : NODE_AGENTS_COMMAND;
  return reader === 'here' ? `Run \`${command}\`` : `Run \`${command}\` there`;
};
const on = (reader: AgentReader): string => (reader === 'here' ? '' : ` on ${reader.elsewhere}`);
const theLog = (reader: AgentReader): string => (reader === 'here' ? '`kestrel-node logs` shows the rest' : "the node's log has the rest");

/**
 * The one sentence a node says about an agent that cannot run, wherever it is read: the node's own status and
 * checklist (`'here'`), and what other devices read (the offers record, a refused start, the session whose turn it
 * ended), which names the node. One sentence of what failed and what to do; an agent's raw words (an error class, a
 * SQL statement, a stack) never reach it, they go to the node's log (agent-info.ts).
 */
export function nodeAgentReason(agent: Agent, problem: NodeAgentProblem, reader: AgentReader): string {
  const label = NODE_AGENT_LABEL[agent];
  if (problem.trouble === 'missing') return `${label} is not installed${on(reader)}. ${run(reader)}.`;
  if (problem.trouble === 'signed-out') return `${label} is not signed in${on(reader)}. ${run(reader)}.`;
  if (problem.trouble === 'data-version') {
    const database = ('database' in problem && problem.database) || OPENCODE_DATABASE_SHOWN;
    const file = database.split('/').pop() ?? 'opencode.db';
    return `${label}'s own database${on(reader)} was made by a different ${label} version, and this one cannot open it. ${run(reader, agent)}: it offers to move ${database} aside to ${file}.old, so ${label} starts fresh and its past conversations stay in the old file.`;
  }
  const { cause, cut } = plainCause(label, problem.detail ?? '');
  if (problem.trouble === 'out-of-usage') return `${label}'s provider refused the last turn${on(reader)}${cause ? ` (${cause})` : ''}. ${run(reader)}.`;
  if (!(problem.detail ?? '').trim()) return `${label} cannot run${on(reader)}: it did not say why. ${run(reader)}.`;
  if (!cause) return `${label} cannot run${on(reader)}, and ${theLog(reader)}. ${run(reader)}.`;
  return `${label} cannot run${on(reader)}: ${cause}${cut ? ` (${theLog(reader)})` : ''}. ${run(reader)}.`;
}

/** The npm package each agent the checklist installs comes in. Claude Code's program comes with the node's bundle. */
export const NODE_AGENT_PACKAGE: Readonly<Record<PinnedAgent, string>> = { codex: '@openai/codex', opencode: 'opencode-ai' };

/** Whether the checklist installs this agent itself, at its pin (else it comes with the bundle). */
export const installsItself = (agent: Agent): agent is PinnedAgent => Object.hasOwn(NODE_AGENT_PACKAGE, agent);

/** The program each agent's npm package puts in `node_modules/.bin`. */
export const NODE_AGENT_PROGRAM: Record<Agent, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode' };

/**
 * Each agent's own sign-in, as a node runs it: in the person's terminal, with nothing in between. None of them needs
 * a port on the node or a browser on it (docs/spike-results.md, "Worker nodes"): Claude Code prints an address and
 * takes back the code the page gives; Codex with `--device-auth` prints a code to type on the provider's page (without
 * it, it wants a browser on this machine); OpenCode asks which provider and takes a credential typed in.
 */
export const NODE_SIGN_IN_ARGS: Record<Agent, readonly string[]> = {
  claude: ['auth', 'login'],
  codex: ['login', '--device-auth'],
  opencode: ['auth', 'login'],
};

/** What each agent is asked to say whether it is signed in. Each answers about itself; no credential is opened. */
export const NODE_SIGN_IN_STATUS_ARGS: Record<Agent, readonly string[]> = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status'],
  opencode: ['auth', 'list'],
};

/**
 * A one-line turn, run only when the person asks (`kestrel-node agents --check`), since it spends a little of their
 * usage: the only way to know whether a provider will take a turn (in the spike OpenCode was signed in and its
 * provider still refused every turn). Each is the agent's own non-interactive mode, in an empty folder of Kestrel's.
 */
export const CHECK_PROMPT = 'Reply with the single word OK.';
export const NODE_CHECK_ARGS: Record<Agent, readonly string[]> = {
  claude: ['-p', CHECK_PROMPT, '--max-turns', '1'],
  codex: ['exec', '--skip-git-repo-check', CHECK_PROMPT],
  opencode: ['run', CHECK_PROMPT],
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const plainText = (text: string): string => text.replace(ANSI, '');

/** The version a program printed for `--version` ("codex-cli 0.172.0", "2.1.322 (Claude Code)"), or null. */
export function versionFrom(output: string): string | null {
  return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(plainText(output))?.[0] ?? null;
}

/** What `codex login status` said: true signed in, false not, null when it could not be told. */
export function codexSignedInFrom(output: string): boolean | null {
  const text = plainText(output);
  if (/not logged in/i.test(text)) return false;
  if (/logged in/i.test(text)) return true;
  return null;
}

/**
 * What `opencode auth list` said: true when it lists a credential, false when it lists none, null when it could not
 * be told. Only its count is read ("1 credentials"); the lines name providers, never a key.
 */
export function opencodeSignedInFrom(output: string): boolean | null {
  const counts = [...plainText(output).matchAll(/(\d+)\s+credentials?\b/gi)].map((m) => Number(m[1]));
  if (counts.length === 0) return null;
  return counts.some((n) => n > 0);
}

/** The last line a program printed that says something, for a check that failed. Never more than one line. */
export function lastLineOf(output: string): string | null {
  const lines = plainText(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? clipped(lines.at(-1)!) : null;
}

/** The last `count` lines a program printed that say something, each clipped; for a step that failed. */
export function lastLinesOf(output: string, count: number): string[] {
  const lines = plainText(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return lines.slice(-count).map((line) => (line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line));
}
