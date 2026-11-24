// Tells the user when a session finishes, fails or needs an answer (server:
// shared/notifications.ts, which decides what and in what words): a desktop banner and a sound.
// In the desktop app the banner is shown by the shell (app/main.mjs), which says when the system
// refused it: macOS shows notifications only from a signed app the user has allowed, and the
// page's own Notification fails there without a word. In a browser it is the browser's own.
// It watches the one copy of the workspace in the app store and holds nothing of its own but the
// previous list to compare with. A click on a banner brings the window forward and opens the session.
import { platform } from './platform.ts';
import { useSyncExternalStore } from 'react';
import { bannerProblem, DEFAULT_NOTIFY, NOTHING_SEEN, sanitizeNotify, notifies, notificationsOf, parseTarget, targetOf, type NotifyEvent, type NotifyPrefs, type NotifySeen } from '@kestrel/server/notifications';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { openSession, openView } from './route.ts';
import { playSound } from './sounds.ts';
import { appStore, call, putResource } from './store.ts';
import { activeTab, tabsView } from './tabsStore.ts';

export const NOTIFICATIONS_PATH = '/api/notifications';
export type NotifyAnswer = { prefs: NotifyPrefs };
/** Read through `sanitizeNotify`, so a part an older server does not send yet is its default (a missing `enabled` is on), never "off". */
export const asNotifyPrefs = (raw: unknown): Sourced<NotifyPrefs> => ready(sanitizeNotify((raw as NotifyAnswer | null)?.prefs ?? DEFAULT_NOTIFY));

/** Whether this window may show banners: 'unsupported' where the browser has no notifications at all. */
export type BannerPermission = NotificationPermission | 'unsupported';
export const bannerPermission = (): BannerPermission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** Ask the browser to allow banners (the desktop app never needs to). Must follow a click. */
export const askForBanners = async (): Promise<BannerPermission> => (typeof Notification === 'undefined' ? 'unsupported' : Notification.requestPermission());

/** The settings as held in the store; the defaults until the server's have arrived. */
function heldPrefs(): NotifyPrefs {
  const held = appStore.get().resources.get(NOTIFICATIONS_PATH) as Sourced<NotifyPrefs> | undefined;
  return held?.state === 'ready' ? held.value : DEFAULT_NOTIFY;
}

// ---- whether the last banner was shown -------------------------------------------------------
// Why the system refused the last banner the desktop app tried to show, in words; null when it
// showed (or none was tried). What Settings → Notifications says under the banner switch.
let problem: string | null = null;
const problemListeners = new Set<() => void>();
function setProblem(next: string | null): void {
  if (next === problem) return;
  problem = next;
  for (const listener of problemListeners) listener();
}
export const useBannerProblem = (): string | null => useSyncExternalStore((listener) => (problemListeners.add(listener), () => void problemListeners.delete(listener)), () => problem);

/** The desktop app shows banners itself; a browser needs the page's own Notification and its permission. */
export const shellShowsBanners = (): boolean => typeof window.kestrelShell?.notify === 'function';

/** Show one banner through the desktop app. True when the system showed it; a refusal is kept as the problem to say. */
async function shellBanner(notification: { title: string; body: string; sessionId: string }): Promise<boolean> {
  const answer = await window.kestrelShell!.notify!(notification).catch((error: unknown) => ({ ok: false, reason: String(error) }));
  setProblem(answer.ok ? null : bannerProblem(answer.reason ?? '', window.kestrelShell?.app?.packaged === true, platform()));
  return answer.ok;
}

/** Settings → Notifications → Send a test: a banner now, so the user sees it work, or reads why it does not. */
export async function sendTestBanner(): Promise<'shown' | 'refused' | 'blocked'> {
  const text = { title: 'Kestrel', body: 'This is what a notification from Kestrel looks like.', sessionId: '' };
  if (shellShowsBanners()) return (await shellBanner(text)) ? 'shown' : 'refused';
  if (bannerPermission() !== 'granted') return 'blocked';
  new Notification(text.title, { body: text.body, tag: 'kestrel-test', silent: true });
  return 'shown';
}

/** Open what a banner was about: the session, or the review request's page. */
function openTarget(target: string): void {
  const named = parseTarget(target);
  if (!named) return;
  if ('requestKey' in named) openView({ kind: 'review-request', id: named.requestKey });
  else if ('ticketKey' in named) openView({ kind: 'ticket', id: named.ticketKey });
  else openSession(named.sessionId);
}

function show(event: NotifyEvent, prefs: NotifyPrefs): void {
  if (!prefs.banner) return;
  // The shell hands back what it was given as `sessionId` when the banner is clicked: the target.
  if (shellShowsBanners()) return void shellBanner({ title: event.title, body: event.body, sessionId: targetOf(event) });
  if (bannerPermission() === 'granted') {
    // `tag`: a second window, or a second event for the session, replaces the banner instead of stacking. Silent: the sound is Kestrel's own.
    const banner = new Notification(event.title, { body: event.body, tag: `kestrel-${targetOf(event)}`, silent: true });
    banner.onclick = () => {
      window.focus();
      openTarget(targetOf(event));
      banner.close();
    };
  }
}

/** What the last look saw (shared/notifications.ts); nothing until the server's first push, so what was already there is never news. */
let seen: { rule: NotifySeen; sessions: unknown; reviewRequests: unknown; tickets: unknown } = { rule: NOTHING_SEEN, sessions: null, reviewRequests: null, tickets: null };
let asked = false;

function check(): void {
  const state = appStore.get();
  const ws = state.workspace;
  if (!ws) return;
  // The settings are asked for once, when the server is first there; the page that edits them writes the same entry.
  if (!asked) {
    asked = true;
    void call<NotifyAnswer>(NOTIFICATIONS_PATH).then((answer) => putResource(NOTIFICATIONS_PATH, asNotifyPrefs(answer)), () => void (asked = false));
  }
  if (seen.sessions === ws.sessions && seen.reviewRequests === state.reviewRequests && seen.tickets === state.tickets) return;
  const prefs = heldPrefs();
  const tab = tabsView().loaded ? activeTab(tabsView()) : undefined;
  // The one rule, which the desk's push sender also runs (server/src/connect/link/push.ts).
  const next = notificationsOf(seen.rule, { sessions: ws.sessions, links: ws.links, reviewRequests: state.reviewRequests, tickets: state.tickets }, prefs, { focused: document.hasFocus(), openSessionId: tab?.kind === 'session' ? tab.sessionId : null });
  seen = { rule: next.seen, sessions: ws.sessions, reviewRequests: state.reviewRequests, tickets: state.tickets };
  if (!notifies(prefs) || next.events.length === 0) return;
  next.events.forEach((event) => show(event, prefs));
  playSound(prefs.sound); // once, however many things changed in this push
}

/** Start watching. Called once, as the app starts. */
export function installNotifier(): void {
  // A click on a banner the desktop app showed: the shell has brought the window forward.
  window.kestrelShell?.onNotificationClick?.((target) => openTarget(target));
  appStore.subscribe(check);
  check();
}
