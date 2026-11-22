// The per-session live channel: streaming agent output goes only to sockets that are watching
// that session, in bursts of at most one message per interval, never through the workspace state.
import type { WebSocket } from 'ws';
import type { LivePatch } from './model.ts';

/** How long live output is gathered before it is sent: at most one patch per session per this many ms. */
export const LIVE_FLUSH_MS = 40;

/** Merge two patches: the newer message replaces an older one with the same id. */
export function mergePatch(a: LivePatch, b: LivePatch): LivePatch {
  const messages = [...(a.messages ?? [])];
  for (const m of b.messages ?? []) {
    const i = messages.findIndex((x) => x.id !== undefined && x.id === m.id);
    if (i >= 0) messages[i] = m;
    else messages.push(m);
  }
  return { ...a, ...b, ...(messages.length ? { messages } : {}) };
}

export class LiveChannel {
  private readonly watching = new Map<WebSocket, Set<string>>();
  private readonly pending = new Map<string, LivePatch>();
  private timer: NodeJS.Timeout | null = null;

  watch(ws: WebSocket, sessionId: string): void {
    const set = this.watching.get(ws) ?? new Set<string>();
    set.add(sessionId);
    this.watching.set(ws, set);
  }

  unwatch(ws: WebSocket, sessionId: string): void {
    this.watching.get(ws)?.delete(sessionId);
  }

  /** Some window has this session open. */
  isWatched(sessionId: string): boolean {
    for (const set of this.watching.values()) if (set.has(sessionId)) return true;
    return false;
  }

  forget(ws: WebSocket): void {
    this.watching.delete(ws);
  }

  /** Send one patch right away to one socket (the snapshot when it starts watching). */
  sendTo(ws: WebSocket, sessionId: string, patch: LivePatch): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'live', sessionId, patch }));
  }

  publish(sessionId: string, patch: LivePatch): void {
    if (!this.isWatched(sessionId)) return;
    this.pending.set(sessionId, mergePatch(this.pending.get(sessionId) ?? {}, patch));
    this.timer ??= setTimeout(() => this.flush(), LIVE_FLUSH_MS);
  }

  private flush(): void {
    this.timer = null;
    for (const [sessionId, patch] of this.pending) {
      const json = JSON.stringify({ type: 'live', sessionId, patch });
      for (const [ws, ids] of this.watching) if (ids.has(sessionId) && ws.readyState === ws.OPEN) ws.send(json);
    }
    this.pending.clear();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
