// Desktop notifications and sounds (0.0.20, matt/kestrel#17): when a session finishes, fails or
// needs an answer, the user is told even with Kestrel in the background. Which of the three, a
// banner or not, and which sound are settings. Pure and browser-safe: what to say and when, from
// two pushes of the workspace; showing the banner and playing the sound is the UI's
// (ui/src/notifier.ts). Status words come from shared/status.ts, as everywhere.
import type { Link, SessionView } from '../model.ts';
import { statusOf, type StatusKey } from './status.ts';

export type NotifyKind = 'done' | 'failed' | 'needs-you';
export const NOTIFY_KINDS: readonly NotifyKind[] = ['needs-you', 'failed', 'done'];
export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = { 'needs-you': 'A session needs your answer', failed: 'A session fails', done: 'A session finishes' };

export const SOUNDS = ['none', 'chime', 'ping', 'pop'] as const;
export type SoundId = (typeof SOUNDS)[number];
export const SOUND_LABEL: Record<SoundId, string> = { none: 'No sound', chime: 'Chime', ping: 'Ping', pop: 'Pop' };

export interface NotifyPrefs {
  /** Show a desktop banner. */
  banner: boolean;
  /** Played with each notification, banner or not. */
  sound: SoundId;
  /** Which events tell the user anything at all. */
  events: Record<NotifyKind, boolean>;
}

/** On for all three, with no sound: silence is the least surprising default, a missed approval the most costly. */
export const DEFAULT_NOTIFY: NotifyPrefs = { banner: true, sound: 'none', events: { 'needs-you': true, failed: true, done: true } };

const isSound = (value: unknown): value is SoundId => (SOUNDS as readonly unknown[]).includes(value);

/** Why these cannot be the notification settings, or null when they can. `value` is what a client sent. */
export function notifyProblem(value: unknown): string | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const events = (typeof v.events === 'object' && v.events !== null ? v.events : null) as Record<string, unknown> | null;
  if (typeof v.banner !== 'boolean') return 'banner must be true or false.';
  if (!isSound(v.sound)) return `sound must be one of: ${SOUNDS.join(', ')}.`;
  if (!events || NOTIFY_KINDS.some((kind) => typeof events[kind] !== 'boolean')) return `events must say true or false for each of: ${NOTIFY_KINDS.join(', ')}.`;
  return null;
}

/** Stored settings as read back: anything unreadable is the default for that part. */
export function sanitizeNotify(value: unknown): NotifyPrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const events = (typeof v.events === 'object' && v.events !== null ? v.events : {}) as Record<string, unknown>;
  const event = (kind: NotifyKind): boolean => (typeof events[kind] === 'boolean' ? (events[kind] as boolean) : DEFAULT_NOTIFY.events[kind]);
  return { banner: typeof v.banner === 'boolean' ? v.banner : DEFAULT_NOTIFY.banner, sound: isSound(v.sound) ? v.sound : DEFAULT_NOTIFY.sound, events: { 'needs-you': event('needs-you'), failed: event('failed'), done: event('done') } };
}

export interface NotifyEvent {
  kind: NotifyKind;
  sessionId: string;
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
function kindOf(before: StatusKey, after: StatusKey): NotifyKind | null {
  if (before === after) return null;
  if (after === 'needs-you') return 'needs-you';
  if (before !== 'working') return null;
  if (after === 'failed') return 'failed';
  return after === 'done' || after === 'review' ? 'done' : null; // stopped by the user, or interrupted: they know
}

const NOTE_MAX = 140;
const clip = (text: string): string => (text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text);

function bodyOf(kind: NotifyKind, session: Notified): string {
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
  if (!before || before === after) return [];
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

/**
 * Why the desktop app could not show a banner, in words the user can act on. `reason` is what the
 * system said (macOS: "UNErrorDomain error 1" when the app is not allowed to notify). `packaged`:
 * an installed copy; a copy run from a checkout is not signed, and macOS shows notifications only
 * from a signed app, so there is nothing to allow.
 */
export function bannerProblem(reason: string, packaged: boolean): string {
  if (reason === 'unsupported') return 'This computer cannot show notifications; a sound still plays.';
  if (!packaged) return 'macOS shows notifications only from a signed app, and this copy of Kestrel is run from a checkout, which is not signed. The installed app can show them. A sound still plays.';
  if (/UNErrorDomain error 1\b|not allowed/i.test(reason)) return 'macOS is not letting Kestrel show notifications. Allow them in System Settings → Notifications → Kestrel, then send a test.';
  return `macOS did not show the notification (${reason.slice(0, 120)}). Check System Settings → Notifications → Kestrel.`;
}

/** Whether anything at all is on: with no banner and no sound there is nothing to do. */
export const notifies = (prefs: NotifyPrefs): boolean => (prefs.banner || prefs.sound !== 'none') && NOTIFY_KINDS.some((kind) => prefs.events[kind]);
