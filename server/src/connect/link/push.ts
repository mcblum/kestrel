// Push notifications, the desk's side (design doc kestrel-connect.md, sections 9 and 10; the contract is
// "Phase 6 as built"). The rule for what is news is the window's own (`notificationsOf` in
// shared/notifications.ts), run here in the server on every change of the workspace, the review requests
// and the tickets, so a phone is told with no window open. Each event is sealed under the account data key
// and handed to the service, which forwards the ciphertext to Apple.
//
// - It never blocks anything: a change only sets a timer; the look runs later, one at a time.
// - Nothing is news on the first look, so a restart sends nothing; what happens while the link is down
//   is seen and dropped, never queued.
// - Each phone's choices of kinds are sealed by the phone (`push-prefs`); none means every kind.
import { randomBytes } from 'node:crypto';
import type { ChatMessage, InputCard } from '../../model.ts';
import { DEFAULT_NOTIFY, NOTHING_SEEN, NOTIFY_KINDS, notificationsOf, type NotifyEvent, type NotifyKind, type NotifyNow, type NotifyPrefs, type NotifySeen } from '../../shared/notifications.ts';
import type { PullRequestStore } from '../../pull-requests/store.ts';
import type { ReviewRequestStore } from '../../review-requests/store.ts';
import type { TicketStore } from '../../tickets/store.ts';
import type { Workspace } from '../../workspace.ts';
import type { SessionRuntime } from '../../runtime.ts';
import type { ConnectPush } from '../../shared/connect.ts';
import { openRecord, sealRecord } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { PushApi } from './push-api.ts';

/** A look runs this long after the change that asked for it, so a burst of writes is one look. */
export const LOOK_MS = 250;
export const TITLE_MAX = 120;
export const BODY_MAX = 140;
/** What the service takes (APNs carries 4 KB). */
export const SEALED_MAX = 3000;
/** The service takes at most this many devices per push. */
const TO_MAX = 20;

/** The rule runs with every kind on: each phone's own choices are applied after. Banner and sound are the desk's and do not apply. */
const EVERY_KIND: NotifyPrefs = { ...DEFAULT_NOTIFY, enabled: true, banner: true, events: Object.fromEntries(NOTIFY_KINDS.map((kind) => [kind, true])) as Record<NotifyKind, boolean> };
/** The server does not know where the user is looking: a phone is told whatever the window shows. */
const AWAY = { focused: false, openSessionId: null } as const;

/** An approval the phone may answer from the banner (D6): exactly two options, one allow and one deny. */
export interface PushCard {
  sessionId: string;
  requestId: string;
  allow: string;
  deny: string;
}

/** What is sealed for the phone. */
export interface PushPayload {
  v: 1;
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  at: number;
  desk: { id: string; name: string };
  sessionId: string | null;
  requestKey: string | null;
  ticketKey: string | null;
  card: PushCard | null;
}

/** What of the server this reads, so a test can stand in for it. */
export interface PushSource {
  now(): Promise<NotifyNow>;
  /** The session's open approval when it is a plain two-option one; null otherwise. */
  card(sessionId: string): Promise<PushCard | null>;
  onChange(listener: () => void): () => void;
}

/** The open approval of a conversation, when it is a plain Allow / Deny. Pure. */
export function plainCard(sessionId: string, messages: readonly ChatMessage[]): PushCard | null {
  const open = [...messages].reverse().find((m) => m.input && !m.input.resolved)?.input;
  return open ? cardOf(sessionId, open) : null;
}

function cardOf(sessionId: string, input: InputCard): PushCard | null {
  if (input.kind !== 'approval' || input.options.length !== 2 || input.questions?.length) return null;
  const allow = input.options.find((o) => o.role === 'allow');
  const deny = input.options.find((o) => o.role === 'deny');
  return allow && deny ? { sessionId, requestId: input.id, allow: allow.id, deny: deny.id } : null;
}

export function pushSource(workspace: Workspace, runtime: SessionRuntime, reviewRequests: ReviewRequestStore | null, tickets: TicketStore | null, pullRequests: PullRequestStore | null = null): PushSource {
  return {
    async now() {
      const state = await workspace.state();
      return {
        sessions: state.sessions,
        links: state.links,
        pullRequests: new Map(Object.entries(pullRequests?.all() ?? {})),
        attention: await runtime.gitPrefs.attention(),
        reviewRequests: reviewRequests?.view() ?? { requests: [], unread: [] },
        tickets: tickets?.view() ?? { tickets: [], unread: [], sources: [], settings: { on: false, off: [], show: 'page' } },
        // A worker node's refused pushes (runtime/node-push.ts); none in the app.
        ...(runtime.nodePush ? { pushFailures: runtime.nodePush.failures() } : {}),
      };
    },
    async card(sessionId) {
      const messages = runtime.overlay(sessionId)?.messages ?? (await workspace.detail(sessionId))?.messages ?? [];
      return plainCard(sessionId, messages);
    },
    onChange(listener) {
      const offs = [workspace.onChange(listener), reviewRequests?.onChange(listener), tickets?.onChange(listener), pullRequests?.onChange(() => listener()), runtime.gitPrefs.onAttentionChange(() => listener()), runtime.nodePush?.onChange(listener)];
      return () => offs.forEach((off) => off?.());
    },
  };
}

export interface PushDeps {
  source: PushSource;
  /** The service, when the link is up; null otherwise. */
  api(): PushApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  desk(): { id: string; name: string } | null;
  changed(): void;
  now?(): number;
  lookMs?: number;
}

/** A phone and the kinds it wants. */
interface Phone {
  deviceId: string;
  name: string;
  events: Record<NotifyKind, boolean>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const pushId = () => randomBytes(16).toString('base64url');

/** A phone's sealed choices, opened; every kind on when there are none or they cannot be opened. */
export function phoneEvents(sealed: string | null, generation: number | null, deviceId: string, keyFor: (generation: number) => Buffer): Record<NotifyKind, boolean> {
  const all = { ...EVERY_KIND.events };
  if (!sealed || generation === null) return all;
  try {
    const value = openRecord(keyFor(generation), sealed, 'push-prefs', deviceId, generation) as { events?: Record<string, unknown> };
    const events = value?.events ?? {};
    return Object.fromEntries(NOTIFY_KINDS.map((kind) => [kind, events[kind] !== false])) as Record<NotifyKind, boolean>;
  } catch {
    return all;
  }
}

export class PushNotices {
  private seen: NotifySeen = NOTHING_SEEN;
  private phones: Phone[] | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private problem: string | null = null;
  private lastSentAt: number | null = null;
  private closed = false;
  private readonly off: () => void;

  constructor(private readonly deps: PushDeps) {
    // Cheap on purpose: this runs as the workspace broadcasts.
    this.off = deps.source.onChange(() => this.schedule());
    this.schedule();
  }

  view(): ConnectPush {
    return { phones: (this.phones ?? []).map((p) => p.name), problem: this.problem, lastSentAt: this.lastSentAt };
  }

  /** The link came up, or the service said a phone's token or choices changed: read the phones again. */
  async refreshPhones(): Promise<void> {
    const api = this.deps.api();
    if (!api || !this.deps.key()) return;
    try {
      const devices = await api.devices();
      this.phones = devices.filter((d) => d.hasToken).map((d) => ({ deviceId: d.deviceId, name: d.name, events: phoneEvents(d.prefs, d.generation, d.deviceId, (g) => this.deps.keyFor(g)) }));
      this.problem = null;
    } catch (error) {
      this.problem = `Kestrel Connect could not say which phones take notifications: ${message(error)}`;
    }
    this.deps.changed();
  }

  /** Runs any look that is due now, and waits for it (tests). */
  async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.look();
    }
    await this.running;
  }

  close(): void {
    this.closed = true;
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look();
    }, this.deps.lookMs ?? LOOK_MS);
    this.timer.unref?.();
  }

  private look(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.lookOnce().catch((error: unknown) => console.error(`[kestrel] the push look failed: ${message(error)}`));
      } while (this.again && !this.closed);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async lookOnce(): Promise<void> {
    const next = notificationsOf(this.seen, await this.deps.source.now(), EVERY_KIND, AWAY);
    this.seen = next.seen;
    if (next.events.length === 0) return;
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    // Seen and dropped while there is no one to send to: never queued.
    if (!api || !key || !desk) return;
    if (!this.phones) await this.refreshPhones();
    for (const event of next.events) await this.send(api, key, desk, event);
  }

  private async send(api: PushApi, key: ReadyKey, desk: { id: string; name: string }, event: NotifyEvent): Promise<void> {
    // A desk-only kind is never handed here (the source passes no set-up requests, and no requests to join, which the
    // service pushes to every phone itself); were one, it would not leave.
    const kind = event.kind;
    if (kind === 'setup-values' || kind === 'join-request') return;
    const to = (this.phones ?? []).filter((p) => p.events[kind]).map((p) => p.deviceId).slice(0, TO_MAX);
    if (to.length === 0) return;
    const id = pushId();
    const payload: PushPayload = {
      v: 1,
      id,
      kind,
      title: clip(event.title, TITLE_MAX),
      body: clip(event.body, BODY_MAX),
      at: this.deps.now?.() ?? Date.now(),
      desk,
      sessionId: event.sessionId || null,
      requestKey: event.requestKey ?? null,
      ticketKey: event.ticketKey ?? null,
      card: event.kind === 'needs-you' && event.sessionId ? await this.deps.source.card(event.sessionId) : null,
    };
    const body = sealRecord(key.adk, 'push', id, key.generation, payload);
    if (body.length > SEALED_MAX) return void console.error('[kestrel] a notification was too long to push and was not sent.');
    try {
      const answer = await api.send({ id, generation: key.generation, to, body });
      this.lastSentAt = payload.at;
      this.problem = answer.skipped.length > 0 && answer.sent.length === 0 ? 'Kestrel Connect could not deliver the last notification to any phone. Open Kestrel on the phone so it can register again.' : null;
    } catch (error) {
      this.problem = `The last notification was not sent: ${message(error)}`;
    }
    this.deps.changed();
  }
}
