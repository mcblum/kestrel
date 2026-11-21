// Messages the user sends into a running Claude turn (0.0.18): what the agent has read of them.
//
// What the SDK offers (@anthropic-ai/claude-agent-sdk 0.3.322, sdk.d.ts): in streaming-input mode the
// CLI reads its input continuously into a command queue. A user message written while a turn runs is
// folded into that turn between tool rounds, or, when the turn ends first, runs as the next turn of
// the same query without further input (`queued_turn_count` on the result says one follows). Each
// message may carry a `uuid`; the assistant frames and the result of the turn that took it in list
// it in `user_message_uuids` ("every user message whose prompt this turn has consumed so far ... then
// any user message folded into the turn"). That is how Kestrel knows a message was read. When the
// process ends (Stop closes it), what is still queued is gone: it never reaches the conversation the
// agent keeps, so it is reported `unread` and Kestrel holds it again. Pure: fed messages, it says what changed.
import { randomUUID } from 'node:crypto';
import type { SdkLike } from './map.ts';

/** The uuid a user message is sent with (the SDK's `UUID`). */
export type MessageUuid = ReturnType<typeof randomUUID>;

export class MidTurnInput {
  /** The SDK uuid of each message sent and not yet read, with Kestrel's id for it, in order. */
  private pending: { uuid: MessageUuid; id: string }[] = [];
  /** Turns the CLI said still follow (`queued_turn_count` of the latest result). */
  private queuedTurns = 0;

  /** A message goes in: the uuid to send it with. */
  sent(id: string): MessageUuid {
    const uuid = randomUUID();
    this.pending = [...this.pending, { uuid, id }];
    return uuid;
  }

  /** Kestrel's ids of the messages this SDK message says the agent has now read. */
  see(m: SdkLike): string[] {
    if (m.parent_tool_use_id) return [];
    if (m.type === 'result') this.queuedTurns = typeof m.queued_turn_count === 'number' ? m.queued_turn_count : 0;
    const uuids = consumed(m);
    // A CLI too old to echo uuids says nothing of what it read: from its result on, nothing is waited for.
    if (m.type === 'result' && uuids === null) return this.take(() => true, false);
    if (!uuids || uuids.length === 0) return [];
    const read = new Set(uuids);
    return this.take((p) => read.has(p.uuid), true);
  }

  /** Messages are still to be read, or the CLI said another turn follows: the run is not over. */
  get moreToCome(): boolean {
    return this.pending.length > 0 || this.queuedTurns > 0;
  }

  /** The run is over: Kestrel's ids of what was sent and never read. */
  unread(): string[] {
    const ids = this.pending.map((p) => p.id);
    this.pending = [];
    this.queuedTurns = 0;
    return ids;
  }

  /** Drops the pending messages that match; returns their ids when they count as read. */
  private take(match: (p: { uuid: MessageUuid; id: string }) => boolean, read: boolean): string[] {
    const taken = this.pending.filter(match);
    this.pending = this.pending.filter((p) => !match(p));
    return read ? taken.map((p) => p.id) : [];
  }
}

/** The uuids a frame says its turn has consumed; null when the frame cannot say (an older CLI's result). */
function consumed(m: SdkLike): string[] | null {
  if (Array.isArray(m.user_message_uuids)) return m.user_message_uuids.filter((u: unknown): u is string => typeof u === 'string');
  if (typeof m.user_message_uuid === 'string') return [m.user_message_uuid];
  return m.type === 'result' ? null : [];
}
