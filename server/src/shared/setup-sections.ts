// Set up this computer as section cards (docs/designs/onboarding.md, 18.6): each section's one summary
// line, the one command that covers it where there is one, and this computer's dismissals laid over the
// list. Pure and browser-safe; the page draws what these say.
import { SETUP_GROUPS, setupToDo, type SetupGroup, type SetupLine, type SetupList, copySourceText } from './setup-list.ts';
import { commandText, type SetupCommand } from './setup-install.ts';

/** How a line's run stands, as the server pushes it (18.5). */
export type SetupRunState =
  /** `output`: the end of what the command has printed so far, shown under it as it runs. */
  | { state: 'running'; at: number; output?: string }
  | { state: 'done'; at: number; said: string; output?: string }
  | { state: 'failed'; at: number; reason: string; output: string }
  /** `ask`: the person chooses on the line (Replace or Keep, for files here that differ). */
  /** `code` and `url`: a sign-in's one-time code and the page to enter it on, shown to copy and open. */
  /** `need`: the step it waits on, by id; the wait is over, and the mark goes, once that step is done. */
  | { state: 'waiting'; at: number; on: string; ask?: 'replace-or-keep'; code?: string; url?: string; output?: string; need?: string };

export type SetupRuns = Record<string, SetupRunState>;

/** A section as its card shows it. */
export interface SetupSection {
  group: SetupGroup;
  title: string;
  summary: string;
  command: SetupCommand | null;
  /** Steps still to do that the section's commands do not cover (a page to open, a copy, a tool Kestrel knows no command for), by title. */
  uncovered: string[];
  /** Lines still to do that are not dismissed. */
  left: number;
  /** Nothing left: it folds under Already here. */
  finished: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a section counts its lines in. */
const UNIT: Record<SetupGroup, [string, string]> = {
  agents: ['agent', 'agents'],
  git: ['step', 'steps'],
  tools: ['tool', 'tools'],
  projects: ['repository', 'repositories'],
  mcp: ['server', 'servers'],
  settings: ['line', 'lines'],
  knowledge: ['knowledge base', 'knowledge bases'],
  kestrel: ['setting', 'settings'],
};

/** Each agent's skills and rules counted as the grouped lines say, for the Agent settings summary. */
function settingsWhat(lines: readonly SetupLine[]): { what: string; here: number; total: number } {
  let here = 0;
  let total = 0;
  for (const l of lines) {
    const n = l.items ? l.items.total : 1;
    total += n;
    here += l.items ? l.items.here : l.done ? 1 : 0;
  }
  const grouped = lines.filter((l) => l.items).map((l) => l.title);
  const singles = lines.filter((l) => !l.items).length;
  return { what: [...grouped, ...(singles > 0 ? [plural(singles, grouped.length > 0 ? 'other file' : 'file')] : [])].join(', '), here, total };
}

/** The section's one summary line: what is in it and how much is done, with waiting and failed counts. Pure. */
export function setupSectionOf(group: SetupGroup, lines: readonly SetupLine[], runs: SetupRuns = {}): SetupSection {
  const title = SETUP_GROUPS.find((g) => g.id === group)?.title ?? group;
  const mine = lines.filter((l) => l.group === group && !l.dismissed);
  const left = mine.filter(setupToDo).length;
  const waiting = mine.filter((l) => !l.done && (runs[l.id]?.state === 'waiting' || l.needs.some((id) => lines.some((n) => n.id === id && !n.done)))).length;
  const failed = mine.filter((l) => !l.done && runs[l.id]?.state === 'failed').length;
  const cannot = mine.filter((l) => l.kind === 'cannot').length;
  let base: string;
  if (group === 'settings') {
    const { what, here, total } = settingsWhat(mine);
    base = `${what}; ${here} of ${total} done`;
  } else {
    const [one, many] = UNIT[group];
    const counted = mine.filter((l) => l.kind !== 'cannot');
    const here = counted.filter((l) => l.done).length;
    base = `${group === 'projects' ? 'Clone projects: ' : ''}${plural(counted.length, one, many)}, ${here} done`;
  }
  const extra = [failed > 0 && `${failed} failed`, waiting > 0 && `${waiting} ${waiting === 1 ? 'needs' : 'need'} an earlier step`, cannot > 0 && `${cannot} cannot be brought over`].filter(Boolean);
  const command = sectionCommandOf(group, mine);
  const uncovered = command ? mine.filter((l) => setupToDo(l) && !l.command).map((l) => l.title) : [];
  return { group, title, summary: extra.length ? `${base}; ${extra.join(', ')}` : base, command, uncovered, left, finished: left === 0 };
}

/**
 * One command that covers the section, where there is one: installs that share a package manager in one
 * call, the git identity, every clone one per line. Null where the steps share none (MCP servers, files).
 * Only lines still to do are in it. Pure.
 */
export function sectionCommandOf(group: SetupGroup, lines: readonly SetupLine[]): SetupCommand | null {
  const todo = inNeedOrder(lines.filter((l) => l.group === group && setupToDo(l) && l.command));
  if (todo.length === 0 || group === 'mcp' || group === 'settings') return null;
  const shell = todo[0]!.command!.shell;
  if (group === 'tools') {
    // `brew install a` + `brew install b` → `brew install a b`; anything else one per line.
    const brew = todo.filter((l) => /^brew install \S+$/.test(l.command!.text));
    const joined = brew.length > 1 ? commandText(['brew', 'install', ...brew.map((l) => l.command!.text.split(' ')[2]!)], shell) : brew[0]?.command!.text;
    // The one `brew install` stands where the first of them stood, so what it needs (Homebrew itself) is still before it.
    const text = todo.flatMap((l) => (brew.includes(l) ? (l === brew[0] ? [joined!] : []) : [l.command!.text]));
    return { shell, text: text.join('\n') };
  }
  // Each command once: two steps that share one (the same key made for two hosts) do not say it twice.
  return { shell, text: [...new Set(todo.flatMap((l) => l.command!.text.split('\n')))].join('\n') };
}

/** The lines with each after the lines of the same list it needs first, otherwise in the order given. Pure. */
function inNeedOrder(lines: readonly SetupLine[]): SetupLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: SetupLine[] = [];
  const seen = new Set<string>();
  const visit = (line: SetupLine) => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    for (const id of line.needs) {
      const need = byId.get(id);
      if (need) visit(need);
    }
    out.push(line);
  };
  for (const line of lines) visit(line);
  return out;
}

/**
 * The run states still true of this list: a step that is done no longer waits or runs, and a step that
 * waited on another stops waiting once that one is done. Same object when nothing is stale. Pure.
 */
export function freshRuns(runs: SetupRuns, lines: readonly Pick<SetupLine, 'id' | 'done'>[]): SetupRuns {
  const done = new Set(lines.filter((l) => l.done).map((l) => l.id));
  const stale = Object.entries(runs).filter(([id, run]) => run.state === 'waiting' && (done.has(id) || (run.need !== undefined && done.has(run.need))));
  if (stale.length === 0) return runs;
  const gone = new Set(stale.map(([id]) => id));
  return Object.fromEntries(Object.entries(runs).filter(([id]) => !gone.has(id)));
}

/** What a section's one button says when it has no terminal command of its own: what it does to every step in it. Pure. */
export function sectionActLabel(group: SetupGroup, from: readonly string[] = []): string {
  if (group === 'mcp' || group === 'settings') return `Copy all from ${copySourceText(from)}`;
  if (group === 'knowledge') return 'Use as knowledge base';
  if (group === 'kestrel') return `Copy from ${copySourceText(from)}`;
  return 'Run';
}

/** The list with this computer's dismissals marked. A dismissed id that matches no line is simply kept. Pure. */
export function applyDismissals(list: SetupList, dismissed: readonly string[]): SetupList {
  const set = new Set(dismissed);
  if (set.size === 0 && list.lines.every((l) => !l.dismissed)) return list;
  return {
    ...list,
    lines: list.lines.map((l) => {
      const isDismissed = set.has(l.id);
      const gone = l.items && itemsDismissable(l) ? l.items.names.filter((n) => set.has(itemId(l.id, n.name))).map((n) => n.name) : [];
      if (gone.length === 0) return isDismissed === l.dismissed ? l : { ...l, dismissed: isDismissed };
      return withoutItems({ ...l, dismissed: isDismissed }, new Set(gone));
    }),
  };
}

/** A skills line less the skills dismissed one by one: its names, counts and the paths Run writes. */
function withoutItems(line: SetupLine, gone: ReadonlySet<string>): SetupLine {
  const names = line.items!.names.filter((n) => !gone.has(n.name));
  const here = names.filter((n) => n.done).length;
  const total = names.length;
  const action = line.action?.kind === 'files' ? { ...line.action, paths: line.action.paths.filter((p) => !gone.has(p.slice(p.lastIndexOf('/') + 1))) } : line.action;
  return { ...line, action, done: here === total, items: { names, here, total, progress: here > 0 && here < total ? `${here} of ${total} here` : null } };
}

/** Whether a grouped line's names can be dismissed one by one: skills, named by folder. */
export const itemsDismissable = (line: Pick<SetupLine, 'id'>): boolean => /^files:[a-z]+:skill$/.test(line.id);

/** The id one name inside a grouped line is dismissed under ("not this skill"). */
export const itemId = (lineId: string, name: string): string => `${lineId}#${name}`;

/** Dismissed ids after a change: added or taken out, each once, at most a bounded number. Pure. */
export function nextDismissals(before: readonly string[], ids: readonly string[], dismissed: boolean): string[] {
  const set = new Set(before);
  for (const id of ids) {
    if (dismissed) set.add(id);
    else set.delete(id);
  }
  return [...set].slice(-MAX_DISMISSED);
}

export const MAX_DISMISSED = 2000;
