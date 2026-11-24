// A scripted agent for tests: no model, no timers. Each turn runs `script`, which may call the
// session's Kestrel tools (options.tools) like a real agent would, then ends the turn.
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import type { AgentAdapter, AgentAttachment, AgentEvent, AgentHandle, MidTurnMessage, StartOptions } from './agents/types.ts';

export interface Turn {
  options: StartOptions;
  /** The message this turn answers (the first prompt, or a reply, or news from another session). */
  text: string;
  /** Files attached to this turn's message(s). */
  attachments: readonly AgentAttachment[];
  /** 1 for the first turn of a conversation. */
  n: number;
  emit: (event: AgentEvent) => void;
  /** Ends the turn normally. A script that returns without calling this finishes by itself. */
  done: () => void;
  /** Messages sent into this turn while it ran (`sendNow`), in order. */
  midTurn: MidTurnMessage[];
  /** The agent says it read these mid-turn messages (all of them when none are named). */
  pickUp: (...ids: string[]) => void;
}

/**
 * Whether the fake takes messages mid-turn: `absent` has no `sendNow` at all (an adapter written
 * before 0.0.18), `accept` takes each while a turn runs, `refuse` has it but always says not now.
 */
export type MidTurnMode = 'absent' | 'accept' | 'refuse';

/** The text of the turn a fake compaction runs, so a script can tell it from a message. */
export const COMPACTION = '(compaction)';

export class FakeAgents {
  starts: { options: StartOptions; prompt: string; handle: AgentHandle }[] = [];
  resumes: { id: string; options: StartOptions }[] = [];
  /** Conversations copied by `fork`, and where. */
  forks: { id: string; from: string; to: string; forkedId: string }[] = [];
  /** Set to make the next `fork` fail with this reason (the agent could not copy it). */
  forkFailure: string | null = null;
  turns: Turn[] = [];
  /** What the agent does in a turn. Default: finish at once. */
  script: (turn: Turn) => void | Promise<void> = () => undefined;
  /** By default every turn ends when its script returns. Set to keep turns running. */
  hold = false;
  /** How handles made from now on take messages mid-turn. */
  midTurn: MidTurnMode = 'absent';
  /** Whether handles made from now on can compact (`AgentHandle.compact`); a compaction runs as a turn whose text is `COMPACTION`. */
  canCompact = true;
  /** The conversations compacted, by agent session id. */
  compactions: string[] = [];
  private running = new Set<Promise<void>>();
  private counter = 0;

  private handle(options: StartOptions, emit: (e: AgentEvent) => void, id: string, startTurns: number): AgentHandle {
    let busy = false;
    let n = startTurns;
    let current: Turn | null = null;
    /** Mid-turn messages of the running turn the agent has not read: like Claude, it lists them as unread when its run ends. */
    let unreadIds: string[] = [];
    const end = (event: AgentEvent) => {
      if (unreadIds.length > 0) emit({ type: 'unread', ids: unreadIds });
      unreadIds = [];
      busy = false;
      current = null;
      emit(event);
    };
    const handle: AgentHandle = {
      agentSessionId: () => id,
      busy: () => busy,
      send: (text, attachments = []) => {
        busy = true;
        const finish = (event: AgentEvent) => (event.type === 'done' || event.type === 'failed' ? end(event) : emit(event));
        const pickUp = (...ids: string[]) => {
          const read = ids.length > 0 ? ids : [...unreadIds];
          unreadIds = unreadIds.filter((u) => !read.includes(u));
          emit({ type: 'picked-up', ids: read });
        };
        const turn: Turn = { options, text, attachments, n: ++n, emit: finish, done: () => finish({ type: 'done', reason: 'complete' }), midTurn: [], pickUp };
        current = turn;
        this.turns.push(turn);
        const run = Promise.resolve()
          .then(() => this.script(turn))
          .then(() => (!this.hold && busy ? turn.done() : undefined))
          .catch((error) => finish({ type: 'failed', reason: String(error), kind: 'other' }))
          .finally(() => this.running.delete(run));
        this.running.add(run);
      },
      answer: () => undefined,
      stop: async () => {
        if (busy) end({ type: 'done', reason: 'stopped' });
      },
    };
    if (this.canCompact) {
      handle.compact = () => {
        if (busy) throw new Error('The agent is still working on the previous message.');
        this.compactions.push(id);
        handle.send(COMPACTION);
      };
    }
    if (this.midTurn === 'absent') return handle;
    const mode = this.midTurn;
    return {
      ...handle,
      sendNow: async (message) => {
        if (mode === 'refuse' || !busy || !current) return false;
        current.midTurn.push(message);
        unreadIds = [...unreadIds, message.id];
        return true;
      },
    };
  }

  adapter(): AgentAdapter {
    return {
      agent: 'claude',
      models: async () => ({ models: [{ id: '', label: 'Default' }], fromSdk: false }),
      start: (options, prompt, emit, attachments) => {
        const id = `agent-${++this.counter}`;
        emit({ type: 'started', agentSessionId: id, model: 'fake', kestrelTools: 'connected', missing: [] });
        const handle = this.handle(options, emit, id, 0);
        this.starts.push({ options, prompt, handle });
        handle.send(prompt, attachments);
        return handle;
      },
      resume: (id, options, emit) => {
        this.resumes.push({ id, options });
        return this.handle(options, emit, id, 1);
      },
      // Like Codex and OpenCode: nothing to say of an idle conversation; a script reports it with a `context` event.
      contextUsage: async () => null,
      fork: async (id, where) => {
        if (this.forkFailure) throw new Error(this.forkFailure);
        const forkedId = `${id}-fork-${++this.counter}`;
        this.forks.push({ id, ...where, forkedId });
        return forkedId;
      },
    };
  }

  /** Waits (in event-loop turns, not time) until every running script has finished. */
  async settled(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await tick();
      if (this.running.size === 0) return;
      await Promise.all([...this.running]);
    }
    throw new Error('scripts did not settle');
  }
}

/** Wait until `check` is true (git subprocesses need real time, so this polls). The generous cap
 *  only turns a hang into a failure; nothing asserts how long it took. */
export async function until(check: () => boolean | Promise<boolean>, what = 'condition'): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error(`never became true: ${what}`);
}
