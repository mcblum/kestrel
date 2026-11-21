// The one line a finished series of tool steps folds to: what was done, not how many things.
// "Ran cat /some/file and 3 other commands", "Read 4 files, ran pnpm test, edited app.ts".
// Pure. Step texts are imperative lines from the agents' adapters ("Run pnpm test", "Read src/a.ts",
// "Edit b.ts", "Grep pattern"; agents/claude/describe.ts); older and sample data may already be in
// the past tense, which is left as it is.

interface Kind {
  /** Past tense of the verb that starts the step's text. */
  past: string;
  /** What several of them are called: "3 commands". Absent: they are just "steps". */
  noun?: [one: string, many: string];
}

const COMMAND: Kind['noun'] = ['command', 'commands'];
const FILE: Kind['noun'] = ['file', 'files'];
const SEARCH: Kind['noun'] = ['search', 'searches'];

/** First word of a step, lower-case → its kind. Kinds with the same `past` and noun are counted together. */
const KINDS: Record<string, Kind> = {
  run: { past: 'Ran', noun: COMMAND },
  ran: { past: 'Ran', noun: COMMAND },
  read: { past: 'Read', noun: FILE },
  edit: { past: 'Edited', noun: FILE },
  edited: { past: 'Edited', noun: FILE },
  write: { past: 'Wrote', noun: FILE },
  wrote: { past: 'Wrote', noun: FILE },
  grep: { past: 'Searched for', noun: SEARCH },
  glob: { past: 'Searched for', noun: SEARCH },
  open: { past: 'Opened' },
  click: { past: 'Clicked' },
  type: { past: 'Typed' },
  take: { past: 'Took' },
  load: { past: 'Loaded' },
  list: { past: 'Listed' },
  boot: { past: 'Booted' },
  launch: { past: 'Launched' },
  tap: { past: 'Tapped' },
  swipe: { past: 'Swiped' },
  pinch: { past: 'Pinched' },
};

/** A step that would change a file but failed (Kestrel refused it, or the tool did) changed nothing: it is told as tried. */
const TRIED: Record<string, Kind> = {
  edit: { past: 'Tried to edit', noun: FILE },
  edited: { past: 'Tried to edit', noun: FILE },
  write: { past: 'Tried to write', noun: FILE },
  wrote: { past: 'Tried to write', noun: FILE },
};

interface Step {
  text: string;
  status?: 'running' | 'done' | 'failed' | 'stopped';
}

interface Told {
  kind: Kind | null;
  /** The step in the past tense: "Ran cat /some/file". Unknown verbs are told as written. */
  line: string;
}

function tell({ text, status }: Step): Told {
  const line = text.trim();
  const space = line.search(/\s/);
  const verb = (space < 0 ? line : line.slice(0, space)).toLowerCase();
  const kind = (status === 'failed' ? TRIED[verb] : undefined) ?? KINDS[verb] ?? null;
  if (!kind) return { kind, line };
  const rest = space < 0 ? '' : line.slice(space + 1).trim();
  return { kind, line: rest ? `${kind.past} ${rest}` : kind.past };
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const groupKey = (t: Told) => (t.kind ? `${t.kind.past}|${t.kind.noun?.[1] ?? ''}` : 'other');
const MAX_GROUPS = 3;

/**
 * What a finished series of steps did, on one line.
 * - one step: the step itself ("Ran cat /some/file");
 * - all of one kind: the first, and how many more ("Ran cat /some/file and 3 other commands");
 * - several kinds: each kind in the order it first appeared, named when there is one of it and
 *   counted when there are more ("Read 4 files, ran pnpm test, edited app.ts"), at most three kinds
 *   and then how many steps are left.
 * Failures, and steps the user stopped before they finished, are counted at the end (" · 1 failed",
 * " · 1 stopped"). A failed edit or write is told as tried ("tried to edit app.ts"): it changed nothing.
 */
export function stepsSummary(steps: readonly Step[]): string {
  const told = steps.map(tell);
  const tail = endings(steps);
  if (told.length === 0) return `No steps${tail}`;
  if (told.length === 1) return `${told[0]!.line}${tail}`;

  const groups = new Map<string, Told[]>();
  for (const t of told) groups.set(groupKey(t), [...(groups.get(groupKey(t)) ?? []), t]);
  if (groups.size === 1) {
    const [first, ...rest] = told;
    const noun = first!.kind?.noun ?? ['step', 'steps'];
    return `${first!.line} and ${rest.length} other ${rest.length === 1 ? noun[0] : noun[1]}${tail}`;
  }

  const shown = [...groups.values()].slice(0, MAX_GROUPS);
  const left = told.length - shown.reduce((n, g) => n + g.length, 0);
  const parts = shown.map((g) => {
    if (g.length === 1) return g[0]!.line;
    const kind = g[0]!.kind;
    return kind?.noun ? `${kind.past} ${g.length} ${kind.noun[1]}` : `${g.length} other steps`;
  });
  const said = parts.map((p, i) => (i === 0 ? p : lower(p))).join(', ');
  return `${said}${left > 0 ? `, and ${left} more ${left === 1 ? 'step' : 'steps'}` : ''}${tail}`;
}

/** " · 1 failed, 1 stopped": how many steps did not finish, and how; empty when all did. */
function endings(steps: readonly Step[]): string {
  const counts = (['failed', 'stopped'] as const).map((status) => [steps.filter((s) => s.status === status).length, status] as const);
  const said = counts.filter(([n]) => n > 0).map(([n, status]) => `${n} ${status}`);
  return said.length ? ` · ${said.join(', ')}` : '';
}

/** What Kestrel said about a step: it refused it, or it went through though Kestrel would have refused it. */
export interface StepNote {
  kind: 'refusal' | 'warning';
  /** The reason, whole. */
  text: string;
  /** Its first line, for the folded row. */
  line: string;
}

/** A step's own note, from the fields the adapters set (never parsed from text); null for a plain step. */
export function stepNote(step: { refusal?: string; warning?: string }): StepNote | null {
  const kind = step.refusal ? 'refusal' : step.warning ? 'warning' : null;
  if (!kind) return null;
  const text = (step.refusal ?? step.warning)!.trim();
  return { kind, text, line: shortPaths(text.split('\n')[0]!) };
}

/** A path of more than two folders, wherever it is in a line. */
const LONG_PATH = /(?:~|(?<![\w.~-]))(?:\/[^\s/"'“”‘’:,;()]+){3,}/g;
/** How much of a long path a folded line keeps: its last folder and the file. */
const PATH_TAIL_SEGMENTS = 2;

/**
 * A line with its long paths cut to their last folder and file ("…/beta/README.md"), for the one
 * folded line: a reason that starts with a deep path would otherwise show the path and nothing of
 * the reason. The full text keeps every path whole.
 */
function shortPaths(line: string): string {
  return line.replace(LONG_PATH, (path) => `…/${path.split('/').slice(-PATH_TAIL_SEGMENTS).join('/')}`);
}

/** The note a folded series of steps shows under its summary line: the first refusal, else the first warning. */
export function stepsNote(steps: readonly { refusal?: string; warning?: string }[]): StepNote | null {
  const notes = steps.map(stepNote).filter((n): n is StepNote => n !== null);
  return notes.find((n) => n.kind === 'refusal') ?? notes[0] ?? null;
}
