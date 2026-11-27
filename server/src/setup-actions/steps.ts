// Set up this computer's steps, carried out (docs/designs/onboarding.md, section 18). This owns what
// the page can change: this computer's dismissals (one machine setting, never in the sealed record), and
// runs, one line or a section at a time, their state held here in memory and pushed to every window.
// A line is always taken from the server's own list, built again before each run; the page sends ids
// only. What each kind of step does is the executor's (execute.ts); this decides order, needs and
// state, and nothing here runs a command itself.
import { Refused } from '../refused.ts';
import type { SettingStore } from '../suggestions/prefs.ts';
import { fullyDefined, type SetupAction, type SetupGroup, type SetupLine, type SetupList } from '../shared/setup-list.ts';
import type { SetupFileRecord } from '../shared/setup-files.ts';
import { applyDismissals, nextDismissals, type SetupRuns, type SetupRunState, freshRuns } from '../shared/setup-sections.ts';

export const SETUP_DISMISSED_KEY = 'setup-dismissed';

/** What one step answered. `undo` puts back exactly what it did, when Kestrel can. */
export type StepResult =
  | { state: 'done'; said: string; undo?: () => Promise<void> }
  | { state: 'waiting'; on: string; ask?: 'replace-or-keep' }
  | { state: 'failed'; reason: string; output: string };

/** What a run hands a step: the line, the person's input for it, and where its output goes. */
export interface StepContext {
  line: SetupLine;
  list: SetupList;
  /** What the person typed or chose on the line (a token, Replace or Keep). Never kept. */
  input: Record<string, string>;
  output(text: string): void;
  /** While it runs, what it waits on from the person ("enter ABCD-1234 at github.com/login/device"). */
  say(on: string, signIn?: { code?: string; url?: string }): void;
  /** This line's files as the other computers hold them (18.3); null when none does. Read only when asked. */
  files(): Promise<SetupFileRecord | null>;
}

export type Execute = (action: SetupAction, ctx: StepContext) => Promise<StepResult>;

export interface SetupStepsDeps {
  /** The list as built from the records and this machine now (connect.ts `setupList`). */
  list(): Promise<SetupList>;
  settings: SettingStore;
  /** Carries out one step. None: nothing can run in this copy. */
  execute?: Execute;
  /** A line's file records from the computers named (setup-records.ts). */
  files?(line: string, from: readonly string[]): Promise<SetupFileRecord | null>;
  now?(): number;
}

/** How many lines of a step's output are kept for its line, shown only on a failure. */
export const OUTPUT_LINES = 40;

/** What a run did, for the page's toast: what was done, what waits, what failed, and what Undo takes back. */
export interface RunReport {
  done: string[];
  waiting: string[];
  failed: string[];
  /** Lines run first because a line of the section needed them (18.5). */
  also: string[];
  /** A token for `undo`, when something can be put back. */
  undo: string | null;
}

/** Steps that need the person: a section's button stops at them (Matt, Q3 and Q4; the knowledge base, 18.15). */
export function needsPerson(line: SetupLine): boolean {
  const kind = line.action?.kind;
  return kind === 'sign-in' || kind === 'host-sign-in' || kind === 'ssh-key' || kind === 'knowledge' || line.run === 'paste' || line.run === 'open';
}

/** Why a line cannot run now, or null. Used for a click on one line and for an agent's `setup_run_step`. Pure. */
export function refusalOf(line: SetupLine | undefined, list: SetupList): string | null {
  if (!line) return 'That step is not on this computer\'s list any more. Check again.';
  if (line.dismissed) return `"${line.title}" is dismissed. Restore it first.`;
  if (line.done) return `"${line.title}" is already done here.`;
  if (!line.action) return line.command ? `Kestrel cannot run "${line.title}": paste its command into a terminal.` : `Kestrel cannot run "${line.title}": ${line.does}`;
  if (line.run === 'paste') return `"${line.title}" needs an administrator: paste its command into a terminal, then Check again.`;
  // A need Kestrel can do itself, with nothing from the person, is run first instead (`planOf`).
  const unmet = line.needs.map((id) => list.lines.find((l) => l.id === id)).filter((l): l is SetupLine => !!l && !l.done && !autoNeed(l));
  if (unmet.length > 0) return `"${line.title}" needs ${unmet.map((l) => `"${l.title}"`).join(' and ')} first.`;
  return null;
}

/**
 * Why an agent's approved `setup_run_step` may not run a line, or null (18.14). Stricter than a click: a
 * step that needs the operating system's own prompt, the person (a sign-in, a key, the knowledge base, a
 * choice between files), or is not fully ready, is refused with what to tell the person. Pure.
 */
export function agentStepRefusal(line: SetupLine | undefined, list: SetupList): string | null {
  if (!line || line.done || line.dismissed) return refusalOf(line, list);
  const kind = line.action?.kind;
  if (kind === 'ssh-key') return `"${line.title}" makes a key with no passphrase, which only the person's own click on its line may do. Ask them to press Run there.`;
  if (kind === 'knowledge') return `"${line.title}" is the person's choice of knowledge base, made only by their click on its line or in Settings → Workflow → Knowledge base.`;
  if (kind === 'models') return `"${line.title}" changes which agent does what, which only the person does: by their click on its line or in Settings → Models & roles.`;
  if (line.run === 'os-prompt' || line.run === 'open') return `"${line.title}" needs the operating system's own prompt or page: ask the person to press Run on its line.`;
  if (needsPerson(line)) return `"${line.title}" needs the person: ask them to press Run on its line.`;
  const plain = refusalOf(line, list);
  if (plain) return plain;
  const unmet = line.needs.filter((id) => list.lines.some((l) => l.id === id && !l.done));
  if (unmet.length > 0) return `"${line.title}" needs ${unmet.map((id) => `"${list.lines.find((l) => l.id === id)!.title}"`).join(' and ')} first.`;
  return null;
}

/** How often a running step's output is pushed to the page. */
const OUTPUT_EVERY_MS = 300;
const tail = (text: string) => text.split(/\r?\n/).filter((l, i, all) => l.length > 0 || i < all.length - 1).slice(-OUTPUT_LINES).join('\n');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A need run first without asking: fully defined, nothing of the person's, not dismissed (Matt, Q4). */
const autoNeed = (line: SetupLine): boolean => !line.dismissed && line.kind !== 'cannot' && fullyDefined(line) && !needsPerson(line);

/**
 * The lines to run for `targets`, in need order: each target's open needs in its own section, and the
 * fully defined ones from anywhere, first; `also` the ones pulled in from elsewhere. Pure.
 */
export function planOf(targets: readonly SetupLine[], list: SetupList, group: SetupGroup | null): { order: SetupLine[]; also: SetupLine[] } {
  const byId = new Map(list.lines.map((l) => [l.id, l]));
  const open = (l: SetupLine) => !l.done && !l.dismissed && l.kind !== 'cannot';
  const order: SetupLine[] = [];
  const also: SetupLine[] = [];
  const seen = new Set<string>();
  const visit = (line: SetupLine, target: boolean) => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    for (const id of line.needs) {
      const need = byId.get(id);
      if (need && open(need) && ((group !== null && need.group === group) || autoNeed(need))) visit(need, group !== null && need.group === group);
    }
    order.push(line);
    if (!target) also.push(line);
  };
  for (const line of targets) visit(line, true);
  return { order, also };
}

/** The lines a section's button runs, with the fully defined needs from anywhere run first, in order. Pure. */
export function sectionPlan(group: SetupGroup, list: SetupList): { order: SetupLine[]; also: SetupLine[] } {
  const open = (l: SetupLine) => !l.done && !l.dismissed && l.kind !== 'cannot';
  return planOf(list.lines.filter((l) => l.group === group && open(l)), list, group);
}

export class SetupSteps {
  private raw: SetupList | null = null;
  private runState: SetupRuns = {};
  private readonly listeners = new Set<(runs: SetupRuns) => void>();
  private readonly undos = new Map<string, () => Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();
  private undoCount = 0;

  constructor(private readonly deps: SetupStepsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async dismissed(): Promise<string[]> {
    try {
      const raw = JSON.parse((await this.deps.settings.getSetting(SETUP_DISMISSED_KEY)) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** The list, read again, with this computer's dismissals. */
  async list(): Promise<SetupList> {
    this.raw = await this.deps.list();
    // A wait that is over (the step it waited on is done now) is not said any more.
    const fresh = freshRuns(this.runState, this.raw.lines);
    if (fresh !== this.runState) {
      this.runState = fresh;
      for (const listener of this.listeners) listener(this.runState);
    }
    return applyDismissals(this.raw, await this.dismissed());
  }

  /** Dismisses or restores lines; answers the list as held, without reading the machine again. */
  async dismiss(ids: readonly string[], dismissed: boolean): Promise<SetupList> {
    if (ids.length === 0 || ids.length > 500 || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 600)) throw new Refused('ids must name the lines to dismiss or restore.');
    const next = nextDismissals(await this.dismissed(), ids, dismissed);
    await this.deps.settings.putSetting(SETUP_DISMISSED_KEY, JSON.stringify(next));
    return applyDismissals(this.raw ?? (await this.deps.list()), next);
  }

  runs(): SetupRuns {
    return this.runState;
  }

  onChange(listener: (runs: SetupRuns) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(id: string, state: SetupRunState): void {
    this.runState = { ...this.runState, [id]: state };
    for (const listener of this.listeners) listener(this.runState);
  }

  /** One at a time: two runs never write the same file or git setting together. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Runs one line, on a click (or an agent's approved `setup_run_step`). Refused with the reason when it cannot run. */
  runLine(id: string, input: Record<string, string> = {}): Promise<RunReport> {
    return this.queued(async () => {
      const list = await this.list();
      const line = list.lines.find((l) => l.id === id);
      const refused = refusalOf(line, list);
      if (refused) throw new Refused(refused);
      const { order, also } = planOf([line!], list, null);
      return this.carryOut(order, list, also, input);
    });
  }

  /** Runs a section's lines in need order, its fully defined needs from other sections first (18.5). */
  runSection(group: SetupGroup): Promise<RunReport> {
    return this.queued(async () => {
      const list = await this.list();
      const { order, also } = sectionPlan(group, list);
      if (order.length === 0) throw new Refused('Nothing in this section is left to do.');
      return this.carryOut(order, list, also, {}, true);
    });
  }

  private async carryOut(order: SetupLine[], list: SetupList, also: SetupLine[], input: Record<string, string>, section = false): Promise<RunReport> {
    const execute = this.deps.execute;
    if (!execute) throw new Refused('This copy of Kestrel cannot run set-up steps.');
    const report: RunReport = { done: [], waiting: [], failed: [], also: also.map((l) => l.title), undo: null };
    const finished = new Set(list.lines.filter((l) => l.done).map((l) => l.id));
    const stopped = new Map<string, string>(); // line id → what it waits on
    const undos: (() => Promise<void>)[] = [];
    for (const line of order) {
      const blocking = line.needs.find((id) => !finished.has(id));
      if (blocking) {
        const need = list.lines.find((l) => l.id === blocking);
        const on = stopped.get(blocking) ?? (need ? `"${need.title}"` : 'a step before it');
        stopped.set(line.id, on);
        this.set(line.id, { state: 'waiting', at: this.now(), on, need: blocking });
        report.waiting.push(line.title);
        continue;
      }
      if (section && (needsPerson(line) || !line.action)) {
        const on = `you: "${line.title}" needs you, on its own line`;
        stopped.set(line.id, `"${line.title}"`);
        this.set(line.id, { state: 'waiting', at: this.now(), on });
        report.waiting.push(line.title);
        continue;
      }
      this.set(line.id, { state: 'running', at: this.now() });
      let output = '';
      // What the command prints is shown under it as it runs, at most a few times a second.
      let shownAt = 0;
      const show = () => {
        const current = this.runState[line.id];
        if (!current || (current.state !== 'running' && current.state !== 'waiting') || this.now() - shownAt < OUTPUT_EVERY_MS) return;
        shownAt = this.now();
        this.set(line.id, { ...current, output });
      };
      let result: StepResult;
      try {
        result = await execute(line.action!, { line, list, input, output: (text) => ((output = tail(output + text)), show()), say: (on, signIn) => this.set(line.id, { state: 'waiting', at: this.now(), on, ...(signIn?.code ? { code: signIn.code } : {}), ...(signIn?.url ? { url: signIn.url } : {}), output }), files: async () => (await this.deps.files?.(line.id, line.from)) ?? null });
      } catch (error) {
        result = { state: 'failed', reason: message(error), output };
      }
      if (result.state === 'done') {
        finished.add(line.id);
        if (result.undo) undos.push(result.undo);
        this.set(line.id, { state: 'done', at: this.now(), said: result.said, ...(output ? { output } : {}) });
        report.done.push(line.title);
      } else if (result.state === 'waiting') {
        stopped.set(line.id, `"${line.title}"`);
        this.set(line.id, { state: 'waiting', at: this.now(), on: result.on, ...(result.ask ? { ask: result.ask } : {}) });
        report.waiting.push(line.title);
      } else {
        stopped.set(line.id, `"${line.title}", which failed`);
        this.set(line.id, { state: 'failed', at: this.now(), reason: result.reason, output: tail(result.output || output) });
        report.failed.push(line.title);
      }
    }
    if (undos.length > 0) {
      const token = `undo-${++this.undoCount}`;
      this.undos.set(token, async () => {
        for (const undo of undos.reverse()) await undo();
      });
      report.undo = token;
    }
    return report;
  }

  /** Keeps an Undo made outside a run (copied values, onboarding.md 19.4) under a token `undo` takes. */
  keepUndo(undo: () => Promise<void>): string {
    const token = `undo-${++this.undoCount}`;
    this.undos.set(token, undo);
    return token;
  }

  /** Takes back what a run did, where Kestrel can put it back exactly. Each token once. */
  undo(token: string): Promise<void> {
    return this.queued(async () => {
      const undo = this.undos.get(token);
      if (!undo) throw new Refused('That can no longer be undone.');
      this.undos.delete(token);
      await undo();
    });
  }

  /** The page was left: results from before go, so the next visit starts from the checks. */
  forget(): void {
    this.runState = {};
    for (const listener of this.listeners) listener(this.runState);
  }
}
