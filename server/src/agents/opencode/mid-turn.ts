// Messages sent into a running OpenCode turn (`sendNow`): what the model has read of them.
//
// What OpenCode does (opencode 1.14.25, tried with spike/opencode-note.ts; docs/spike-results.md): a
// `session.promptAsync` while the session is busy adds a user message to it, and the running loop
// takes it in at its next step, within the same run: one `session.idle` at the end. The SDK has no
// uuid to send it with, so the user messages OpenCode makes are matched to Kestrel's in the order they
// were sent, after the turn's own prompt. The model has read one once an assistant message names it as
// its `parentID` (each step's assistant message points at the newest user message it answers). Pure:
// fed OpenCode's events, it says what changed.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class OpencodeMidTurn {
  /** Kestrel's ids of messages sent and not yet seen as OpenCode user messages, in order. */
  private pending: string[] = [];
  /** OpenCode's user message id → Kestrel's id, for messages it made and the model has not read. */
  private readonly given = new Map<string, string>();
  /** OpenCode user message ids seen in this turn (the turn's own prompt is the first). */
  private readonly users = new Set<string>();

  /** A turn starts: what is left from the last one is forgotten (it was reported `unread`). */
  beginTurn(): void {
    this.pending = [];
    this.given.clear();
    this.users.clear();
  }

  /** The turn's own prompt is in: messages sent from now on are matched after it. */
  get promptSeen(): boolean {
    return this.users.size > 0;
  }

  /** A message goes in. */
  sent(id: string): void {
    this.pending = [...this.pending, id];
  }

  /** A message OpenCode refused: it is not waited for. */
  dropped(id: string): void {
    this.pending = this.pending.filter((p) => p !== id);
  }

  /** Kestrel's ids of the messages this event says the model has now read. */
  see(event: Obj): string[] {
    if (event.type !== 'message.updated') return [];
    const info = isObj(event.properties) && isObj(event.properties.info) ? event.properties.info : null;
    if (!info) return [];
    const id = str(info.id);
    if (info.role === 'user') {
      if (!id || this.users.has(id)) return [];
      const first = this.users.size === 0;
      this.users.add(id);
      const ours = first ? undefined : this.pending[0];
      if (ours !== undefined) {
        this.pending = this.pending.slice(1);
        this.given.set(id, ours);
      }
      return [];
    }
    if (info.role !== 'assistant') return [];
    const read = this.given.get(str(info.parentID));
    if (read === undefined) return [];
    // A step answering a later message has read the earlier ones too.
    const ids: string[] = [];
    for (const [userId, kestrelId] of this.given) {
      ids.push(kestrelId);
      this.given.delete(userId);
      if (kestrelId === read) break;
    }
    return ids;
  }

  /** Messages still to be read. */
  get waiting(): boolean {
    return this.pending.length > 0 || this.given.size > 0;
  }

  /** The turn is over: Kestrel's ids of what was sent and never read. */
  unread(): string[] {
    const ids = [...this.given.values(), ...this.pending];
    this.beginTurn();
    return ids;
  }
}
