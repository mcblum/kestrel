// Desktop notifications and sounds (0.0.20, matt/kestrel#17): when a session finishes, fails or
// needs an answer, (0.0.23) the user is asked to review a pull request, or (tickets) a ticket is
// newly assigned to them, they are told even
// with Kestrel in the background. Which of those, a
// banner or not, and which sound are settings. Pure and browser-safe: what to say and when, from
// two pushes of the workspace; showing the banner and playing the sound is the UI's
// (ui/src/notifier.ts). Status words come from shared/status.ts, as everywhere.
import type { Link, SessionView } from '../model.ts';
import { PLATFORM_NAME, type Platform } from './platform.ts';
import type { ReviewRequestsView } from './review-requests.ts';
import { statusOf, type StatusKey } from './status.ts';
import { ticketsOn, type TicketsView } from './tickets.ts';

export type NotifyKind = 'done' | 'failed' | 'needs-you' | 'review-request' | 'ticket';
export const NOTIFY_KINDS: readonly NotifyKind[] = ['needs-you', 'failed', 'done', 'review-request', 'ticket'];
/** Each reads on from the list's heading, "Tell me when", so they say "my", never "your" (Matt, 2026-11-21). */
export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = { 'needs-you': 'A session needs my input', failed: 'A session fails', done: 'A session finishes', 'review-request': 'I’m asked to review a pull request', ticket: 'A ticket is assigned to me' };

export const SOUNDS = ['none', 'chime', 'ping', 'pop'] as const;
export type SoundId = (typeof SOUNDS)[number];
export const SOUND_LABEL: Record<SoundId, string> = { none: 'No sound', chime: 'Chime', ping: 'Ping', pop: 'Pop' };

export interface NotifyPrefs {
  /** The top-level choice (0.0.23): false is "never tell me", whatever the rest says; the rest is kept for when it is turned back on. */
  enabled: boolean;
  /** Show a desktop banner. */
  banner: boolean;
  /** Played with each notification, banner or not. */
  sound: SoundId;
  /** Which events tell the user anything at all. */
  events: Record<NotifyKind, boolean>;
}

/** On for all of them, with no sound: silence is the least surprising default, a missed approval the most costly. */
export const DEFAULT_NOTIFY: NotifyPrefs = { enabled: true, banner: true, sound: 'none', events: { 'needs-you': true, failed: true, done: true, 'review-request': true, ticket: true } };

const isSound = (value: unknown): value is SoundId => (SOUNDS as readonly unknown[]).includes(value);

/** Why these cannot be the notification settings, or null when they can. `value` is what a client sent. */
export function notifyProblem(value: unknown): string | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const events = (typeof v.events === 'object' && v.events !== null ? v.events : null) as Record<string, unknown> | null;
  // Absent means on: settings saved before 0.0.23 have no word about it.
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return 'enabled must be true or false.';
  if (typeof v.banner !== 'boolean') return 'banner must be true or false.';
  if (!isSound(v.sound)) return `sound must be one of: ${SOUNDS.join(', ')}.`;
  // `ticket` came later: a client that does not know it yet leaves it as it was (absent reads as on).
  if (!events || NOTIFY_KINDS.some((kind) => typeof events[kind] !== 'boolean' && !(kind === 'ticket' && events[kind] === undefined))) return `events must say true or false for each of: ${NOTIFY_KINDS.join(', ')}.`;
  return null;
}

/** Stored settings as read back: anything unreadable is the default for that part. */
export function sanitizeNotify(value: unknown): NotifyPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const events = (typeof v.events === 'object' && v.events !== null ? v.events : {}) as Record<string, unknown>;
  const event = (kind: NotifyKind): boolean => (typeof events[kind] === 'boolean' ? (events[kind] as boolean) : DEFAULT_NOTIFY.events[kind]);
  return { enabled: v.enabled !== false, banner: typeof v.banner === 'boolean' ? v.banner : DEFAULT_NOTIFY.banner, sound: isSound(v.sound) ? v.sound : DEFAULT_NOTIFY.sound, events: { 'needs-you': event('needs-you'), failed: event('failed'), done: event('done'), 'review-request': event('review-request'), ticket: event('ticket') } };
}

export interface NotifyEvent {
  kind: NotifyKind;
  /** The session it is about; '' for a review request, which has `requestKey` instead. */
  sessionId: string;
  /** The review request it is about (its key in the store): a click opens that request's page. */
  requestKey?: string;
  /** The ticket it is about (its key): a click opens the ticket's page. */
  ticketKey?: string;
  /** The banner's first line: the session's title. */
  title: string;
  /** Its second line: what happened, in the status vocabulary, with the session's own note where it says more. */
  body: string;
}

/** What the user is looking at, so they are not told about what is in front of them. */
export interface Looking {
  /** The window has the focus. */
  focused: boolean;
  /** The session in the tab in front; null when it is a page. */
  openSessionId: string | null;
}

type Notified = Pick<SessionView, 'id' | 'title' | 'state' | 'note'> & Partial<Pick<SessionView, 'request' | 'stopped'>>;

/** The event a change of status is, if it is one worth telling: only a session that was working can finish or fail. */
function kindOf(before: StatusKey, after: StatusKey): Exclude<NotifyKind, 'review-request'> | null {
  if (before === after) return null;
  if (after === 'needs-you') return 'needs-you';
  if (before !== 'working') return null;
  if (after === 'failed') return 'failed';
  return after === 'done' || after === 'review' ? 'done' : null; // stopped by the user, or interrupted: they know
}

const NOTE_MAX = 140;
const clip = (text: string): string => (text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text);

function bodyOf(kind: Exclude<NotifyKind, 'review-request'>, session: Notified): string {
  if (kind === 'done') return statusOf(session) === 'review' ? 'Finished. Its pull request is ready to review.' : 'Finished.';
  // The note already reads "Needs you · …" or "Failed · …" (runtime/events.ts).
  return clip(session.note || (kind === 'failed' ? 'Failed.' : 'Needs your answer.'));
}

/**
 * What to tell the user about, from one push of the workspace to the next. Nothing on the first
 * push (`before` null), for a session that is new in `after`, for the session in front of a
 * focused window, or for an event switched off. A session a delegate started that finishes is its
 * orchestrator's news, not the user's; one that fails or needs an answer still is the user's.
 */
export function notifyEvents(before: readonly Notified[] | null, after: readonly Notified[], links: readonly Pick<Link, 'childId' | 'kind'>[], prefs: NotifyPrefs, looking: Looking): NotifyEvent[] {
  if (!before || before === after || !prefs.enabled) return [];
  const was = new Map(before.map((s) => [s.id, s]));
  const delegated = new Set(links.filter((l) => l.kind === 'delegate').map((l) => l.childId));
  const events: NotifyEvent[] = [];
  for (const session of after) {
    const old = was.get(session.id);
    if (!old || old === session) continue;
    const kind = kindOf(statusOf(old), statusOf(session));
    if (!kind || !prefs.events[kind]) continue;
    if (kind === 'done' && delegated.has(session.id)) continue;
    if (looking.focused && looking.openSessionId === session.id) continue;
    events.push({ kind, sessionId: session.id, title: session.title, body: bodyOf(kind, session) });
  }
  return events;
}

/** Where a request is, as the sidebar says it: the repository's own name and the number. */
const requestPlace = (request: { repository: string; number: number }): string => `${request.repository.split('/').at(-1) ?? request.repository} #${request.number}`;

/**
 * The review requests to tell the user about, from one push of them to the next: each request
 * that was not waiting before, is waiting now, and is still unread. Nothing on the first push
 * (`before` null: what was already waiting when Kestrel opened is not news), for one the user
 * dismissed (it is not in `requests`), or with the event switched off. `before` is the keys that
 * were waiting. The banner names who asked when the host says, and where the request is.
 */
export function reviewNotifyEvents(before: readonly string[] | null, after: Pick<ReviewRequestsView, 'requests' | 'unread'>, prefs: NotifyPrefs): NotifyEvent[] {
  if (!before || !prefs.enabled || !prefs.events['review-request']) return [];
  const was = new Set(before);
  const unread = new Set(after.unread);
  return after.requests
    .filter((request) => !was.has(request.key) && unread.has(request.key))
    .map((request) => ({
      kind: 'review-request' as const,
      sessionId: '',
      requestKey: request.key,
      title: request.title || requestPlace(request),
      body: `${request.requestedBy ? `${request.requestedBy} asked you to review` : 'You were asked to review'} ${requestPlace(request)}.`,
    }));
}

/** What the ticket notifier remembers from one push of tickets to the next. */
export interface TicketsSeenBefore {
  /** The keys listed. */
  keys: readonly string[];
  /** The sources asked: a source new since then is being filled for the first time, and that is not news. */
  sources: readonly string[];
}

/** The keys and sources of a tickets view, to compare the next push with. Pure. */
export const ticketsBefore = (view: Pick<TicketsView, 'tickets' | 'sources'>): TicketsSeenBefore => ({ keys: view.tickets.map((t) => t.key), sources: view.sources });

/**
 * The tickets to tell the user about, from one push of them to the next: each listed now that was
 * not before, is unread, and came from a source that was already being asked. So nothing on the
 * first push (`before` null), nothing for the tickets already there when tickets or a source are first
 * turned on (the source was not in `before.sources`), nothing while tickets or the source are off
 * (they list nothing), nothing for a dismissed ticket (it is not listed), and nothing with the event
 * switched off. Each ticket once: once listed, it is in `before`.
 */
export function ticketNotifyEvents(before: TicketsSeenBefore | null, after: Pick<TicketsView, 'tickets' | 'unread' | 'sources' | 'settings'>, prefs: NotifyPrefs): NotifyEvent[] {
  if (!before || !prefs.enabled || !prefs.events.ticket || !ticketsOn(after)) return [];
  const was = new Set(before.keys);
  const asked = new Set(before.sources);
  const unread = new Set(after.unread);
  return after.tickets
    .filter((t) => !was.has(t.key) && unread.has(t.key) && asked.has(t.source))
    .map((t) => ({ kind: 'ticket' as const, sessionId: '', ticketKey: t.key, title: `${t.ref}: ${t.title}`, body: `Assigned to you in ${t.tracker}${t.sprint?.current ? `, in ${t.sprint.name}` : ''}.` }));
}

/** A banner's click target as the desktop shell carries it back: a session's id, or a review request's key behind this mark. */
export const REVIEW_TARGET = 'review:';
export const TICKET_TARGET = 'ticket:';
export const targetOf = (event: Pick<NotifyEvent, 'sessionId' | 'requestKey' | 'ticketKey'>): string => (event.requestKey ? `${REVIEW_TARGET}${event.requestKey}` : event.ticketKey ? `${TICKET_TARGET}${event.ticketKey}` : event.sessionId);
/** What a target names: `{ requestKey }`, `{ ticketKey }`, `{ sessionId }`, or null for none (a test banner). */
export function parseTarget(target: string): { requestKey: string } | { ticketKey: string } | { sessionId: string } | null {
  if (!target) return null;
  if (target.startsWith(REVIEW_TARGET)) return { requestKey: target.slice(REVIEW_TARGET.length) };
  if (target.startsWith(TICKET_TARGET)) return { ticketKey: target.slice(TICKET_TARGET.length) };
  return { sessionId: target };
}

/**
 * Why the desktop app could not show a banner, in words the user can act on. `reason` is what the
 * system said (macOS: "UNErrorDomain error 1" when the app is not allowed to notify). `packaged`:
 * an installed copy; a copy run from a checkout is not signed, and macOS shows notifications only
 * from a signed app, so there is nothing to allow.
 */
export function bannerProblem(reason: string, packaged: boolean, platform: Platform = 'mac'): string {
  if (reason === 'unsupported') return 'This computer cannot show notifications; a sound still plays.';
  // Windows and Linux have no signing rule and no one settings page to point at.
  if (platform !== 'mac') return `${PLATFORM_NAME[platform]} did not show the notification (${reason.slice(0, 120)}). Check that notifications are allowed for Kestrel in the system's settings. A sound still plays.`;
  if (!packaged) return 'macOS shows notifications only from a signed app, and this copy of Kestrel is run from a checkout, which is not signed. The installed app can show them. A sound still plays.';
  if (/UNErrorDomain error 1\b|not allowed/i.test(reason)) return 'macOS is not letting Kestrel show notifications. Allow them in System Settings → Notifications → Kestrel, then send a test.';
  return `macOS did not show the notification (${reason.slice(0, 120)}). Check System Settings → Notifications → Kestrel.`;
}

/** Whether anything at all is on: with no banner and no sound there is nothing to do. */
export const notifies = (prefs: NotifyPrefs): boolean => prefs.enabled && tellsSomehow(prefs) && NOTIFY_KINDS.some((kind) => prefs.events[kind]);

/** Whether there is any way left to tell the user: a banner or a sound. With neither, the events chosen do nothing, and the settings page says so. */
export const tellsSomehow = (prefs: Pick<NotifyPrefs, 'banner' | 'sound'>): boolean => prefs.banner || prefs.sound !== 'none';

/** What the settings page says when the user will be told nothing though notifications are on; null when something will tell them. */
export function silentReason(prefs: NotifyPrefs): string | null {
  if (!prefs.enabled) return null;
  if (!tellsSomehow(prefs)) return 'Nothing will tell you: turn on the desktop notification or pick a sound.';
  return NOTIFY_KINDS.some((kind) => prefs.events[kind]) ? null : 'Nothing is ticked, so you will not be told about anything.';
}
