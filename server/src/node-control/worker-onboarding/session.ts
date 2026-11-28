// The interactive screen's side of the node's terminal flows (docs/designs/worker-terminal-handoff.md). The flows
// (setup-flow.ts, join-flow.ts, agents-checklist.ts, git-checklist.ts) say what happens as the same typed events the
// plain transcript draws; this turns them into one `WorkerFrame` per operation, their questions into typed prompts,
// and their interactive programs (sudo, an agent's or a git tool's sign-in) into handoffs. It holds no Ink: the
// terminal it drives is given (terminal.tsx, loaded only when `canUseWorkerInk()` says so), so it is tested alone.
import { NODE_ANSWER_MAX_CHARS, type JoinStep, type NodeJoinEvent } from '../../shared/node-commands.ts';
import { groupedCode, nestedEvent, type DrawEvent } from '../join-draw.ts';
import { answerText, trustOf, workerPromptOf, type AskHint } from './ask.ts';
import type { WorkerDetail, WorkerFrame, WorkerStep } from './model.ts';
import type { WorkerTerminal } from './terminal.tsx';

/** The progress line: configure's from the node's status; a command's own from its sections. */
export type StepsOf = (current: number | null, finished: boolean) => readonly WorkerStep[] | undefined;

export interface WorkerSessionOptions {
  /** Worker setup, Pair this worker, Set up agents, or Set up Git. */
  name: string;
  /** This computer's name, as other devices see it. */
  node: string;
  /** A command's own numbered sections, in order; `seen` lists them as their headings arrive. */
  sections?: readonly string[] | 'seen';
  /** Overrides `sections`: configure draws its four from the node's status. */
  steps?: StepsOf;
}

/** What a flow's io needs: `say`, `ask` with an optional hint, `ran`, and that choices are drawn as choices here. */
export interface WorkerIo {
  say(event: NodeJoinEvent): void;
  ask(step: JoinStep, prompt: string, hint?: AskHint): Promise<string | null>;
  ran(): void;
  readonly drawsChoices: true;
}

/** How a command ended, as its flow said. */
type Ended = Extract<NodeJoinEvent, { event: 'end' }>;

const COMMAND_TITLE = /^Kestrel worker node\b/;

export class WorkerSession {
  private term: WorkerTerminal | null = null;
  private title = 'Checking this node';
  private details: WorkerDetail[] = [];
  private status: string | undefined;
  private section: number | null = null;
  private readonly seen: string[] = [];
  private readonly troubled = new Set<number>();
  private asked = 0;
  private pending = false;
  private readonly cancels: (() => void)[] = [];
  /** How the command at the top ended; a nested command's end is a line in its section. */
  ended: Ended | null = null;
  /** Ctrl+C was pressed. */
  stopped = false;

  private node: string;

  /** `interrupt`: Ctrl+C with no join to withdraw; `programRunning` when no question was waiting. */
  constructor(private readonly options: WorkerSessionOptions, private readonly interrupt: (programRunning: boolean) => void = () => undefined) {
    this.node = options.node;
  }

  attach(term: WorkerTerminal): void {
    this.term = term;
  }

  /** The node's own name, once its status says it. */
  setNode(node: string): void {
    if (node === this.node) return;
    this.node = node;
    this.show();
  }

  private steps(finished = false): readonly WorkerStep[] | undefined {
    if (this.options.steps) return this.options.steps(this.section, finished);
    const list = this.options.sections === 'seen' ? this.seen : this.options.sections;
    if (!list || list.length === 0) return undefined;
    return list.map((label, i): WorkerStep => {
      const n = i + 1;
      const passed = this.section !== null && (n < this.section || (finished && n === this.section));
      const state = passed ? (this.troubled.has(n) ? 'left' : 'ready') : n === this.section ? 'active' : finished ? 'left' : 'pending';
      return { label, state };
    });
  }

  frame(extra: readonly WorkerDetail[] = [], finished = false): WorkerFrame {
    const steps = this.steps(finished);
    return {
      node: this.node,
      name: this.options.name,
      ...(steps ? { steps } : {}),
      title: this.title,
      details: [...extra, ...this.details],
      ...(this.status ? { status: this.status } : {}),
    };
  }

  private show(): void {
    this.term?.show(this.frame());
  }

  private operation(title: string): void {
    this.title = title;
    this.details = [];
    this.status = undefined;
  }

  /** One event of a flow, already placed (`nestedEvent` for a command inside configure). */
  take(event: DrawEvent): void {
    if (event.event === 'ask') return;
    if (event.event === 'end') {
      this.ended = event;
      return;
    }
    if (event.kind !== 'wait') this.status = undefined;
    switch (event.kind) {
      case 'heading':
        if (event.step === 0) {
          if (!COMMAND_TITLE.test(event.text)) this.operation(event.text);
        } else {
          this.section = event.step;
          if (this.options.sections === 'seen' && !this.seen.includes(event.text)) this.seen[event.step - 1] = event.text;
          this.operation(event.text);
        }
        break;
      case 'subheading':
        this.operation(event.text);
        break;
      case 'line':
        this.details.push({ kind: 'text', text: event.text });
        break;
      case 'wait':
        this.status = event.text.replace(/…$/, '');
        break;
      case 'done':
        this.details.push({ kind: 'outcome', label: event.text, state: 'ready' });
        break;
      case 'problem':
        if (this.section !== null) this.troubled.add(this.section);
        this.details.push({ kind: 'problem', text: event.text });
        break;
      case 'quote':
        this.details.push({ kind: 'literal', value: event.text });
        break;
      case 'code':
        this.details.push({ kind: 'literal', value: groupedCode(event.code) });
        break;
      case 'field':
        this.details.push({ kind: 'field', label: event.label, value: event.value, ...(event.note ? { note: event.note } : {}) });
        break;
    }
    this.show();
  }

  /** One question; null when it was canceled or the screen closed. */
  async ask(prompt: string, hint?: AskHint): Promise<string | null> {
    const term = this.term;
    if (!term || this.stopped) return null;
    const trust = trustOf(hint);
    // An approval shows what it does, where, why and the exact commands, ahead of what led to it.
    if (trust) term.show({ ...this.frame(), details: [trust, ...this.details.filter((d) => d.kind === 'problem' || d.kind === 'outcome')] });
    else this.show();
    this.pending = true;
    try {
      return answerText(await term.ask(workerPromptOf(`q${++this.asked}`, prompt, hint)), hint);
    } finally {
      this.pending = false;
      if (!this.stopped) this.show();
    }
  }

  /** A program that takes the keyboard (sudo, a provider's sign-in): the screen lets go, and comes back when it ends. */
  handoff<T>(notice: string, run: () => Promise<T>): Promise<T> {
    if (!this.term || this.stopped) return run();
    return this.term.handoff(notice, run);
  }

  /** The io a flow is given; `section`: drawn inside configure's section, as the plain transcript draws it. */
  io(section: JoinStep | null = null): WorkerIo {
    return {
      say: (event) => {
        const placed = section === null ? event : nestedEvent(event, section);
        if (placed) this.take(placed);
      },
      ask: (_step, prompt, hint) => this.ask(prompt, hint),
      ran: () => undefined,
      drawsChoices: true,
    };
  }

  /** A pairing code typed here. */
  static readonly CODE_HINT: AskHint = { kind: 'text', maxLength: NODE_ANSWER_MAX_CHARS, placeholder: '000 000' };

  /** While `stop` is set, Ctrl+C calls it (a join withdraws) instead of stopping the command. */
  onStop(stop: () => void): () => void {
    this.cancels.push(stop);
    return () => {
      const at = this.cancels.lastIndexOf(stop);
      if (at >= 0) this.cancels.splice(at, 1);
    };
  }

  /** Ctrl+C from the screen. The terminal releases itself (`close`) right after. */
  cancel(): void {
    this.stopped = true;
    const stop = this.cancels.at(-1);
    if (stop) return stop();
    // As Ctrl+C did before the screen: the command stops at once. With no question waiting a program may be running,
    // which Ctrl+C in a plain terminal would have stopped too.
    this.interrupt(!this.pending);
  }

  /** The closing frame: the outcome, what is left with its command, and the screen left above the prompt. */
  async finish(details?: readonly WorkerDetail[]): Promise<void> {
    if (!this.term) return;
    const end = this.ended;
    if (end) this.title = end.text;
    const closing: WorkerDetail[] = details ? [...details] : [...this.details];
    if (!details && end?.next) closing.push({ kind: 'field', label: 'Next', value: end.next });
    this.details = closing;
    this.status = undefined;
    await this.term.finish(this.frame([], true));
  }

  /** Releases the screen without a closing frame (stopped, or a failure before anything was asked). */
  async close(): Promise<void> {
    await this.term?.close();
  }
}
