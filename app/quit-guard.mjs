// Kestrel does not quit or restart with agents at work without asking first (Matt, 2026-11-24).
//
// Quitting the app stops the server and every agent it runs, so every way the app ends goes
// through `confirm` here: Quit from the menu, its shortcut and the Dock, closing the window, the
// updater's Restart, and the system asking at logout or shutdown. The shell keeps no count of its
// own: it asks the server `GET /api/quit-check` (server/src/shared/quit-check.ts, by the same
// status rule every view uses) each time.
//
//   - Nothing working or waiting: no dialog, quit as quickly as before.
//   - Something working: a native dialog names it (the first few titles, then "and N more"), says
//     what quitting does to it, and offers Cancel (default, and Escape) or Quit anyway. For an
//     update the choice is Install later or Restart anyway.
//   - "Working" is a turn under way, by the server's rule: an agent running, or a turn paused on the
//     agent's own card (an approval, a question, a plan), which a restart cuts off.
//   - "Waiting" is a session whose turn is done with one of Kestrel's own cards open that a restart
//     would close: such cards normally have their step stored and survive a restart, so only one
//     raised by an older Kestrel (no step stored) or one whose answer is being carried out right now
//     counts. It asks too, said apart from the working ones (Matt, 2026-11-24: "Yes, block for now").
//   - Any other card a finished turn left survives a restart: it does not block and is not named
//     ("If the turn is done and there's a card, it'll be there when I get back").
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
/** @typedef {{ working: QuitSession[], waiting: QuitSession[] }} QuitCheck */

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
  // An older server says nothing of waiting sessions: none, then.
  const waiting = body.waiting === undefined ? [] : body.waiting;
  if (!Array.isArray(waiting) || !waiting.every(isSession)) return null;
  return { working: body.working, waiting };
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
const isAre = (n) => (n === 1 ? 'is' : 'are');
const titles = (sessions) => namesText(sessions.map((s) => s.title));

/** The headline: one session by name, more by count; working and waiting said apart. */
function headline({ working, waiting }, purpose) {
  const ask = purpose === 'update' ? 'Restart to update now?' : 'Quit Kestrel?';
  const one = working.length + waiting.length === 1 ? (working[0] ?? waiting[0]).title : null;
  if (working.length && waiting.length) return `${sessionsWord(working.length)} ${isAre(working.length)} working and ${waiting.length} ${isAre(waiting.length)} waiting for your answer. ${ask}`;
  if (working.length) return `${one ? `“${one}” is` : `${sessionsWord(working.length)} are`} still working. ${ask}`;
  return `${one ? `“${one}” is` : `${sessionsWord(waiting.length)} are`} waiting for your answer. ${ask}`;
}

/**
 * The dialog for a quit, or null when nothing would be stopped or lost (quit without asking).
 * Buttons: [stay, go]; index 0 is the default and what Escape does.
 * @param {QuitCheck} check
 * @param {QuitPurpose} purpose
 */
export function quitDialog(check, purpose) {
  const { working, waiting = [] } = check;
  if (working.length === 0 && waiting.length === 0) return null;
  const restart = purpose === 'update';
  const detail = [];
  if (working.length > 0) {
    detail.push(`${sessionsWord(working.length)} ${isAre(working.length)} working and will be stopped: ${titles(working)}.`);
    detail.push(`The turn is cut off where it is, any approval or question it is waiting on is closed, and the session shows Interrupted. Reply in it afterwards to carry on. Messages you queued are kept, waiting for you to send them.`);
  }
  if (waiting.length > 0) {
    detail.push(`${sessionsWord(waiting.length)} ${isAre(waiting.length)} waiting for your answer on a card that ${restart ? 'a restart' : 'quitting'} will close: ${titles(waiting)}.`);
    detail.push(`Answer ${waiting.length === 1 ? 'it' : 'them'} first to keep what ${waiting.length === 1 ? 'it asks' : 'they ask'}. Otherwise the card closes unanswered and the session shows Interrupted; reply in it afterwards and the agent is told the card went unanswered.`);
  }
  if (restart) detail.push('Install later keeps the update: it is installed when you next quit Kestrel, and the update notice stays so you can restart when they are done.');
  if (purpose === 'system') detail.push(`Without an answer in ${SYSTEM_ANSWER_MS / 1000} seconds, Kestrel quits so the computer can log out or shut down.`);
  const buttons = restart ? ['Install later', 'Restart anyway'] : ['Cancel', 'Quit anyway'];
  return { type: 'warning', message: headline({ working, waiting }, purpose), detail: detail.join('\n\n'), buttons, defaultId: 0, cancelId: 0, noLink: true };
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
