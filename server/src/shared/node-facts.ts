// What a worker node publishes for its page on other screens (docs/designs/worker-nodes.md, section 10): its settings
// (shared/node-settings.ts) and the status facts the page shows, in words, made from the same value `kestrel node
// status` prints (`nodeStatusOf`), so the terminal and the page never disagree. Carried in the node's offers record
// (shared/machine-offers.ts, `node`), bounded, and cleaned with the rest of the record before it leaves the node. Pure.
import { SELECTABLE_AGENTS, type Agent } from '../model.ts';
import { gitStatusLines } from './node-git-status.ts';
import { LOW_DISK_BYTES, sizeText } from './node-host.ts';
import { WITHOUT_LINGERING } from './node-service.ts';
import { asNodeSettings, type NodeSettingsValues } from './node-settings.ts';
import { projectsLine, type NodeStatus } from './node-status.ts';

/** The status facts as the page shows them: one line each, never a secret, never a path other than what `status` prints. */
export interface NodeFacts {
  /** Each agent: "Can run", or why not in the node's words for another device. */
  agents: Record<Agent, string>;
  git: string;
  sandbox: string;
  lingering: string;
  freeDisk: string;
  projects: string;
}

/** What the node's offers record carries for its page. */
export interface NodePublished {
  settings: NodeSettingsValues;
  facts: NodeFacts;
}

/** The longest a fact may be: a projects line naming many projects is cut, so the record stays small. */
export const FACT_MAX = 1000;

const bounded = (text: string): string => (text.length > FACT_MAX ? `${text.slice(0, FACT_MAX - 1)}…` : text);
const unlabelled = (line: string, label: string): string => (line.startsWith(label) ? line.slice(label.length) : line);

function lingeringFact(s: NodeStatus): string {
  if (s.host.lingering === 'on') return 'On: the node runs with nobody logged in, and starts after a reboot.';
  if (s.host.lingering === 'unknown') return 'Not known: this system has no systemd.';
  return `Off. ${WITHOUT_LINGERING} An administrator turns it on there; "kestrel node configure" shows the command.`;
}

function diskFact(s: NodeStatus): string {
  if (!s.host.disk) return 'Could not be measured.';
  const low = s.host.disk.freeBytes < LOW_DISK_BYTES ? ' Low: sessions’ worktrees and the agents need room.' : '';
  return `${sizeText(s.host.disk.freeBytes)} free.${low}`;
}

/** The facts, from the status value. Pure. */
export function nodeFactsOf(s: NodeStatus): NodeFacts {
  const agents = Object.fromEntries(SELECTABLE_AGENTS.map((agent) => {
    const state = s.agents.find((a) => a.agent === agent);
    return [agent, bounded(!state ? 'Not on this node.' : state.canRun ? 'Can run' : (state.why ?? 'Cannot run; it did not say why.'))];
  })) as Record<Agent, string>;
  return {
    agents,
    git: bounded(unlabelled(gitStatusLines(s.git)[0] ?? '', 'Git: ')),
    sandbox: bounded(s.sandbox.available ? 'Available' : `Not available. ${s.sandbox.why ?? ''}`.trim()),
    lingering: lingeringFact(s),
    freeDisk: diskFact(s),
    projects: bounded(s.projects ? unlabelled(projectsLine(s.projects), 'Projects: ') : 'Not read yet.'),
  };
}

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const fact = (value: unknown): value is string => typeof value === 'string' && value.length <= FACT_MAX;

/** The facts as a reader may use them; null when they are not facts. */
export function asNodeFacts(raw: unknown): NodeFacts | null {
  const o = obj(raw);
  const agents = o && obj(o.agents);
  if (!o || !agents || !SELECTABLE_AGENTS.every((a) => fact(agents[a]))) return null;
  if (![o.git, o.sandbox, o.lingering, o.freeDisk, o.projects].every(fact)) return null;
  return {
    agents: Object.fromEntries(SELECTABLE_AGENTS.map((a) => [a, agents[a] as string])) as Record<Agent, string>,
    git: o.git as string,
    sandbox: o.sandbox as string,
    lingering: o.lingering as string,
    freeDisk: o.freeDisk as string,
    projects: o.projects as string,
  };
}

/** What a node published for its page, as a reader may use it; null when either part is not one. */
export function asNodePublished(raw: unknown): NodePublished | null {
  const o = obj(raw);
  const settings = o && asNodeSettings(o.settings);
  const facts = o && asNodeFacts(o.facts);
  return settings && facts ? { settings, facts } : null;
}
