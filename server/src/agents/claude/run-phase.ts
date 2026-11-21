// Where one Claude run stands, read from the SDK's messages. A run is one `query()` with its input
// kept open: it starts with a user message and lasts until the agent is done talking and nothing it
// left running in the background is alive. In between, the agent can be
//
//   busy        generating, or running a tool in the foreground: a new message goes into the turn
//               (mid-turn.ts); the run stays open until every one of them has been read
//   background  finished what it was saying, with background work (a dev server, a watcher) still
//               alive: the turn is over for the user, and a new message goes into this same run
//   over        the run is ending: no more input is taken; the process ends once its last turn does
//
// The end of a turn is read from the model's own stream (a main-thread message that stopped for any
// reason but a tool call), from the turn's `result`, or from `session_state_changed` 'idle' (sent
// when CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS is on). What that means depends on what is alive:
//   - nothing in the background: the run is over;
//   - background work alive: the turn is over, the run is not. The process lives as long as that
//     work does, so the input stays open and the next message goes into this run.
// Seen live on SDK 0.3.322 (2026-11-18): with a command left in the background the CLI sends the
// result and 'idle' at once, and then does not exit until the command does. Reading that 'idle'
// as "over" closed the input while the process lived on, and every message was queued until the
// background command ended. An older CLI held the result back instead; both are handled.
// What is alive is the CLI's list (`background_tasks_changed`) or, when that says less, the
// backgrounded shell calls that have not ended (background-calls.ts): a resumed CLI did not list a
// re-run command before its turn ended (2026-11-19), and the run was read as over.
// Pure: fed messages, it says what changed.
import type { SdkLike } from './map.ts';
import { BackgroundCalls } from './background-calls.ts';

export type Phase = 'busy' | 'background' | 'over';

/** What a message changed: the agent went quiet on background work, woke on its own, or the run is ending. */
export type PhaseChange = 'background' | 'working' | 'over';

/** The model stopped to run a tool: it goes on once the tool answers. */
const TOOL_STOP = 'tool_use';

export class RunPhase {
  private phase: Phase = 'busy';
  /** A main-thread message is being generated. */
  private talking = false;
  /** The model's latest main-thread message ended its turn (it stopped for something other than a tool). */
  private finishedTalking = false;
  /** A user message went in and nothing has answered it yet. */
  private awaitingReply = true;
  private resultSeen = false;
  /** The CLI said the session is idle: the turn is over (background work may still be alive). */
  private sessionIdle = false;
  /** A turn failed: the run ends whatever is still running. */
  private failed = false;
  /** Live background work, ambient watchers left out (helpers count: the turn waits on them too). */
  private background = 0;
  /** Background commands known from the calls themselves, for when the list is late or missing (background-calls.ts). */
  private readonly calls = new BackgroundCalls();

  get current(): Phase {
    return this.phase;
  }

  /** A user message went into the run: the agent is busy with it. */
  delivered(): void {
    if (this.phase === 'over') return;
    this.phase = 'busy';
    this.awaitingReply = true;
    this.finishedTalking = false;
    this.resultSeen = false;
    this.sessionIdle = false;
  }

  /**
   * Read one SDK message; returns what it changed, if anything. `moreInput`: messages sent into the
   * run are still unread, or the CLI said another turn follows (mid-turn.ts): a turn's end then is
   * not the run's, and the next turn comes without further input.
   */
  see(m: SdkLike, moreInput = false): PhaseChange | null {
    if (this.phase === 'over') return null;
    if (m.parent_tool_use_id) return null; // a helper's own conversation says nothing about the main one
    this.calls.see(m);
    if (m.type === 'stream_event' && m.event?.type === 'message_start') return this.startedTalking();
    if (m.type === 'stream_event' && m.event?.type === 'message_delta') this.stopped(m.event.delta?.stop_reason);
    else if (m.type === 'stream_event' && m.event?.type === 'message_stop') this.talking = false;
    else if (m.type === 'assistant') this.answered(m.message?.stop_reason);
    else if (m.type === 'system' && m.subtype === 'background_tasks_changed') this.background = liveCount(m.tasks);
    else if (m.type === 'system' && m.subtype === 'session_state_changed') this.sessionIdle = m.state === 'idle';
    else if (m.type === 'result') this.resulted(m);
    return this.settle(moreInput);
  }

  /** The model began a message. In the background phase that is the agent waking on its own (a task finished). */
  private startedTalking(): PhaseChange | null {
    this.talking = true;
    this.finishedTalking = false;
    this.awaitingReply = false;
    this.sessionIdle = false;
    if (this.phase !== 'background') return null;
    this.phase = 'busy';
    return 'working';
  }

  private stopped(reason: unknown): void {
    if (typeof reason !== 'string') return;
    this.talking = false;
    this.finishedTalking = reason !== TOOL_STOP;
  }

  /** A whole assistant message: something answered. Its stop reason, when it carries one, is read as the stream's. */
  private answered(reason: unknown): void {
    this.awaitingReply = false;
    this.stopped(reason);
  }

  private resulted(m: SdkLike): void {
    this.resultSeen = true;
    this.awaitingReply = false;
    this.talking = false;
    // A failed turn ends the run whatever is still running: there is nothing to come back to.
    if (m.subtype !== 'success' || m.is_error) this.failed = true;
  }

  /** Work alive: the CLI's list, or the backgrounded calls not yet ended when the list says less. */
  private alive(): number {
    return Math.max(this.background, this.calls.count);
  }

  private settle(moreInput: boolean): PhaseChange | null {
    const quiet = !this.talking && !this.awaitingReply;
    const alive = this.alive();
    const turnOver = this.sessionIdle || (this.resultSeen && quiet);
    if (!this.failed && turnOver && moreInput) {
      // A message sent mid-turn was not read in it: the CLI runs it as the next turn of this run.
      this.delivered();
      return null;
    }
    if (this.failed || (turnOver && alive === 0)) {
      this.phase = 'over';
      return 'over';
    }
    if (turnOver) {
      // The turn is over and work it left is alive: the run stays open. The signals are used up, so
      // the work ending later does not close the run on its own: the CLI may wake the agent then,
      // and if it does not, the run simply stays quiet and takes the next message.
      this.sessionIdle = false;
      this.resultSeen = false;
      return this.goQuiet();
    }
    if (quiet && this.finishedTalking && alive > 0) return this.goQuiet();
    return null;
  }

  /** Quiet on background work: said once, when the run was busy. */
  private goQuiet(): PhaseChange | null {
    if (this.phase !== 'busy') return null;
    this.phase = 'background';
    return 'background';
  }
}

/** How many tasks in a `background_tasks_changed` list are real work (not ambient watchers). */
function liveCount(tasks: unknown): number {
  return Array.isArray(tasks) ? tasks.filter((t) => (t as { ambient?: unknown })?.ambient !== true).length : 0;
}
