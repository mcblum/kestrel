// The input side of a Claude query that stays open: user messages are pushed in as they are sent and
// the query reads them in order (the SDK's streaming-input mode, `query({ prompt: AsyncIterable })`).
// Closing it tells the SDK no more messages are coming, so the agent's process ends once its run is
// over. A message is pushed as a promise (its content is built asynchronously) and read in push order.

export class InputChannel<T> implements AsyncIterable<T> {
  private readonly items: Promise<T>[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  /** Hand the query one more message. Ignored once closed. */
  push(item: T | Promise<T>): void {
    if (this.closed) return;
    this.items.push(Promise.resolve(item));
    this.notify();
  }

  /** No more messages: the query's reading ends after the ones already pushed. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield await next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
