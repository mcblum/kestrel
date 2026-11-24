// Kestrel does not quit or restart with agents at work without asking first (Matt, 2026-11-24).
//
// Quitting the app stops the server and every agent it runs, so every way the app ends goes
// through `confirm` here: Quit from the menu, its shortcut and the Dock, closing the window, the
// updater's Restart, and the system asking at logout or shutdown. The shell keeps no count of its
// own: it asks the server `GET /api/quit-check` (server/src/shared/quit-check.ts, by the same
// status rule every view uses) each time.
//
//   - Nothing working: no dialog, quit as quickly as before.
//   - Something working: a native dialog names it (the first few titles, then "and N more"), says
//     what quitting does to it, and offers Cancel (default, and Escape) or Quit anyway. For an
//     update the choice is Install later or Restart anyway.
//   - "Working" is a turn under way, by the server's rule: an agent running, or a turn paused on the
//     agent's own card (an approval, a question, a plan), which a restart cuts off. A session whose
//     turn is done does not block and is not named, whatever card it left: the card is there after
//     a restart (Matt, 2026-11-24: "If the turn is done and there's a card, it'll be there when I
//     get back").
//   - The server does not answer within ASK_TIMEOUT_MS (crashed, hung): quit without asking.
//   - The system is logging out or shutting down: ask where the system lets an app wait (macOS,
//     Windows), and quit on our own after SYSTEM_ANSWER_MS without an answer, so a shutdown never
//     hangs on Kestrel. Linux gives an app about five seconds (logind's delay lock), too short to
//     answer anything: Kestrel quits cleanly without asking there.
//
// No Electron import, so all of this is tested (quit-guard.test.mjs); main.mjs wires it.

export const ASK_TIMEOUT_MS = 2_000;
export const SYSTEM_ANSWER_MS = 20_000;
export const NAMES_SHOWN = 3;

/** @typedef {'mac' | 'windows' | 'linux'} Platform */
/** @typedef {'quit' | 'update' | 'system'} QuitPurpose */
/** @typedef {{ id: string, title: string }} QuitSession */
/** @typedef {{ working: QuitSession[] }} QuitCheck */

/** Node's process.platform as one of the three (the server's `platformOf`, for the shell). */
export function shellPlatform(nodePlatform = process.platform) {
  if (nodePlatform === 'darwin') return 'mac';
  if (nodePlatform === 'win32') return 'windows';
  return 'linux';
}

/** Whether the system lets Kestrel ask before it ends the session, and why not where it does not. */
export function systemEnd(platform) {
  if (platform === 'linux') return { ask: false, reason: 'Linux gives an app about five seconds at logout or shutdown, too short to answer a question: Kestrel stops its agents cleanly and quits.' };
  return { ask: true, reason: null };
}

/** “A”; “A” and “B”; “A”, “B”, “C” and 2 more. */
export function namesText(titles, shown = NAMES_SHOWN) {
  const quoted = titles.map((t) => `“${t}”`);
  if (quoted.length <= 1) return quoted.join('');
  if (quoted.length <= shown) return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
  return `${quoted.slice(0, shown).join(', ')} and ${quoted.length - shown} more`;
}

const isSession = (x) => Boolean(x) && typeof x.id === 'string' && typeof x.title === 'string';

/** The server's answer, or null when it is not one (then the shell does not trust it and quits). */
export function parseQuitCheck(body) {
  if (!body || !Array.isArray(body.working) || !body.working.every(isSession)) return null;
  return { working: body.working };
}

/**
 * Asks the server what quitting would stop. Null when it cannot say in time: no server, an error,
 * an answer that is not one, or no answer within `timeoutMs`.
 */
export async function askServer({ port, token, fetch = globalThis.fetch, timeoutMs = ASK_TIMEOUT_MS }) {
  if (!port || !token) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/quit-check`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? parseQuitCheck(await res.json()) : null;
  } catch {
    return null;
  }
}

const sessionsWord = (n) => (n === 1 ? '1 session' : `${n} sessions`);

/** The headline: one session by name, more by count. */
function headline(working, purpose) {
  const who = working.length === 1 ? `“${working[0].title}” is` : `${sessionsWord(working.length)} are`;
  return purpose === 'update' ? `${who} still working. Restart to update now?` : `${who} still working. Quit Kestrel?`;
}

/**
 * The dialog for a quit, or null when nothing is working (quit without asking).
 * Buttons: [stay, go]; index 0 is the default and what Escape does.
 * @param {QuitCheck} check
 * @param {QuitPurpose} purpose
 */
export function quitDialog(check, purpose) {
  const { working } = check;
  if (working.length === 0) return null;
  const verb = purpose === 'update' ? 'Restarting' : 'Quitting';
  const detail = [];
  if (working.length > 1) detail.push(`Working: ${namesText(working.map((s) => s.title))}.`);
  detail.push(`${verb} stops ${working.length === 1 ? 'it' : 'them'} now: the turn is cut off where it is, any approval or question it is waiting on is closed, and the session shows Interrupted. Reply in it afterwards to carry on. Messages you queued are kept, waiting for you to send them.`);
  if (purpose === 'update') detail.push('Install later keeps the update: it is installed when you next quit Kestrel, and the update notice stays so you can restart when they are done.');
  if (purpose === 'system') detail.push(`Without an answer in ${SYSTEM_ANSWER_MS / 1000} seconds, Kestrel quits so the computer can log out or shut down.`);
  const buttons = purpose === 'update' ? ['Install later', 'Restart anyway'] : ['Cancel', 'Quit anyway'];
  return { type: 'warning', message: headline(working, purpose), detail: detail.join('\n\n'), buttons, defaultId: 0, cancelId: 0, noLink: true };
}

/**
 * What to do, given the server's answer (null: it did not answer) and why the app is ending.
 * @returns {{ action: 'go' } | { action: 'ask', dialog: object, timeoutMs: number | null }}
 */
export function quitDecision(check, purpose, platform) {
  if (check === null) return { action: 'go' };
  if (purpose === 'system' && !systemEnd(platform).ask) return { action: 'go' };
  const dialog = quitDialog(check, purpose);
  if (!dialog) return { action: 'go' };
  return { action: 'ask', dialog, timeoutMs: purpose === 'system' ? SYSTEM_ANSWER_MS : null };
}

/**
 * The one check every way of ending goes through. `ask()` asks the server (askServer);
 * `show(dialog, { timeoutMs })` shows it and resolves { response } or { timedOut: true }.
 * `confirm(purpose)` resolves true to go ahead. A second quit while a dialog is open waits for the
 * same answer rather than opening another.
 */
export function createQuitGuard({ ask, show, platform, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()) }) {
  let pending = null;
  const decide = async (purpose) => {
    const decision = quitDecision(await ask(), purpose, platform);
    if (decision.action === 'go') return true;
    const answer = await show(decision.dialog, { timeoutMs: decision.timeoutMs });
    // Unanswered at logout or shutdown: go, so the system is never held up by Kestrel.
    if (answer.timedOut) return true;
    return answer.response === 1;
  };
  return {
    confirm(purpose) {
      // The system ends the session while a quit dialog is already open: that dialog has no time
      // limit, so the system's own applies on top of it.
      if (pending && purpose === 'system') return Promise.race([pending, wait(SYSTEM_ANSWER_MS).then(() => true)]);
      pending ??= decide(purpose).finally(() => (pending = null));
      return pending;
    },
  };
}
