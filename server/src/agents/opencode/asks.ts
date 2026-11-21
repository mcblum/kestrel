// OpenCode's asks for one session: permission asks (answered by the edit rule, the level, or a card)
// and the agent's questions (a card). Holds the cards waiting on the user and replies to OpenCode
// when they are answered, dropped (a stop) or refused by a rule. Asks from the session's
// sub-agents come here too: they follow the same level.
import type { CardQuestion } from '../../model.ts';
import { sandboxBounds } from '../claude/sandbox.ts';
import type { SandboxOffer } from '../../shared/sandbox-allow.ts';
import type { AgentEvent, InputAnswer, InputRequest, StartOptions } from '../types.ts';
import { call, type OpencodeClient } from './client.ts';
import { opencodeToolNames } from './config.ts';
import { askedPaths, decide, readAsk, type Ask, type Reply } from './decide.ts';
import type { OpencodeMapper } from './map.ts';
import { opencodePolicy } from './policy.ts';
import { kestrelCall } from './tools.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const STOPPED = 'The user stopped the turn.';

export interface AskDeps {
  client(): OpencodeClient | null;
  opts(): StartOptions;
  mapper(): OpencodeMapper | null;
  emit(event: AgentEvent): void;
  log(message: string): void;
}

interface Card {
  answer(answer: InputAnswer): Promise<void>;
  /** What a stop or a dead process does with it. */
  drop(): Promise<void>;
}

/** An OpenCode question (`question.asked`) as the card's questions. */
export function cardQuestions(questions: unknown): CardQuestion[] {
  return (Array.isArray(questions) ? questions : []).filter(isObj).map((q) => ({
    question: str(q.question),
    ...(str(q.header) ? { header: str(q.header) } : {}),
    multi: q.multiple === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o) => ({ label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}) })),
  }));
}

/** The answers OpenCode takes (one list of labels per question, in order) from the card's answer. */
export function questionAnswers(questions: readonly CardQuestion[], answer: InputAnswer): string[][] {
  const only = questions.length === 1 ? questions[0]! : null;
  return questions.map((q) => {
    const given = answer.answers?.[q.question];
    if (given !== undefined) return q.multi ? given.split(/,\s*/).filter(Boolean) : [given].filter(Boolean);
    if (q !== only) return [];
    const picked = only.options[Number(answer.optionId)]?.label ?? answer.text?.trim() ?? '';
    return picked ? [picked] : [];
  });
}

export class AskDesk {
  private readonly cards = new Map<string, Card>();
  private seq = 0;

  constructor(private readonly deps: AskDeps) {}

  pending(): number {
    return this.cards.size;
  }

  answer(requestId: string, answer: InputAnswer): void {
    const card = this.cards.get(requestId);
    if (!card) throw new Error('That question is no longer waiting for an answer.');
    this.cards.delete(requestId);
    void card.answer(answer).catch((error) => this.deps.log(`could not answer OpenCode: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Every waiting card is withdrawn: its ask is refused, its question dismissed. */
  async dropAll(): Promise<void> {
    const cards = [...this.cards.values()];
    this.cards.clear();
    await Promise.all(cards.map((c) => c.drop().catch(() => undefined)));
  }

  /** Forget the cards of a process that ended: they can no longer be answered. */
  forget(): void {
    this.cards.clear();
  }

  private async reply(ask: Ask, answer: Reply): Promise<void> {
    const client = this.deps.client();
    if (!client) return;
    await call('take the answer', client.permission.reply({ requestID: ask.id, ...answer }));
  }

  /** The edit rule's (or another rule's) reason to refuse the call an ask is about; null when none. */
  private async ruleRefusal(ask: Ask, mapper: OpencodeMapper): Promise<string | null> {
    const opts = this.deps.opts();
    const call = ask.callID ? mapper.calls.get(ask.callID) : undefined;
    const actions =
      ask.permission === 'edit'
        ? askedPaths(ask, call, opts.directory, mapper.root).map((path) => ({ tool: 'Edit', input: { file_path: path } }))
        : call
          ? [kestrelCall(call.tool, call.input)].map((c) => ({ tool: c.name, input: c.input }))
          : [];
    for (const action of actions) {
      const verdict = await opts.intercept?.(action).catch(() => undefined);
      if (verdict && !verdict.allow) return opencodeToolNames(verdict.message);
    }
    return null;
  }

  private async offerFor(ask: Ask, mapper: OpencodeMapper): Promise<SandboxOffer | null> {
    const opts = this.deps.opts();
    const call = ask.callID ? mapper.calls.get(ask.callID) : undefined;
    if (ask.permission !== 'external_directory' || call?.tool !== 'bash' || !opts.sandboxAllow) return null;
    const bounds = sandboxBounds({ directory: opts.directory, permission: 'auto', confineShell: true, sandboxAllow: opts.sandboxAllow });
    return opts.sandboxAllow.offer(str(call.input.command), bounds).catch(() => null);
  }

  /** A `permission.asked` for this session or one of its sub-agents. */
  async onPermission(properties: Obj): Promise<void> {
    const ask = readAsk(properties);
    const mapper = this.deps.mapper();
    if (!ask || !mapper) return;
    const refusal = await this.ruleRefusal(ask, mapper);
    if (refusal) {
      for (const event of ask.callID ? mapper.refuse(ask.callID, refusal) : []) this.deps.emit(event);
      return this.reply(ask, { reply: 'reject', message: refusal });
    }
    const opts = this.deps.opts();
    const call = ask.callID ? mapper.calls.get(ask.callID) : undefined;
    const ctx = { policy: opencodePolicy(opts.permission), directory: opts.directory, root: mapper.root, confined: opts.confineShell === true, readable: opts.readableDirectories ?? [], sandboxAllow: opts.sandboxAllow, element: opts.browserElement };
    const decision = decide(ask, call, ctx, await this.offerFor(ask, mapper));
    if (decision.kind === 'reply') return this.reply(ask, decision.answer);
    const id = `opencode-${++this.seq}`;
    this.cards.set(id, { answer: (answer) => this.reply(ask, decision.reply(answer)), drop: () => this.reply(ask, { reply: 'reject', message: STOPPED }) });
    this.deps.emit({ type: 'needs-input', request: { id, ...decision.request } });
  }

  /** A `question.asked`: the agent asks the user something with choices. */
  onQuestion(properties: Obj): void {
    const requestID = str(properties.id);
    const questions = cardQuestions(properties.questions);
    if (!requestID || questions.length === 0) return;
    const only = questions.length === 1 ? questions[0]! : null;
    const id = `opencode-${++this.seq}`;
    const request: InputRequest = {
      id,
      kind: 'question',
      tool: 'AskUserQuestion',
      title: 'OpenCode is asking you',
      detail: questions[0]!.question,
      questions,
      options: (only?.options ?? []).map((o, i) => ({ id: String(i), label: o.label, role: 'choice' as const })),
    };
    const client = () => this.deps.client();
    this.cards.set(id, {
      answer: async (answer) => void (await client()?.question.reply({ requestID, answers: questionAnswers(questions, answer) })),
      drop: async () => void (await client()?.question.reject({ requestID })),
    });
    this.deps.emit({ type: 'needs-input', request });
  }
}
